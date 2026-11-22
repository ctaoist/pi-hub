import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import lockfile from "proper-lockfile";
import lockfileState from "proper-lockfile/lib/lockfile.js";
const jiti = createJiti(import.meta.url);
const config = await jiti.import("./sync-config.ts");
const protocol = await jiti.import("./sync-protocol.ts");
const transportState = await jiti.import("./sync-transport-state.ts");
function dirs(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-sync-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return ["a", "b"].map((name) => { const dir = join(root, name); mkdirSync(dir); return dir; });
}
async function copy(a, b) { return protocol.reconcileSnapshot(await protocol.createSyncSnapshot(a), b); }
function entry(snapshot, path, bytes) {
  const data = Buffer.from(bytes);
  snapshot.files[path] = { hash: createHash("sha256").update(data).digest("hex"), size: data.length,
    sourceNodeId: snapshot.node.id, updatedAt: new Date().toISOString(), revision: 1, mtimeMs: Date.now() };
  snapshot.contents[path] = data.toString("base64");
}

test("review: malformed deletion flag must not delete an existing credential file", async (t) => {
  const [a, b] = dirs(t);
  writeFileSync(join(a, "auth.json"), '{"token":"keep"}');
  await copy(a, b);
  const remote = await protocol.createSyncSnapshot(a);
  remote.files["auth.json"] = { ...remote.files["auth.json"], deleted: "false", updatedAt: new Date(Date.now() + 1000).toISOString() };
  await assert.rejects(protocol.reconcileSnapshot(remote, b), /version|delet|snapshot/i);
  assert.equal(readFileSync(join(b, "auth.json"), "utf8"), '{"token":"keep"}');
});

test("review: a failed later write must retain already applied remote version metadata", async (t) => {
  const [a, b] = dirs(t);
  writeFileSync(join(a, "auth.json"), '{"v":1}');
  writeFileSync(join(a, "settings.json"), '{"v":1}');
  await copy(a, b);
  writeFileSync(join(a, "auth.json"), '{"v":2}');
  writeFileSync(join(a, "settings.json"), '{"v":2}');
  const remote = await protocol.createSyncSnapshot(a);
  const release = await lockfile.lock(join(b, "settings.json"));
  try { await assert.rejects(protocol.reconcileSnapshot(remote, b)); }
  finally { await release(); }
  assert.equal(readFileSync(join(b, "auth.json"), "utf8"), '{"v":2}');
  const next = await protocol.createSyncSnapshot(b);
  assert.deepEqual(next.files["auth.json"], remote.files["auth.json"], "applied file must not become a new local edit after an error");
});

test("review: merged scope limit is checked before any remote files are written", async (t) => {
  const [a, b] = dirs(t);
  for (const dir of [a, b]) mkdirSync(join(dir, "extensions"));
  for (const n of [1, 2]) writeFileSync(join(a, "extensions", `a${n}.txt`), Buffer.alloc(5 * 1024 * 1024, 97));
  for (const n of [1, 2]) writeFileSync(join(b, "extensions", `b${n}.txt`), Buffer.alloc(5 * 1024 * 1024, 98));
  const before = await protocol.createSyncSnapshot(b);
  await assert.rejects(protocol.reconcileSnapshot(await protocol.createSyncSnapshot(a), b), /size limit/);
  assert.equal(existsSync(join(b, "extensions", "a1.txt")), false, "oversized union must leave files alone");
  assert.deepEqual((await protocol.createSyncSnapshot(b)).files, before.files);
});

test("review: old authority reply cannot roll back a newer accepted authority version", async (t) => {
  const [a, b] = dirs(t);
  const aid = (await config.readSyncConfig(a)).node.id;
  await config.setSyncOptions({ conflictStrategy: "authority", authorityNodeId: aid }, a);
  writeFileSync(join(a, "settings.json"), '{"v":1}');
  const old = await protocol.createSyncSnapshot(a);
  await protocol.reconcileSnapshot(old, b);
  writeFileSync(join(a, "settings.json"), '{"v":2}');
  await copy(a, b);
  await protocol.reconcileSnapshot(old, b);
  assert.equal(readFileSync(join(b, "settings.json"), "utf8"), '{"v":2}');
});

test("review: unrecognized version fields are not persisted into local metadata", async (t) => {
  const [a, b] = dirs(t);
  const remote = await protocol.createSyncSnapshot(a);
  entry(remote, "auth.json", '{}');
  remote.files["auth.json"].unexpected = { secret: "must-not-persist" };
  await protocol.reconcileSnapshot(remote, b);
  assert.equal(readFileSync(join(b, "sync.json"), "utf8").includes("must-not-persist"), false);
});

test("review: prototype-shaped invalid paths are refused rather than silently dropped", async (t) => {
  const [a, b] = dirs(t);
  const remote = await protocol.createSyncSnapshot(a);
  Object.defineProperty(remote.files, "__proto__", { enumerable: true, value: {
    deleted: true, sourceNodeId: remote.node.id, mtimeMs: 0, updatedAt: new Date().toISOString(), revision: 1,
  } });
  await assert.rejects(protocol.reconcileSnapshot(remote, b), /path/);
});

test("review: malformed local ledger is refused without replacing credential data", async (t) => {
  const [a] = dirs(t);
  await config.readSyncConfig(a);
  const path = join(a, "sync.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.files = { "auth.json": { deleted: "false", hash: "0".repeat(64), sourceNodeId: value.node.id, updatedAt: new Date().toISOString(), mtimeMs: 0, size: 2 } };
  writeFileSync(path, JSON.stringify(value));
  writeFileSync(join(a, "auth.json"), '{}');
  await assert.rejects(protocol.createSyncSnapshot(a), /version/);
  assert.equal(readFileSync(join(a, "auth.json"), "utf8"), '{}');
});

test("review: platform aliases with reserved Windows device names are refused", async (t) => {
  const [a] = dirs(t);
  const { resolveSyncFilePath } = await jiti.import("./sync-scope.ts");
  for (const path of ["extensions/CON .txt", "extensions/NUL .js", "extensions/CLOCK$", "extensions/CONIN$", "extensions/CONOUT$"]) {
    assert.equal(resolveSyncFilePath(path, a), null, path);
  }
});

test("review: journal recovers a file committed before a process restart", async (t) => {
  const [a, b] = dirs(t);
  writeFileSync(join(a, "auth.json"), '{"v":1}');
  await copy(a, b);
  writeFileSync(join(a, "auth.json"), '{"v":2}');
  const remote = await protocol.createSyncSnapshot(a);
  await config.updateSyncConfig((value) => { value.pendingWrites = [{ path: "auth.json", version: remote.files["auth.json"] }]; }, b);
  writeFileSync(join(b, "auth.json"), '{"v":2}');
  assert.deepEqual((await protocol.createSyncSnapshot(b)).files["auth.json"], remote.files["auth.json"]);
  assert.equal((await config.readSyncConfig(b)).pendingWrites, undefined);
});

test("review: partial newer authority merge blocks an older snapshot even after failure", async (t) => {
  const [a, b] = dirs(t);
  const aid = (await config.readSyncConfig(a)).node.id;
  await config.setSyncOptions({ conflictStrategy: "authority", authorityNodeId: aid }, a);
  writeFileSync(join(a, "auth.json"), '{"v":1}');
  writeFileSync(join(a, "settings.json"), '{}');
  const old = await protocol.createSyncSnapshot(a);
  await protocol.reconcileSnapshot(old, b);
  writeFileSync(join(a, "auth.json"), '{"v":2}');
  writeFileSync(join(a, "settings.json"), '{"v":2}');
  const release = await lockfile.lock(join(b, "settings.json"));
  try { await assert.rejects(copy(a, b)); } finally { await release(); }
  // New request for the previously accepted old contents, not a nonce replay.
  await protocol.reconcileSnapshot({ ...old, snapshotRevision: old.snapshotRevision + 1 }, b);
  assert.equal(readFileSync(join(b, "auth.json"), "utf8"), '{"v":2}');
});

test("review: stolen sync metadata lock does not crash the server or overwrite the ledger", async (t) => {
  const [a] = dirs(t);
  const before = await config.readSyncConfig(a);
  const lockPath = join(a, "sync.json.lock");
  await assert.rejects(config.updateSyncConfig(async (value) => {
    value.enabled = true;
    rmSync(lockPath, { recursive: true });
    mkdirSync(lockPath);
    const future = new Date(Date.now() + 30_000);
    utimesSync(lockPath, future, future);
    await new Promise((resolve) => setTimeout(resolve, 5300));
  }, a), /lock|compromis/i);
  rmSync(lockPath, { recursive: true, force: true });
  assert.equal((await config.readSyncConfig(a)).enabled, before.enabled);
});

test("review: early compromised-lock release drops its heartbeat but keeps the replacement lock", async (t) => {
  const [a] = dirs(t);
  const { acquireSyncLock } = await jiti.import("./sync-lock.ts");
  const path = join(a, "settings.json");
  const lease = await acquireSyncLock(path);
  const lockPath = `${path}.lock`;
  rmSync(lockPath, { recursive: true });
  mkdirSync(lockPath);
  await lease.release();
  assert.equal(existsSync(lockPath), true, "replacement lock belongs to another writer");
  assert.equal(Object.hasOwn(lockfileState.getLocks(), path), false, "old heartbeat/exit cleanup must not own replacement lock");
});

test("review: stopping sync while a file lock is pending prevents its write", async (t) => {
  const [a, b] = dirs(t);
  const previousPassword = process.env.PI_WEB_PASSWORD;
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_WEB_PASSWORD = "test-password";
  // Reset the process runtime on cleanup without touching a real agent dir.
  process.env.PI_CODING_AGENT_DIR = join(a, "unused");
  t.after(() => {
    transportState.setSyncTransportStopped(false);
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD; else process.env.PI_WEB_PASSWORD = previousPassword;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
  });
  writeFileSync(join(a, "settings.json"), '{"v":1}');
  await copy(a, b);
  const aid = (await config.readSyncConfig(a)).node.id;
  await config.addSyncNode({ id: aid, name: "A", url: "https://a.example", platform: "linux", password: "test-password" }, b);
  await config.setSyncOptions({ enabled: true }, b);
  writeFileSync(join(a, "settings.json"), '{"v":2}');
  const remote = await protocol.createSyncSnapshot(a);
  const release = await lockfile.lock(join(b, "settings.json"));
  const journaled = new Promise((resolve, reject) => {
    const watcher = watch(b, () => {
      try {
        if (JSON.parse(readFileSync(join(b, "sync.json"), "utf8")).pendingWrites?.length) { clearTimeout(timer); watcher.close(); resolve(); }
      } catch { /* atomic rename still in progress */ }
    });
    const timer = setTimeout(() => { watcher.close(); reject(new Error("journal was not written")); }, 2000);
  });
  const pending = protocol.reconcileSnapshot(remote, b, aid);
  const refused = assert.rejects(pending, /disabled|stopp/);
  await journaled;
  transportState.setSyncTransportStopped(true);
  await release();
  await refused;
  assert.equal(readFileSync(join(b, "settings.json"), "utf8"), '{"v":1}');
});

test("review: slow streamed bodies have a deadline even when cancellation never settles", async () => {
  const { readSyncJson } = await jiti.import("./sync-http.ts");
  const stream = new ReadableStream({ start() {}, cancel() { return new Promise(() => {}); } });
  await assert.rejects(readSyncJson(new Response(stream), 1024, 20), /timed out/);
});

test("review: interrupted journal does not overwrite a competing edit during recovery", async (t) => {
  const [a, b] = dirs(t);
  writeFileSync(join(a, "settings.json"), '{"v":1}');
  await copy(a, b);
  writeFileSync(join(a, "settings.json"), '{"v":2}');
  const remote = await protocol.createSyncSnapshot(a);
  await config.updateSyncConfig((state) => { state.pendingWrites = [{ path: "settings.json", version: remote.files["settings.json"] }]; }, b);
  writeFileSync(join(b, "settings.json"), '{"v":"local"}');
  const recovered = await protocol.createSyncSnapshot(b);
  assert.equal(readFileSync(join(b, "settings.json"), "utf8"), '{"v":"local"}');
  assert.equal(recovered.files["settings.json"].sourceNodeId, recovered.node.id);
});

test("review: staged registration rollback only deletes its own generation", async (t) => {
  const [a, b] = dirs(t);
  const peer = (await config.readSyncConfig(b)).node;
  const staged = await config.stageSyncNode({ ...peer, name: "B", url: "https://b.example", password: "test-password" }, a);
  await config.removeSyncNode(peer.id, a);
  await config.addSyncNode({ ...peer, name: "new registration", url: "https://b.example", password: "new-password" }, a);
  assert.equal(await staged.rollback(), false);
  assert.equal((await config.readSyncConfig(a)).nodes[0].name, "new registration");
});

test("review: inbound path depth cannot create a tree the local scanner refuses", async (t) => {
  const [a, b] = dirs(t);
  const remote = await protocol.createSyncSnapshot(a);
  const path = `extensions/${"a/".repeat(66)}file.txt`;
  entry(remote, path, "data");
  await assert.rejects(protocol.reconcileSnapshot(remote, b), /path/);
  assert.equal(existsSync(join(b, "extensions")), false);
});

test("review: serialized snapshot metadata must fit the encrypted transport before writes", async (t) => {
  const [a, b] = dirs(t);
  const remote = await protocol.createSyncSnapshot(a);
  const common = `${"a".repeat(230)}/${"b".repeat(230)}/${"c".repeat(230)}/${"d".repeat(230)}`;
  for (let i = 0; i < 3000; i++) entry(remote, `extensions/${common}/file-${i}.txt`, "x".repeat(4000));
  assert.ok(Buffer.byteLength(JSON.stringify(remote)) < 24 * 1024 * 1024);
  mkdirSync(join(b, "extensions"));
  writeFileSync(join(b, "extensions", "local.txt"), Buffer.alloc(4 * 1024 * 1024));
  await assert.rejects(protocol.reconcileSnapshot(remote, b), /size limit/);
  assert.equal(existsSync(join(b, "extensions", "a".repeat(230))), false);
});

test("review: wire-size preflight cannot spend savings from a deletion that may be skipped", async (t) => {
  const [a, b] = dirs(t);
  mkdirSync(join(b, "extensions"));
  writeFileSync(join(b, "extensions", "local.txt"), Buffer.alloc(4 * 1024 * 1024));
  const local = await protocol.createSyncSnapshot(b);
  const remote = await protocol.createSyncSnapshot(a);
  const common = `${"a".repeat(230)}/${"b".repeat(230)}/${"c".repeat(230)}/${"d".repeat(230)}`;
  for (let i = 0; i < 3000; i++) entry(remote, `extensions/${common}/file-${i}.txt`, "x".repeat(4000));
  remote.files["extensions/local.txt"] = { deleted: true, sourceNodeId: remote.node.id,
    updatedAt: new Date(Date.parse(local.files["extensions/local.txt"].updatedAt) + 1000).toISOString(), revision: 2, mtimeMs: Date.now() };
  assert.ok(Buffer.byteLength(JSON.stringify(remote)) < 24 * 1024 * 1024);
  // No deletion is allowed to fund growth before the per-file CAS succeeds.
  await assert.rejects(protocol.reconcileSnapshot(remote, b), /size limit/);
  assert.equal(existsSync(join(b, "extensions", "a".repeat(230))), false);
});
