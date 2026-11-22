import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { readSyncConfig, normalizeNodeUrl, decryptNodePassword, registerInboundSyncNode, stageSyncNode, updateSyncConfig, type SyncNode } from "./sync-config";
import { parseSyncIdentity, isSyncPeerAllowed, type SyncPeerIdentity } from "./sync-protocol";
import { SyncExchange } from "./sync-exchange";
import { notifySyncScopeChanged } from "./sync-watch";
import { createSyncExchange, syncExchangeSecret } from "./sync-crypto";
import { SyncChannel } from "./sync-channel";
import { getSyncAgentDir, syncConfigPath } from "./sync-scope";
import { SYNC_WIRE_LIMIT, syncPublicError } from "./sync-http";
import { syncId, syncRecord } from "./sync-validation";
import { isApiRequestAllowed } from "./request-security";
import { isValidBasicAuthorization } from "./web-auth";
import { getAuthRetryAfterMs, recordAuthFailure } from "./auth-throttle";
import { notifySyncConfigurationChanged, onSyncConfigurationChanged, setSyncTransportStopped, syncTransportStopped } from "./sync-transport-state";

export const SYNC_SOCKET_PATH = "/api/sync/socket";
const HANDSHAKE_TIMEOUT = 12_000;
interface Link { ws: WebSocket; agentDir: string; peerId?: string; connectionId?: string; outbound: boolean; authenticatedPassword?: string }
interface Runtime {
  links: Set<Link>;
  pending: Set<string>;
  retry: Map<string, { at: number; failures: number }>;
  server?: WebSocketServer;
  timer?: NodeJS.Timeout;
  running: boolean;
}
const runtimeKey = Symbol.for("pi-web:sync-sockets");
function runtime(): Runtime {
  const globals = globalThis as Record<symbol, unknown>;
  return (globals[runtimeKey] ??= { links: new Set(), pending: new Set(), retry: new Map(), running: false }) as Runtime;
}
function enabled(): boolean { return !syncTransportStopped() && process.env.PI_WEB_DISABLE_SYNC !== "1" && !!process.env.PI_WEB_PASSWORD; }
function rawBuffer(data: RawData): Buffer { return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data); }
function parseSmall(data: Buffer): Record<string, unknown> {
  if (data.length > 16 * 1024) throw new Error("Invalid sync handshake");
  const value: unknown = JSON.parse(data.toString());
  if (!syncRecord(value)) throw new Error("Invalid sync handshake");
  return value;
}
function sendSmall(ws: WebSocket, value: unknown): void { ws.send(JSON.stringify(value)); }
function binding(agentDir: string, id: string): string { return `${agentDir}:${id}`; }
async function mark(link: Omit<Link, "ws">, online: boolean, error?: unknown) {
  if (!link.peerId) return;
  if (!online && [...runtime().links].some((current) => current.agentDir === link.agentDir && current.peerId === link.peerId
    && current.connectionId === link.connectionId && current.ws.readyState === WebSocket.OPEN)) return;
  await updateSyncConfig((config) => {
    const node = config.nodes.find((node) => node.id === link.peerId && node.connectionId === link.connectionId);
    if (!node) return;
    node.status = online ? "online" : "offline";
    if (online) { node.lastSeenAt = node.lastSyncAt = new Date().toISOString(); delete node.lastError; }
    else { node.lastError = syncPublicError(error); if (config.authorityNodeId === node.id) config.waitingForAuthority = true; }
  }, link.agentDir);
}
async function allowed(link: Link): Promise<boolean> {
  if (!enabled() || !link.peerId || !link.connectionId) return false;
  if (!link.outbound && link.authenticatedPassword !== process.env.PI_WEB_PASSWORD) return false;
  const config = await readSyncConfig(link.agentDir);
  return isSyncPeerAllowed(config, link.peerId, link.connectionId);
}
function addLink(link: Link): void {
  if (runtime().links.size >= 100) throw new Error("Too many synchronization connections");
  runtime().links.add(link);
  link.ws.on("error", () => {});
  link.ws.once("close", () => runtime().links.delete(link));
}
function deduplicate(link: Link): void {
  for (const old of runtime().links) {
    if (old !== link && old.agentDir === link.agentDir && old.peerId === link.peerId) old.ws.terminate();
  }
}

/** Same port as Next; only the custom server calls this for upgrade requests. */
export function handleSyncUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, agentDir = getSyncAgentDir()): void {
  const refuse = (status: number) => { socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  socket.on("error", () => {});
  try {
    if (req.method !== "GET" || req.url !== SYNC_SOCKET_PATH) { refuse(404); return; }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    // Upgrade bypasses Next's proxy, so apply the SAME host/origin and shared
    // Basic-password throttle here. Cookies never authorize a sync socket.
    const request = new Request(`http://${req.headers.host ?? "invalid"}${SYNC_SOCKET_PATH}`, { headers });
    if (!isApiRequestAllowed(request)) { refuse(403); return; }
    if (!enabled()) { refuse(503); return; }
    if (getAuthRetryAfterMs() > 0) { refuse(429); return; }
    const authorization = headers.get("authorization");
    if (!isValidBasicAuthorization(authorization)) {
      if (authorization && /^Basic\s/i.test(authorization)) recordAuthFailure();
      refuse(401); return;
    }
    if (runtime().links.size >= 100) { refuse(503); return; }
    const server = runtime().server ??= new WebSocketServer({ noServer: true, maxPayload: SYNC_WIRE_LIMIT, perMessageDeflate: false });
    server.handleUpgrade(req, socket, head, (ws) => acceptSocket(ws, agentDir));
  } catch { refuse(400); }
}

function acceptSocket(ws: WebSocket, agentDir: string): void {
  const link: Link = { ws, agentDir, outbound: false, authenticatedPassword: process.env.PI_WEB_PASSWORD };
  try { addLink(link); } catch { ws.terminate(); return; }
  const keys = createSyncExchange(), nonce = randomBytes(24).toString("hex");
  let channel: SyncChannel | undefined;
  let phase: "key" | "hello" | "active" = "key";
  let exchange: SyncExchange | undefined;
  let busy = false, alive = true;
  let deadline = Date.now() + HANDSHAKE_TIMEOUT;
  let authorizing = false;
  const fail = () => ws.terminate();
  const timer = setInterval(() => {
    if (Date.now() > deadline || !alive || !enabled() || ws.readyState !== WebSocket.OPEN || link.authenticatedPassword !== process.env.PI_WEB_PASSWORD) { fail(); return; }
    alive = false; ws.ping();
    if (phase === "active" && !authorizing) {
      authorizing = true;
      void allowed(link).then((ok) => { if (!ok) fail(); }).catch(fail).finally(() => { authorizing = false; });
    }
  }, 5_000);
  timer.unref();
  ws.on("pong", () => { alive = true; });
  ws.once("close", () => { clearInterval(timer); exchange?.close(); void mark(link, false).catch(() => {}); });
  void readSyncConfig(agentDir).then((config) => sendSmall(ws, { protocol: 3, node: config.node, nonce, publicKey: keys.publicKey })).catch(fail);
  ws.on("message", (raw, binary) => {
    if (binary) { fail(); return; }
    if (phase === "active" && exchange) {
      try { exchange.receive(channel!.receive(rawBuffer(raw))); } catch { fail(); }
      return;
    }
    if (busy) { fail(); return; }
    busy = true;
    void (async () => {
      const data = rawBuffer(raw);
      if (phase === "key") {
        const value = parseSmall(data);
        if (typeof value.publicKey !== "string") throw new Error("Invalid sync handshake");
        channel = new SyncChannel(ws, syncExchangeSecret(keys.privateKey, value.publicKey, nonce), nonce, "server");
        phase = "hello";
        await channel.send({ type: "key-ready" });
        return;
      }
      const value = channel!.receive(data);
      if (!syncRecord(value)) throw new Error("Invalid sync message");
      if (phase === "hello") {
        const peer = parseSyncIdentity({ ...(syncRecord(value.node) ? value.node : {}), protocol: 1 });
        if (!syncId(value.connectionId) || (value.type !== "register" && value.type !== "resume")) throw new Error("Invalid sync handshake");
        if (value.type === "register" && [...runtime().links].some((other) => other !== link && other.agentDir === agentDir && other.peerId === peer.id)) throw new Error("This Pi Web node is already connected");
        if (!enabled() || link.authenticatedPassword !== process.env.PI_WEB_PASSWORD) throw new Error("Synchronization is disabled");
        if (value.type === "register") await registerInboundSyncNode({ ...peer, connectionId: value.connectionId }, agentDir);
        else {
          const config = await readSyncConfig(agentDir);
          if (!config.nodes.some((node) => node.id === peer.id && node.direction === "inbound" && node.connectionId === value.connectionId && node.enabled)) throw new Error("Sync peer is not configured or disabled");
        }
        link.peerId = peer.id; link.connectionId = value.connectionId;
        deduplicate(link);
        phase = "active"; deadline = Infinity;
        await channel!.send({ type: "ready" });
        exchange = new SyncExchange({ server: true, agentDir, peerId: peer.id, connectionId: value.connectionId,
          channel: channel!, allowed: () => allowed(link), synced: () => mark(link, true), fail });
        return;
      }
      throw new Error("Unexpected sync message");
    })().catch(fail).finally(() => { busy = false; });
  });
}

interface DialOptions { agentDir: string; url: string; password: string; peerId?: string; connectionId: string; register?: boolean; name?: string }
async function dial(options: DialOptions): Promise<{ link: Link; peer: SyncPeerIdentity }> {
  if (!enabled()) throw new Error("Synchronization is disabled");
  const local = await readSyncConfig(options.agentDir);
  const url = new URL(normalizeNodeUrl(options.url)); url.protocol = "wss:"; url.pathname = SYNC_SOCKET_PATH;
  const ws = new WebSocket(url, { headers: { Authorization: `Basic ${Buffer.from(`pi:${options.password}`).toString("base64")}` },
    handshakeTimeout: HANDSHAKE_TIMEOUT, followRedirects: false, maxPayload: SYNC_WIRE_LIMIT, perMessageDeflate: false });
  const link: Link = { ws, agentDir: options.agentDir, peerId: options.peerId, connectionId: options.connectionId, outbound: true };
  try { addLink(link); } catch (error) { ws.terminate(); throw error; }
  return new Promise((resolve, reject) => {
    let phase: "challenge" | "key-ready" | "ready" | "active" = "challenge";
    let exchange: SyncExchange | undefined;
    let channel: SyncChannel | undefined, peer: SyncPeerIdentity;
    let busy = false, ready = false, lastMessage = Date.now();
    let deadline = Date.now() + HANDSHAKE_TIMEOUT;
    let failure = new Error("Synchronization connection closed");
    const timer = setInterval(() => {
      if (!enabled() || Date.now() > deadline || Date.now() - lastMessage > 45_000) ws.terminate();
    }, 5_000);
    timer.unref();
    ws.on("ping", () => { lastMessage = Date.now(); });
    ws.once("close", () => {
      clearInterval(timer); exchange?.close();
      if (!ready) reject(failure);
      else {
        const key = binding(options.agentDir, peer.id);
        const failures = Math.min(8, (runtime().retry.get(key)?.failures ?? 0) + 1);
        runtime().retry.set(key, { failures, at: Date.now() + Math.min(60_000, 1000 * 2 ** failures) + Math.random() * 1000 });
        void mark(link, false, failure).catch(() => {});
      }
    });
    ws.on("unexpected-response", (_request, response) => { response.destroy(); failure = new Error(`Peer returned HTTP ${response.statusCode}`); ws.terminate(); });
    ws.on("message", (raw, binary) => {
      if (binary) { ws.terminate(); return; }
      if (phase === "active" && exchange) {
        try { exchange.receive(channel!.receive(rawBuffer(raw))); } catch { ws.terminate(); }
        return;
      }
      if (busy) { ws.terminate(); return; }
      busy = true; lastMessage = Date.now();
      void (async () => {
        const data = rawBuffer(raw);
        if (phase === "challenge") {
          const value = parseSmall(data);
          if (value.protocol !== 3 || typeof value.nonce !== "string" || !/^[a-f0-9]{48}$/.test(value.nonce) || typeof value.publicKey !== "string") throw new Error("Invalid sync handshake");
          peer = parseSyncIdentity({ ...(syncRecord(value.node) ? value.node : {}), protocol: 1 });
          if (peer.id === local.node.id || (options.peerId && peer.id !== options.peerId)) throw new Error("Synchronization peer identity changed");
          if (options.register && local.nodes.some((node) => node.id === peer.id)) throw new Error("This Pi Web node is already configured");
          link.peerId = peer.id;
          const keys = createSyncExchange();
          channel = new SyncChannel(ws, syncExchangeSecret(keys.privateKey, value.publicKey, value.nonce), value.nonce, "client");
          sendSmall(ws, { publicKey: keys.publicKey });
          phase = "key-ready";
          return;
        }
        const value = channel!.receive(data);
        if (!syncRecord(value)) throw new Error("Invalid sync message");
        if (phase === "key-ready" && value.type === "key-ready") {
          phase = "ready";
          await channel!.send({ type: options.register ? "register" : "resume", node: local.node, connectionId: options.connectionId });
          return;
        }
        if (phase === "ready" && value.type === "ready") {
          if (options.register) {
            await stageSyncNode({ ...peer, connectionId: options.connectionId, name: options.name?.trim() || peer.name,
              url: options.url, password: options.password }, options.agentDir);
          }
          ready = true; phase = "active"; deadline = Infinity;
          deduplicate(link);
          exchange = new SyncExchange({ server: false, agentDir: options.agentDir, peerId: peer.id, connectionId: options.connectionId,
            channel: channel!, allowed: () => allowed(link), fail: () => ws.terminate(), synced: async () => {
              await mark(link, true); runtime().retry.delete(binding(options.agentDir, peer.id));
            } });
          resolve({ link, peer });
          return;
        }
        throw new Error("Unexpected sync message");
      })().catch((error) => { failure = new Error(syncPublicError(error)); ws.terminate(); }).finally(() => { busy = false; });
    });
  });
}

export async function connectSyncNode(input: { name: string; url: string; password: string }, agentDir = getSyncAgentDir()) {
  if (!input.password || input.password.length > 4096 || input.name.length > 100) throw new Error("Invalid node details");
  const url = normalizeNodeUrl(input.url);
  const config = await readSyncConfig(agentDir);
  if (config.nodes.some((node) => node.url === url)) throw new Error("This Pi Web node is already configured");
  const key = binding(agentDir, url);
  if (runtime().pending.has(key)) throw new Error("This Pi Web node is already configured");
  runtime().pending.add(key);
  try {
    const result = await dial({ ...input, url, agentDir, register: true, connectionId: randomUUID() });
    notifySyncConfigurationChanged();
    return result.peer;
  } finally { runtime().pending.delete(key); }
}

export async function refreshSyncConnections(agentDir = getSyncAgentDir()): Promise<void> {
  if (!existsSync(syncConfigPath(agentDir))) return;
  const config = await readSyncConfig(agentDir);
  for (const key of runtime().retry.keys()) {
    if (key.startsWith(`${agentDir}:`) && !config.nodes.some((node) => key === binding(agentDir, node.id))) runtime().retry.delete(key);
  }
  for (const link of runtime().links) {
    if (link.agentDir !== agentDir || !link.peerId) continue;
    if (!enabled() || !config.enabled || !config.nodes.some((node) => node.enabled && node.id === link.peerId && node.connectionId === link.connectionId)) link.ws.terminate();
  }
  if (!enabled() || !config.enabled) return;
  // Authority first. Every active socket carries BOTH directions; inbound
  // members have no URL/password and are never dialled back.
  const nodes = [...config.nodes].sort((a, b) => Number(b.id === config.authorityNodeId) - Number(a.id === config.authorityNodeId));
  await Promise.all(nodes.filter((node) => node.enabled && node.direction === "outbound" && node.url && node.credential).map(async (node: SyncNode) => {
    const key = binding(agentDir, node.id);
    if (runtime().pending.has(key) || runtime().pending.size >= 4 || (runtime().retry.get(key)?.at ?? 0) > Date.now()
      || [...runtime().links].some((link) => link.agentDir === agentDir && link.peerId === node.id)) return;
    runtime().pending.add(key);
    try {
      await dial({ agentDir, url: node.url!, password: await decryptNodePassword(node, agentDir), peerId: node.id, connectionId: node.connectionId });
    } catch (error) {
      const failures = Math.min(8, (runtime().retry.get(key)?.failures ?? 0) + 1);
      runtime().retry.set(key, { failures, at: Date.now() + Math.min(60_000, 1000 * 2 ** failures) + Math.random() * 1000 });
      await mark({ agentDir, peerId: node.id, connectionId: node.connectionId, outbound: true }, false, error).catch(() => {});
    } finally { runtime().pending.delete(key); }
  }));
}
export function startSyncScheduler(): void {
  if (runtime().timer || process.env.PI_WEB_DISABLE_SYNC === "1") return;
  setSyncTransportStopped(false);
  const tick = () => {
    if (runtime().running) return;
    runtime().running = true;
    void refreshSyncConnections().catch(() => {}).finally(() => { runtime().running = false; });
  };
  onSyncConfigurationChanged(() => { notifySyncScopeChanged(getSyncAgentDir()); tick(); });
  runtime().timer = setInterval(tick, 5_000); runtime().timer!.unref(); tick();
}
export function stopSyncScheduler(): void {
  setSyncTransportStopped(true);
  if (runtime().timer) clearInterval(runtime().timer);
  runtime().timer = undefined;
  for (const link of runtime().links) link.ws.terminate();
  runtime().retry.clear();
}

/** The non-bundled custom server accesses only this shared hook, never TS files. */
export function installSyncUpgradeHandler(): void {
  (globalThis as Record<symbol, unknown>)[Symbol.for("pi-web:sync-upgrade")] = handleSyncUpgrade;
}
