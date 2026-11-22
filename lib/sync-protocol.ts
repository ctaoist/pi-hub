import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, utimesSync } from "node:fs";
import { dirname } from "node:path";
import { acquireSyncLock } from "./sync-lock";
import { updateSyncConfig, type SyncConfig, type SyncFileVersion } from "./sync-config";
import { writePrivateBufferAtomicSync } from "./atomic-file";
import { getSyncAgentDir, listSyncFiles, resolveSyncFilePath } from "./sync-scope";
import { assertPortableSyncPaths, readSyncFile, validateSyncJsonFile } from "./sync-files";
import { syncTransportStopped } from "./sync-transport-state";
import { parseSyncVersion, syncCounter } from "./sync-validation";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
// File bytes are base64 encoded, encrypted and encoded again (~1.78x).
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_SYNC_FILES = 5_000;
// Includes BOTH copies of each path, base64 contents and all metadata. Leave
// headroom for the outer encrypted JSON envelope within the 36 MiB wire cap.
const MAX_SNAPSHOT_JSON_BYTES = 24 * 1024 * 1024;
const PROTOCOL_VERSION = 1;

export interface SyncSnapshot {
  protocol: 1;
  snapshotRevision: number;
  node: SyncConfig["node"];
  conflictStrategy: SyncConfig["conflictStrategy"];
  authorityNodeId?: string;
  policyUpdatedAt: string;
  policySourceNodeId: string;
  files: Record<string, SyncFileVersion>;
  contents: Record<string, string>;
}
export interface SyncPeerIdentity {
  id: string;
  name: string;
  platform: "windows" | "macos" | "linux" | "other";
}

function hash(data: Buffer): string { return createHash("sha256").update(data).digest("hex"); }
function compareText(a: string, b: string): number { return a === b ? 0 : a > b ? 1 : -1; }
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(value); }
function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    && Date.parse(value) >= 0 && Date.parse(value) <= Date.now() + 300_000;
}
export function parseSyncIdentity(value: unknown): SyncPeerIdentity {
  if (!isRecord(value) || value.protocol !== PROTOCOL_VERSION || !isId(value.id)
    || typeof value.name !== "string" || value.name.length > 100
    || !["windows", "macos", "linux", "other"].includes(value.platform as string)) throw new Error("Invalid peer identity");
  return { id: value.id, name: value.name, platform: value.platform as SyncPeerIdentity["platform"] };
}
function validateSnapshot(value: unknown, agentDir: string, incremental = false): SyncSnapshot {
  if (!isRecord(value) || value.protocol !== PROTOCOL_VERSION || !isRecord(value.node)) throw new Error("Invalid sync snapshot");
  const node = parseSyncIdentity({ ...value.node, protocol: value.protocol });
  if ((value.conflictStrategy !== "mtime" && value.conflictStrategy !== "authority")
    || (value.conflictStrategy === "authority" && !isId(value.authorityNodeId))
    || !validTime(value.policyUpdatedAt) || !isId(value.policySourceNodeId)
    || !syncCounter(value.snapshotRevision) || value.snapshotRevision < 1
    || !isRecord(value.files) || !isRecord(value.contents)) throw new Error("Invalid synchronization policy or contents");
  if (Object.keys(value.files).length > MAX_SYNC_FILES) throw new Error("Too many files in synchronization scope");
  const files: Record<string, SyncFileVersion> = {};
  for (const [path, version] of Object.entries(value.files)) {
    if (!resolveSyncFilePath(path, agentDir)) throw new Error("Invalid synchronization path");
    files[path] = parseSyncVersion(version);
  }
  const contents = value.contents;
  const paths = Object.keys(files);
  if (paths.length > MAX_SYNC_FILES || Object.keys(contents).length > MAX_SYNC_FILES) throw new Error("Too many files in synchronization scope");
  assertPortableSyncPaths(paths);
  for (const [path, version] of Object.entries(files)) {
    if (!resolveSyncFilePath(path, agentDir) || !validTime(version.updatedAt)) throw new Error("Invalid synchronization path or version");
    if (!incremental && !version.deleted && typeof contents[path] !== "string") throw new Error("Missing synchronization contents");
    if (version.deleted && Object.hasOwn(contents, path)) throw new Error("Deleted file has contents");
  }
  let total = 0;
  for (const [path, content] of Object.entries(contents)) {
    if (!Object.hasOwn(files, path) || typeof content !== "string" || content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) {
      throw new Error("Invalid synchronization contents");
    }
    const bytes = Buffer.from(content, "base64");
    total += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || total > MAX_SNAPSHOT_BYTES || bytes.toString("base64") !== content
      || bytes.length !== files[path].size || hash(bytes) !== files[path].hash) throw new Error("Sync file failed integrity validation");
    validateSyncJsonFile(path, bytes);
  }
  return {
    protocol: PROTOCOL_VERSION, snapshotRevision: value.snapshotRevision, node, conflictStrategy: value.conflictStrategy,
    ...(value.conflictStrategy === "authority" ? { authorityNodeId: value.authorityNodeId as string } : {}),
    policyUpdatedAt: value.policyUpdatedAt, policySourceNodeId: value.policySourceNodeId,
    files: files as Record<string, SyncFileVersion>, contents: contents as Record<string, string>,
  };
}
function checkSnapshotSize(snapshot: SyncSnapshot): SyncSnapshot {
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_JSON_BYTES) throw new Error("Synchronization scope exceeds size limit");
  return snapshot;
}
function nextRevision(previous?: SyncFileVersion): number {
  const next = (previous?.revision ?? 0) + 1;
  if (!syncCounter(next)) throw new Error("Synchronization revision exhausted");
  return next;
}
function nextClock(config: SyncConfig): number {
  if (!syncCounter(config.clock + 1) || config.clock > 8.64e15 - 2) throw new Error("Synchronization clock exhausted");
  config.clock = Math.max(Date.now(), config.clock + 1);
  return config.clock;
}

/** Runs under sync.json's lock. Failed scans never produce deletion tombstones. */
function scanSnapshot(config: SyncConfig, agentDir: string): SyncSnapshot {
  const files = structuredClone(config.files);
  const contents: Record<string, string> = {};
  const present = new Set<string>();
  let total = 0;
  for (const entry of listSyncFiles(agentDir)) {
    const read = readSyncFile(agentDir, entry.path);
    if (!read) throw new Error("Synchronization file changed during read");
    validateSyncJsonFile(entry.path, read.bytes);
    total += read.bytes.length;
    if (total > MAX_SNAPSHOT_BYTES) throw new Error("Synchronization scope exceeds size limit");
    present.add(entry.path);
    const digest = hash(read.bytes);
    const previous = files[entry.path];
    files[entry.path] = previous && !previous.deleted && previous.hash === digest ? previous : {
      hash: digest, size: read.bytes.length, mtimeMs: read.mtimeMs,
      updatedAt: new Date(nextClock(config)).toISOString(), revision: nextRevision(previous),
      sourceNodeId: config.node.id,
    };
    contents[entry.path] = read.bytes.toString("base64");
  }
  for (const [path, version] of Object.entries(files)) {
    if (!present.has(path) && !version.deleted) {
      // A link, unreadable file or interrupted scan is not a deletion.
      if (readSyncFile(agentDir, path)) throw new Error("Synchronization file changed during read");
      files[path] = { deleted: true, updatedAt: new Date(nextClock(config)).toISOString(),
        mtimeMs: Date.now(), revision: nextRevision(version), sourceNodeId: config.node.id };
    }
  }
  if (Object.keys(files).length > MAX_SYNC_FILES) throw new Error("Too many files in synchronization scope");
  assertPortableSyncPaths(Object.keys(files));
  config.files = files;
  if (!syncCounter(config.snapshotRevision + 1)) throw new Error("Synchronization revision exhausted");
  config.snapshotRevision++;
  return checkSnapshotSize({
    protocol: PROTOCOL_VERSION, snapshotRevision: config.snapshotRevision, node: config.node, conflictStrategy: config.conflictStrategy,
    ...(config.conflictStrategy === "authority" ? { authorityNodeId: config.authorityNodeId } : {}),
    policyUpdatedAt: config.policyUpdatedAt, policySourceNodeId: config.policySourceNodeId, files, contents,
  });
}
export function createSyncSnapshot(agentDir = getSyncAgentDir(), peer?: { id: string; connectionId: string }): Promise<SyncSnapshot> {
  return updateSyncConfig((config) => {
    if (peer && !isSyncPeerAllowed(config, peer.id, peer.connectionId)) throw new Error("Sync peer is not configured or disabled");
    return scanSnapshot(config, agentDir);
  }, agentDir);
}
function compareVersions(local: SyncFileVersion, remote: SyncFileVersion): number {
  return Date.parse(local.updatedAt) - Date.parse(remote.updatedAt)
    || (local.revision ?? 0) - (remote.revision ?? 0)
    || compareText(local.sourceNodeId, remote.sourceNodeId)
    || compareText(local.deleted ? "~deleted" : local.hash ?? "", remote.deleted ? "~deleted" : remote.hash ?? "");
}
async function applyVersion(agentDir: string, path: string, version: SyncFileVersion, content: string | undefined, expectedHash: string | null, checkMetadataLock: () => void): Promise<boolean> {
  const target = resolveSyncFilePath(path, agentDir);
  if (!target) throw new Error("Synchronization scope contains an unreadable or linked file");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // The same lock as SettingsManager/AuthStorage. Recheck after waiting for it.
  const lease = await acquireSyncLock(target);
  try {
    lease.check();
    const current = readSyncFile(agentDir, path);
    if ((current ? hash(current.bytes) : null) !== expectedHash) return false;
    if (!resolveSyncFilePath(path, agentDir)) throw new Error("Synchronization scope contains an unreadable or linked file");
    lease.check();
    checkMetadataLock();
    if (version.deleted) {
      if (current) unlinkSync(target);
    } else {
      if (content === undefined) return false;
      const bytes = Buffer.from(content, "base64");
      if (hash(bytes) !== version.hash) return false;
      writePrivateBufferAtomicSync(target, bytes);
      try { utimesSync(target, version.mtimeMs / 1000, version.mtimeMs / 1000); } catch { /* metadata only */ }
    }
    return true;
  } finally { await lease.release(); }
}
export function reconcileSnapshot(snapshotInput: unknown, agentDir = getSyncAgentDir(), expectedPeerId?: string, expectedConnectionId?: string): Promise<SyncSnapshot> {
  return reconcile(snapshotInput, agentDir, expectedPeerId, expectedConnectionId);
}

/** A full version index, but bodies only for files differing from the offered index. */
export type SyncManifest = Omit<SyncSnapshot, "contents">;
export function syncManifest(snapshot: SyncSnapshot): SyncManifest {
  return { protocol: snapshot.protocol, snapshotRevision: snapshot.snapshotRevision, node: snapshot.node,
    conflictStrategy: snapshot.conflictStrategy, authorityNodeId: snapshot.authorityNodeId,
    policyUpdatedAt: snapshot.policyUpdatedAt, policySourceNodeId: snapshot.policySourceNodeId, files: snapshot.files };
}
export function parseSyncManifest(value: unknown, agentDir = getSyncAgentDir(), expectedPeerId?: string): SyncManifest {
  if (!isRecord(value) || Object.hasOwn(value, "contents")) throw new Error("Invalid synchronization manifest");
  const snapshot = validateSnapshot({ ...value, contents: {} }, agentDir, true);
  if (expectedPeerId && snapshot.node.id !== expectedPeerId) throw new Error("Synchronization peer identity changed");
  return syncManifest(snapshot);
}
export function createSyncDelta(snapshot: SyncSnapshot, peer: SyncManifest): SyncSnapshot {
  const contents: Record<string, string> = {};
  const policyOrder = Date.parse(snapshot.policyUpdatedAt) - Date.parse(peer.policyUpdatedAt)
    || compareText(snapshot.policySourceNodeId, peer.policySourceNodeId);
  const receiverPolicy = policyOrder > 0 ? snapshot : peer;
  const samePolicy = receiverPolicy.conflictStrategy === snapshot.conflictStrategy
    && (snapshot.conflictStrategy !== "authority" || receiverPolicy.authorityNodeId === snapshot.authorityNodeId);
  const authority = receiverPolicy.conflictStrategy === "authority" ? receiverPolicy.authorityNodeId : undefined;
  const present = !authority || authority === snapshot.node.id || authority === peer.node.id;
  if (samePolicy && present) for (const [path, bytes] of Object.entries(snapshot.contents)) {
    const known = peer.files[path], version = snapshot.files[path];
    const different = !known || known.deleted || known.hash !== version.hash;
    const wins = !known || (authority ? authority === snapshot.node.id : compareVersions(version, known) > 0);
    if (different && wins) contents[path] = bytes;
  }
  return { ...snapshot, contents };
}
/** A peer edited a body we omitted after it advertised the same hash. Retry a fresh index. */
export class SyncBasisChanged extends Error {
  constructor() { super("Synchronization basis changed; retry the exchange"); }
}
export function reconcileSyncDelta(delta: unknown, agentDir = getSyncAgentDir(), peerId?: string, connectionId?: string): Promise<SyncSnapshot> {
  return reconcile(delta, agentDir, peerId, connectionId, true);
}
export function syncSnapshotFingerprint(snapshot: SyncManifest): string {
  return hash(Buffer.from(JSON.stringify([snapshot.conflictStrategy, snapshot.authorityNodeId,
    snapshot.policyUpdatedAt, snapshot.policySourceNodeId,
    Object.entries(snapshot.files).sort(([a], [b]) => compareText(a, b)).map(([path, version]) =>
      [path, !!version.deleted, version.hash, version.size, version.updatedAt, version.revision ?? 0, version.sourceNodeId])])));
}
async function reconcile(snapshotInput: unknown, agentDir: string, expectedPeerId?: string, expectedConnectionId?: string, incremental = false): Promise<SyncSnapshot> {
  const remote = validateSnapshot(snapshotInput, agentDir, incremental);
  return updateSyncConfig(async (config, checkpoint, checkLock) => {
    if (expectedPeerId && (!isSyncPeerAllowed(config, expectedPeerId, expectedConnectionId) || remote.node.id !== expectedPeerId)) {
      throw new Error("Sync peer is not configured or disabled");
    }
    if (remote.node.id === config.node.id) throw new Error("Sync peer has the same node identity");
    // A valid old HTTP response is still stale; one-use request nonces alone
    // do not prevent two concurrent exchanges completing in reverse order.
    if (!Object.hasOwn(config.receivedSnapshots, remote.node.id) && Object.keys(config.receivedSnapshots).length >= 1000) throw new Error("Too many synchronization peers");
    const seenRevision = Object.hasOwn(config.receivedSnapshots, remote.node.id) ? config.receivedSnapshots[remote.node.id] : 0;
    if (remote.snapshotRevision <= seenRevision) return scanSnapshot(config, agentDir);
    const policyOrder = Date.parse(remote.policyUpdatedAt) - Date.parse(config.policyUpdatedAt)
      || compareText(remote.policySourceNodeId, config.policySourceNodeId);
    if (policyOrder > 0) {
      config.conflictStrategy = remote.conflictStrategy;
      config.authorityNodeId = remote.authorityNodeId;
      config.policyUpdatedAt = remote.policyUpdatedAt;
      config.policySourceNodeId = remote.policySourceNodeId;
    }
    const local = scanSnapshot(config, agentDir);
    // Exchange the newer policy first; never write under divergent policies.
    if (config.conflictStrategy !== remote.conflictStrategy
      || (config.conflictStrategy === "authority" && config.authorityNodeId !== remote.authorityNodeId)) return local;
    const authority = config.conflictStrategy === "authority" ? config.authorityNodeId : undefined;
    const authorityPresent = !authority || authority === config.node.id || authority === remote.node.id;
    const paths = new Set([...Object.keys(local.files), ...Object.keys(remote.files)]);
    if (paths.size > MAX_SYNC_FILES) throw new Error("Too many files in synchronization scope");
    assertPortableSyncPaths(paths);
    const changes: Array<{ path: string; version: SyncFileVersion; expectedHash: string | null }> = [];
    let projectedBytes = Object.values(local.contents).reduce((total, content) => total + Buffer.byteLength(content, "base64"), 0);
    let applied = 0;
    config.waitingForAuthority = !authorityPresent;
    for (const path of paths) {
      const lv = local.files[path];
      const rv = remote.files[path];
      if (!rv) continue;
      config.clock = Math.max(config.clock, Date.parse(rv.updatedAt));
      const identical = lv && !!lv.deleted === !!rv.deleted && (lv.deleted || lv.hash === rv.hash);
      if (identical) {
        if (!lv.deleted && lv.size !== rv.size) throw new Error("Sync file failed integrity validation");
        if (compareVersions(lv, rv) < 0) config.files[path] = rv;
        continue;
      }
      if (!authorityPresent) continue;
      const takeRemote = !lv || (authority ? remote.node.id === authority : compareVersions(lv, rv) < 0);
      if (!takeRemote) continue;
      if (!rv.deleted && !Object.hasOwn(remote.contents, path)) throw new SyncBasisChanged();
      // Bound even a partially applied merge: concurrent edits can make a
      // planned shrink/delete skip, so don't spend those savings in advance.
      const localBytes = lv?.deleted ? 0 : lv?.size ?? 0;
      const remoteBytes = rv.deleted ? 0 : rv.size ?? 0;
      projectedBytes += Math.max(0, remoteBytes - localBytes);
      changes.push({ path, version: rv, expectedHash: lv?.deleted ? null : lv?.hash ?? null });
    }
    if (projectedBytes > MAX_SNAPSHOT_BYTES) throw new Error("Synchronization scope exceeds size limit");
    const projectedContents = { ...local.contents };
    const projectedFiles = { ...config.files };
    for (const change of changes) {
      // Count the larger representation independently for metadata and bytes.
      // A skipped deletion/shrink must not fund another file's path overhead.
      const previous = projectedFiles[change.path];
      if (!previous || Buffer.byteLength(JSON.stringify(change.version)) > Buffer.byteLength(JSON.stringify(previous))) {
        projectedFiles[change.path] = change.version;
      }
      const content = remote.contents[change.path];
      if (content !== undefined && (projectedContents[change.path]?.length ?? -1) < content.length) projectedContents[change.path] = content;
    }
    checkSnapshotSize({ ...local, snapshotRevision: local.snapshotRevision + 1, files: projectedFiles, contents: projectedContents });
    // Persist the watermark BEFORE any writes: a partial success must also
    // reject older authority responses. A retry requests a fresh snapshot.
    Object.defineProperty(config.receivedSnapshots, remote.node.id, { value: remote.snapshotRevision, enumerable: true, writable: true, configurable: true });
    // One bounded journal for the batch avoids rewriting the whole ledger
    // twice per file (quadratic I/O at the 5,000-file limit).
    config.pendingWrites = changes.map(({ path, version }) => ({ path, version }));
    checkpoint();
    const checkWriteAllowed = () => {
      checkLock();
      if (expectedPeerId && !isSyncPeerAllowed(config, expectedPeerId, expectedConnectionId)) throw new Error("Sync peer is not configured or disabled");
    };
    for (const change of changes) {
      if (await applyVersion(agentDir, change.path, change.version, remote.contents[change.path], change.expectedHash, checkWriteAllowed)) {
        config.files[change.path] = change.version;
        applied++;
        config.lastDecision = { sourceNodeId: remote.node.id, at: new Date().toISOString(), strategy: config.conflictStrategy, applied };
      }
    }
    delete config.pendingWrites;
    checkpoint();
    return scanSnapshot(config, agentDir);
  }, agentDir);
}
export function isSyncPeerAllowed(config: SyncConfig, nodeId: string, connectionId?: string): boolean {
  return !syncTransportStopped() && config.enabled && process.env.PI_WEB_DISABLE_SYNC !== "1" && !!process.env.PI_WEB_PASSWORD
    && config.nodes.some((node) => node.id === nodeId && node.enabled && (!connectionId || node.connectionId === connectionId));
}
