import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { readRegularFileText } from "./regular-file";
import { syncPublicError } from "./sync-http";
import { parseSyncVersion, syncCounter, syncId, syncTime } from "./sync-validation";
import { readSyncFile } from "./sync-files";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { acquireSyncLock } from "./sync-lock";
import { decryptSyncSecret, encryptSyncSecret, generateSyncKey, type EncryptedSecret } from "./sync-crypto";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  getSyncAgentDir,
  getSyncPlatform,
  syncConfigPath,
  syncKeyPath,
  resolveSyncFilePath,
} from "./sync-scope";

export type SyncConflictStrategy = "mtime" | "authority";
export type SyncNodeStatus = "unknown" | "online" | "offline" | "error";

export interface SyncNode {
  id: string;
  name: string;
  url?: string;
  direction: "outbound" | "inbound";
  connectionId: string;
  platform: "windows" | "macos" | "linux" | "other";
  enabled: boolean;
  status: SyncNodeStatus;
  lastSeenAt?: string;
  lastSyncAt?: string;
  lastError?: string;
  /** The password is intentionally not part of the public type. */
  credential?: EncryptedSecret;
}

export interface SyncConfig {
  version: 1;
  node: {
    id: string;
    name: string;
    platform: "windows" | "macos" | "linux" | "other";
  };
  enabled: boolean;
  conflictStrategy: SyncConflictStrategy;
  authorityNodeId?: string;
  policyUpdatedAt: string;
  policySourceNodeId: string;
  /** Lamport-style millisecond clock, advanced when a local change is observed. */
  clock: number;
  waitingForAuthority?: boolean;
  lastDecision?: { sourceNodeId: string; at: string; strategy: SyncConflictStrategy; applied: number };
  nodes: SyncNode[];
  files: Record<string, SyncFileVersion>;
  snapshotRevision: number;
  receivedSnapshots: Record<string, number>;
  /** Write-ahead record: recovery compares actual bytes, not an assumption of success. */
  pendingWrites?: Array<{ path: string; version: SyncFileVersion }>;
}

export interface SyncFileVersion {
  hash?: string;
  size?: number;
  mtimeMs: number;
  updatedAt: string;
  sourceNodeId: string;
  deleted?: boolean;
  revision?: number;
}

export interface PublicSyncNode extends Omit<SyncNode, "credential"> {
  hasCredential: boolean;
}

interface StoredSyncKey {
  version: 1;
  key: string;
}

const MAX_SYNC_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_SYNC_NODES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) throw new Error("Synchronization metadata must not be a symbolic link");
  const text = (readRegularFileText(path, MAX_SYNC_METADATA_BYTES) ?? "").replace(/^\uFEFF/, "");
  if (!text.trim()) return null;
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error("Invalid local synchronization JSON; repair it before retrying"); }
}

function readKey(agentDir: string): Buffer {
  const path = syncKeyPath(agentDir);
  if (existsSync(path)) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error("Sync key must not be a symbolic link");
      const parsed = readJson(path);
      if (isRecord(parsed) && parsed.version === 1 && typeof parsed.key === "string") {
        const key = Buffer.from(parsed.key, "base64url");
        if (key.length === 32) return key;
      }
    } catch (error) {
      throw new Error(`Cannot read local sync key: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw new Error("Invalid local sync key");
  }
  if (existsSync(syncConfigPath(agentDir))) {
    throw new Error("Local sync key is missing; existing remote credentials cannot be decrypted");
  }
  const key = generateSyncKey();
  mkdirSync(dirname(path), { recursive: true });
  try {
    // wx makes first-use initialization safe when two Pi Web processes start
    // against the same agent directory at once.
    writeFileSync(path, `${JSON.stringify({ version: 1, key: key.toString("base64url") } satisfies StoredSyncKey)}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (lstatSync(path).isSymbolicLink()) throw new Error("Sync key must not be a symbolic link");
    const parsed = readJson(path);
    if (isRecord(parsed) && parsed.version === 1 && typeof parsed.key === "string") {
      const existing = Buffer.from(parsed.key, "base64url");
      if (existing.length === 32) return existing;
    }
    throw new Error("Invalid local sync key");
  }
}

function defaultConfig(): SyncConfig {
  const id = randomUUID();
  return {
    version: 1,
    node: {
      id,
      name: hostname() || "Pi Web",
      platform: getSyncPlatform(),
    },
    enabled: false,
    conflictStrategy: "mtime",
    policyUpdatedAt: "1970-01-01T00:00:00.000Z",
    policySourceNodeId: id,
    clock: 0,
    nodes: [],
    files: {},
    snapshotRevision: 0,
    receivedSnapshots: {},
  };
}

function parseConfig(value: unknown, agentDir: string): SyncConfig {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.node) || !Array.isArray(value.nodes)) {
    throw new Error("Invalid sync.json: expected a version 1 configuration");
  }
  const node = value.node;
  if (!syncId(node.id) || typeof node.name !== "string" || !node.name.trim() || node.name.length > 100
    || !["windows", "macos", "linux", "other"].includes(node.platform as string) || value.nodes.length > MAX_SYNC_NODES) {
    throw new Error("Invalid sync.json: invalid local node");
  }
  if (value.conflictStrategy !== "mtime" && value.conflictStrategy !== "authority") {
    throw new Error("Invalid sync.json: invalid conflict strategy");
  }
  const nodes = value.nodes.map((raw): SyncNode => {
    if (!isRecord(raw) || !syncId(raw.id) || raw.id === node.id || typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 100
      || (raw.direction !== undefined && raw.direction !== "outbound" && raw.direction !== "inbound")
      || (raw.connectionId !== undefined && !syncId(raw.connectionId))) {
      throw new Error("Invalid sync.json: invalid remote node");
    }
    const direction = raw.direction === "inbound" ? "inbound" : "outbound";
    let url: string | undefined;
    let credential: EncryptedSecret | undefined;
    if (direction === "outbound") {
      if (typeof raw.url !== "string" || !isRecord(raw.credential) || raw.credential.version !== 1
        || typeof raw.credential.iv !== "string" || raw.credential.iv.length > 24
        || typeof raw.credential.tag !== "string" || raw.credential.tag.length > 32
        || typeof raw.credential.ciphertext !== "string" || raw.credential.ciphertext.length > 24_000) throw new Error("Invalid outbound sync node");
      try { url = normalizeNodeUrl(raw.url); } catch { throw new Error("Invalid sync.json: remote node URL must be an HTTPS origin"); }
      credential = { version: 1, iv: raw.credential.iv, tag: raw.credential.tag, ciphertext: raw.credential.ciphertext };
    }
    if (!["windows", "macos", "linux", "other"].includes(raw.platform as string)) {
      throw new Error("Invalid sync.json: invalid remote node platform");
    }
    return {
      id: raw.id,
      name: raw.name,
      url, direction, connectionId: typeof raw.connectionId === "string" ? raw.connectionId : raw.id,
      platform: raw.platform as SyncNode["platform"],
      enabled: raw.enabled !== false,
      status: raw.status === "online" || raw.status === "offline" || raw.status === "error" ? raw.status : "unknown",
      ...(typeof raw.lastSeenAt === "string" ? { lastSeenAt: raw.lastSeenAt } : {}),
      ...(typeof raw.lastSyncAt === "string" ? { lastSyncAt: raw.lastSyncAt } : {}),
      ...(typeof raw.lastError === "string" ? { lastError: raw.lastError.slice(0, 500) } : {}),
      credential,
    };
  });
  if (new Set(nodes.map((peer) => peer.id)).size !== nodes.length || new Set(nodes.filter((peer) => peer.url).map((peer) => peer.url)).size !== nodes.filter((peer) => peer.url).length) throw new Error("Invalid duplicate synchronization nodes");
  const authorityNodeId = syncId(value.authorityNodeId) ? value.authorityNodeId : undefined;
  if (value.conflictStrategy === "authority" && !authorityNodeId) {
    throw new Error("Invalid sync.json: authority node is not configured");
  }
  if (!syncId(node.id) || !syncTime(value.policyUpdatedAt) || !syncId(value.policySourceNodeId)
    || !syncCounter(value.clock) || !syncCounter(value.snapshotRevision ?? 0)) throw new Error("Invalid synchronization metadata");
  const files: Record<string, SyncFileVersion> = {};
  if (!isRecord(value.files) || Object.keys(value.files).length > 5000) throw new Error("Invalid synchronization ledger");
  for (const [path, version] of Object.entries(value.files)) {
    // Lexical validation only here: a replaced link is reported by the scan,
    // not silently discarded from the ledger.
    if (!resolveSyncFilePath(path, agentDir, false)) throw new Error("Invalid synchronization ledger path");
    files[path] = parseSyncVersion(version);
  }
  const receivedSnapshots: Record<string, number> = {};
  if (value.receivedSnapshots !== undefined) {
    if (!isRecord(value.receivedSnapshots) || Object.keys(value.receivedSnapshots).length > 1000) throw new Error("Invalid synchronization ledger");
    for (const [id, revision] of Object.entries(value.receivedSnapshots)) {
      if (!syncId(id) || !syncCounter(revision)) throw new Error("Invalid synchronization ledger");
      Object.defineProperty(receivedSnapshots, id, { value: revision, enumerable: true, writable: true, configurable: true });
    }
  }
  let pendingWrites: SyncConfig["pendingWrites"];
  if (value.pendingWrites !== undefined) {
    if (!Array.isArray(value.pendingWrites) || value.pendingWrites.length > 5000) throw new Error("Invalid synchronization journal");
    pendingWrites = value.pendingWrites.map((entry) => {
      if (!isRecord(entry) || typeof entry.path !== "string" || !resolveSyncFilePath(entry.path, agentDir, false)) throw new Error("Invalid synchronization journal");
      return { path: entry.path, version: parseSyncVersion(entry.version) };
    });
  }
  return {
    version: 1,
    node: { id: node.id, name: node.name, platform: node.platform as SyncConfig["node"]["platform"] },
    enabled: value.enabled === true,
    conflictStrategy: value.conflictStrategy,
    ...(authorityNodeId ? { authorityNodeId } : {}),
    nodes,
    files,
    snapshotRevision: (value.snapshotRevision ?? 0) as number,
    receivedSnapshots,
    pendingWrites,
    policyUpdatedAt: typeof value.policyUpdatedAt === "string" && Number.isFinite(Date.parse(value.policyUpdatedAt))
      ? value.policyUpdatedAt : "1970-01-01T00:00:00.000Z",
    policySourceNodeId: typeof value.policySourceNodeId === "string" ? value.policySourceNodeId : node.id,
    clock: typeof value.clock === "number" && Number.isSafeInteger(value.clock) && value.clock >= 0 ? value.clock : 0,
    waitingForAuthority: value.waitingForAuthority === true,
    ...(isRecord(value.lastDecision) && syncId(value.lastDecision.sourceNodeId) && syncTime(value.lastDecision.at)
      && (value.lastDecision.strategy === "mtime" || value.lastDecision.strategy === "authority") && syncCounter(value.lastDecision.applied)
      ? { lastDecision: { sourceNodeId: value.lastDecision.sourceNodeId, at: value.lastDecision.at, strategy: value.lastDecision.strategy, applied: value.lastDecision.applied } } : {}),
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function withConfigLock<T>(agentDir: string, callback: (config: SyncConfig, checkpoint: () => void, checkLock: () => void) => T | Promise<T>, persist = true): Promise<T> {
  const path = syncConfigPath(agentDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lease = await acquireSyncLock(path, 30);
  try {
    lease.check();
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Sync configuration must not be a symbolic link");
    // Initialization belongs inside the lock: two first reads must share an id.
    if (!existsSync(path)) {
      readKey(agentDir);
      writeJson(path, defaultConfig());
    }
    const parsed = readJson(path);
    const config = parseConfig(parsed, agentDir);
    const checkpoint = () => {
      lease.check();
      const json = `${JSON.stringify(config, null, 2)}\n`;
      if (Buffer.byteLength(json) > MAX_SYNC_METADATA_BYTES) throw new Error("Synchronization metadata exceeds size limit");
      writePrivateFileAtomicSync(path, json);
    };
    if (config.pendingWrites) {
      for (const pending of config.pendingWrites) {
        const current = readSyncFile(agentDir, pending.path);
        if (pending.version.deleted ? current === null : current && createHash("sha256").update(current.bytes).digest("hex") === pending.version.hash) {
          config.files[pending.path] = pending.version;
        }
      }
      delete config.pendingWrites;
      checkpoint();
    }
    const result = await callback(config, checkpoint, lease.check);
    if (persist) checkpoint();
    return result;
  } finally {
    await lease.release();
  }
}

export function toPublicSyncNode(node: SyncNode): PublicSyncNode {
  return {
    id: node.id, name: node.name, url: node.url, direction: node.direction, connectionId: node.connectionId, platform: node.platform,
    enabled: node.enabled, status: node.status, lastSeenAt: node.lastSeenAt,
    lastSyncAt: node.lastSyncAt, lastError: node.lastError ? syncPublicError(new Error(node.lastError)) : undefined, hasCredential: !!node.credential,
  };
}

export async function readSyncConfig(agentDir = getSyncAgentDir()): Promise<SyncConfig> {
  return withConfigLock(agentDir, (config) => structuredClone(config), false);
}

export async function readPublicSyncState(agentDir = getSyncAgentDir()): Promise<{
  config: Omit<SyncConfig, "nodes" | "files" | "pendingWrites" | "snapshotRevision" | "receivedSnapshots">;
  nodes: PublicSyncNode[];
  available: boolean;
}> {
  const config = await readSyncConfig(agentDir);
  const publicConfig: Omit<SyncConfig, "nodes" | "files" | "pendingWrites" | "snapshotRevision" | "receivedSnapshots"> = {
    version: config.version,
    node: config.node,
    enabled: config.enabled,
    conflictStrategy: config.conflictStrategy,
    policyUpdatedAt: config.policyUpdatedAt,
    policySourceNodeId: config.policySourceNodeId,
    clock: config.clock,
    waitingForAuthority: config.waitingForAuthority,
    lastDecision: config.lastDecision ? {
      sourceNodeId: config.lastDecision.sourceNodeId, at: config.lastDecision.at,
      strategy: config.lastDecision.strategy, applied: config.lastDecision.applied,
    } : undefined,
    ...(config.authorityNodeId ? { authorityNodeId: config.authorityNodeId } : {}),
  };
  return { config: publicConfig, nodes: config.nodes.map(toPublicSyncNode),
    available: !!process.env.PI_WEB_PASSWORD && process.env.PI_WEB_DISABLE_SYNC !== "1" };
}

export async function updateSyncConfig<T>(
  update: (config: SyncConfig, checkpoint: () => void, checkLock: () => void) => T | Promise<T>,
  agentDir = getSyncAgentDir(),
): Promise<T> {
  return withConfigLock(agentDir, update);
}

interface NewSyncNode {
  id?: string;
  connectionId?: string;
  name: string;
  url: string;
  platform: SyncNode["platform"];
  password: string;
}

export async function addSyncNode(input: NewSyncNode, agentDir = getSyncAgentDir()): Promise<PublicSyncNode> {
  return toPublicSyncNode(await insertSyncNode(input, agentDir));
}

/** Retain the exact credential generation for compare-and-delete rollback. */
export async function stageSyncNode(input: NewSyncNode, agentDir = getSyncAgentDir()) {
  const node = await insertSyncNode(input, agentDir);
  return {
    node: toPublicSyncNode(node),
    rollback: () => removeSyncNode(node.id, agentDir, node.connectionId),
  };
}

async function insertSyncNode(input: NewSyncNode, agentDir: string): Promise<SyncNode> {
  const url = normalizeNodeUrl(input.url);
  if (!input.name.trim() || input.name.trim().length > 100) throw new Error("Node name is required");
  if (!input.password || input.password.length > 4096) throw new Error("Node password is required");
  return updateSyncConfig((config) => {
    if (config.nodes.some((node) => node.id === input.id || node.url === url)) throw new Error("This Pi Web node is already configured");
    if (config.nodes.length >= MAX_SYNC_NODES) throw new Error("Too many synchronization nodes");
    if (input.id !== undefined && (!syncId(input.id) || input.id === config.node.id)) throw new Error("Invalid peer registration");
    const node: SyncNode = {
      id: input.id ?? randomUUID(),
      direction: "outbound",
      connectionId: input.connectionId ?? randomUUID(),
      name: input.name.trim(),
      url,
      platform: input.platform,
      enabled: true,
      status: "unknown",
      credential: encryptSyncSecret(input.password, readKey(agentDir)),
    };
    config.nodes.push(node);
    return structuredClone(node);
  }, agentDir);
}

export async function registerInboundSyncNode(input: {
  id: string; name: string; platform: SyncNode["platform"]; connectionId: string;
}, agentDir = getSyncAgentDir()): Promise<void> {
  if (!syncId(input.id) || !syncId(input.connectionId) || !input.name.trim() || input.name.length > 100
    || !["windows", "macos", "linux", "other"].includes(input.platform)) throw new Error("Invalid peer registration");
  await updateSyncConfig((config) => {
    if (input.id === config.node.id) throw new Error("A Pi Web node cannot synchronize with itself");
    const existing = config.nodes.find((node) => node.id === input.id);
    if (existing) {
      if (!existing.enabled) throw new Error("Sync peer is not configured or disabled");
      // Never let concurrent registrations replace an established generation.
      // Reconnect by removing the old record on both sides first.
      if (existing.connectionId !== input.connectionId || existing.direction !== "inbound") throw new Error("This Pi Web node is already configured");
      Object.assign(existing, input, { direction: "inbound", status: "unknown" });
      delete existing.url;
      delete existing.credential;
      return;
    }
    if (config.nodes.length >= MAX_SYNC_NODES) throw new Error("Too many synchronization nodes");
    config.nodes.push({ ...input, direction: "inbound", enabled: true, status: "unknown" });
  }, agentDir);
}

export async function removeSyncNode(id: string, agentDir = getSyncAgentDir(), expectedConnectionId?: string): Promise<boolean> {
  return updateSyncConfig((config) => {
    const index = config.nodes.findIndex((node) => node.id === id);
    if (index < 0) return false;
    if (expectedConnectionId && config.nodes[index].connectionId !== expectedConnectionId) return false;
    config.nodes.splice(index, 1);
    delete config.receivedSnapshots[id];
    // Removing an authority never silently elects another node or changes policy.
    if (config.authorityNodeId === id) config.waitingForAuthority = true;
    return true;
  }, agentDir);
}

export async function setSyncOptions(options: {
  enabled?: boolean;
  conflictStrategy?: SyncConflictStrategy;
  authorityNodeId?: string | null;
}, agentDir = getSyncAgentDir()): Promise<void> {
  return updateSyncConfig((config) => {
    const policyChanged = (options.conflictStrategy !== undefined && options.conflictStrategy !== config.conflictStrategy)
      || (options.authorityNodeId !== undefined && (options.authorityNodeId ?? undefined) !== config.authorityNodeId);
    if (options.enabled !== undefined) {
      if (options.enabled && (!process.env.PI_WEB_PASSWORD || process.env.PI_WEB_DISABLE_SYNC === "1")) {
        throw new Error("Sync requires password authentication and must not be disabled by the operator");
      }
      config.enabled = options.enabled;
    }
    if (options.authorityNodeId !== undefined) {
      if (options.authorityNodeId === null) delete config.authorityNodeId;
      else if (options.authorityNodeId !== config.node.id && !config.nodes.some((node) => node.id === options.authorityNodeId)) throw new Error("Authority node is not configured");
      else config.authorityNodeId = options.authorityNodeId;
    }
    if (options.conflictStrategy !== undefined) config.conflictStrategy = options.conflictStrategy;
    if (config.conflictStrategy === "mtime") { delete config.authorityNodeId; config.waitingForAuthority = false; }
    if (policyChanged) {
      config.policyUpdatedAt = new Date(Math.max(Date.now(), Date.parse(config.policyUpdatedAt) + 1)).toISOString();
      config.policySourceNodeId = config.node.id;
    }
    if (config.conflictStrategy === "authority" && !config.authorityNodeId) {
      throw new Error("Choose a configured authority node before using authority conflict resolution");
    }
  }, agentDir);
}

export async function setSyncNodeEnabled(id: string, enabled: boolean, agentDir = getSyncAgentDir()): Promise<void> {
  return updateSyncConfig((config) => {
    const node = config.nodes.find((candidate) => candidate.id === id);
    if (!node) throw new Error("Sync node is not configured");
    node.enabled = enabled;
    node.status = "unknown";
  }, agentDir);
}

export async function decryptNodePassword(node: SyncNode, agentDir = getSyncAgentDir()): Promise<string> {
  if (!node.credential) throw new Error("Inbound synchronization nodes have no login credential");
  return decryptSyncSecret(node.credential, readKey(agentDir));
}

export function normalizeNodeUrl(value: string): string {
  let parsed: URL;
  if (value.length > 2000) throw new Error("Node URL is invalid");
  try { parsed = new URL(value.trim()); } catch { throw new Error("Node URL is invalid"); }
  if (parsed.protocol !== "https:") throw new Error("Node URL must use HTTPS");
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Node URL must contain only an HTTPS origin");
  }
  return parsed.origin;
}
