import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import lockfile from "proper-lockfile";

const jiti = createJiti(import.meta.url);
const config = await jiti.import("./sync-config.ts");
const protocol = await jiti.import("./sync-protocol.ts");
const transport = await jiti.import("./sync-socket.ts");
const http = await jiti.import("./sync-http.ts");
const files = await jiti.import("./sync-files.ts");

function dirs(t, count = 2) {
  const root = mkdtempSync(join(tmpdir(), "pi-sync-protocol-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return Array.from({ length: count }, (_, i) => { const dir = join(root, String(i)); mkdirSync(dir); return dir; });
}
function password(t) {
  const old = process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_PASSWORD = "test-web-password";
  t.after(() => { if (old === undefined) delete process.env.PI_WEB_PASSWORD; else process.env.PI_WEB_PASSWORD = old; });
}
async function connect(a, b) {
  const ca = await config.readSyncConfig(a), cb = await config.readSyncConfig(b);
  await config.addSyncNode({ ...cb.node, url: "https://b.example", password: "test-web-password" }, a);
  await config.addSyncNode({ ...ca.node, url: "https://a.example", password: "test-web-password" }, b);
  await config.setSyncOptions({ enabled: true }, a);
  await config.setSyncOptions({ enabled: true }, b);
  return [ca.node.id, cb.node.id];
}
async function exchange(a, b) {
  const sa = await protocol.createSyncSnapshot(a);
  const sb = await protocol.reconcileSnapshot(sa, b);
  return protocol.reconcileSnapshot(sb, a);
}

test("two-way snapshots converge, retain origin and propagate deletion tombstones", async (t) => {
  const [a, b] = dirs(t);
  writeFileSync(join(a, "settings.json"), '{"theme":"dark"}');
  writeFileSync(join(b, "auth.json"), '{"provider":{"key":"never-log-me"}}');
  await exchange(a, b);
  assert.equal(readFileSync(join(b, "settings.json"), "utf8"), '{"theme":"dark"}');
  assert.equal(readFileSync(join(a, "auth.json"), "utf8"), '{"provider":{"key":"never-log-me"}}');
  const first = await protocol.createSyncSnapshot(a);
  const again = await protocol.createSyncSnapshot(a);
  assert.deepEqual(first.files, again.files);
  unlinkSync(join(a, "settings.json"));
  await exchange(a, b);
  assert.equal(existsSync(join(b, "settings.json")), false);
  assert.equal((await protocol.createSyncSnapshot(b)).files["settings.json"].deleted, true);
});

test("time conflicts use observed logical versions, not an untrusted file mtime", async (t) => {
  const [a, b] = dirs(t);
  writeFileSync(join(a, "settings.json"), '{"v":1}');
  await exchange(a, b);
  writeFileSync(join(b, "settings.json"), '{"v":2}');
  await exchange(b, a);
  assert.equal(readFileSync(join(a, "settings.json"), "utf8"), '{"v":2}');
  const state = await config.readSyncConfig(a);
  assert.equal(state.files["settings.json"].revision, 2);
  assert.equal(state.lastDecision.applied, 1);
  assert.equal("contents" in await config.readPublicSyncState(a), false);
  assert.equal("files" in (await config.readPublicSyncState(a)).config, false);
});

test("authority policy propagates first; offline authority never promotes another peer", async (t) => {
  password(t);
  const [a, b, c] = dirs(t, 3);
  const [aid] = await connect(a, b);
  writeFileSync(join(a, "settings.json"), '{"authority":true}');
  await exchange(a, b);
  await config.setSyncOptions({ conflictStrategy: "authority", authorityNodeId: aid }, a);
  await exchange(a, b);
  assert.equal((await config.readSyncConfig(b)).authorityNodeId, aid);
  writeFileSync(join(b, "settings.json"), '{"authority":false}');
  await exchange(b, a);
  assert.equal(readFileSync(join(b, "settings.json"), "utf8"), '{"authority":true}');
  await exchange(b, c);
  assert.equal((await config.readSyncConfig(c)).waitingForAuthority, true);
  assert.equal(existsSync(join(c, "settings.json")), false);
  await config.removeSyncNode(aid, b);
  assert.equal((await config.readSyncConfig(b)).conflictStrategy, "authority");
  assert.equal((await config.readSyncConfig(b)).authorityNodeId, aid);
});

test("validates integrity, size, paths and JSON before applying any file", async (t) => {
  const [a, b] = dirs(t);
  writeFileSync(join(a, "auth.json"), '{"key":"private"}');
  const good = await protocol.createSyncSnapshot(a);
  const altered = structuredClone(good);
  altered.contents["auth.json"] = Buffer.from('{"key":"tampered"}').toString("base64");
  await assert.rejects(protocol.reconcileSnapshot(altered, b), /integrity/);
  assert.equal(existsSync(join(b, "auth.json")), false);
  const escape = structuredClone(good);
  escape.files["../auth.json"] = escape.files["auth.json"];
  await assert.rejects(protocol.reconcileSnapshot(escape, b), /path/);
  const huge = structuredClone(good);
  huge.contents["auth.json"] = "A".repeat(12 * 1024 * 1024);
  await assert.rejects(protocol.reconcileSnapshot(huge, b), /contents/);
  writeFileSync(join(a, "auth.json"), '{"secret":private');
  await assert.rejects(protocol.createSyncSnapshot(a), (error) => !error.message.includes("private"));
});

test("portable collisions and linked replacements are refused, not propagated as deletions", async (t) => {
  const [a, b] = dirs(t);
  assert.throws(() => files.assertPortableSyncPaths(["extensions/Foo/a.ts", "extensions/foo/b.ts"]), /collide/);
  writeFileSync(join(a, "settings.json"), '{}');
  await exchange(a, b);
  unlinkSync(join(a, "settings.json"));
  symlinkSync(join(b, "settings.json"), join(a, "settings.json"));
  await assert.rejects(protocol.createSyncSnapshot(a), /linked/);
  assert.equal((await config.readSyncConfig(a)).files["settings.json"].deleted, undefined);
  assert.equal(readFileSync(join(b, "settings.json"), "utf8"), '{}');
});

test("concurrent local edit while waiting on the SDK file lock survives", async (t) => {
  const [a, b] = dirs(t);
  writeFileSync(join(a, "settings.json"), '{"v":1}');
  await exchange(a, b);
  writeFileSync(join(a, "settings.json"), '{"v":2}');
  const remote = await protocol.createSyncSnapshot(a);
  const release = await lockfile.lock(join(b, "settings.json"));
  const pending = protocol.reconcileSnapshot(remote, b);
  // Yield until reconcile is waiting on settings.json, without blocking its lock retry.
  await new Promise((resolve) => setTimeout(resolve, 60));
  writeFileSync(join(b, "settings.json"), '{"v":"concurrent"}');
  await release();
  await pending;
  assert.equal(readFileSync(join(b, "settings.json"), "utf8"), '{"v":"concurrent"}');
});

test("scheduler is inert without configuration and bounded parser never echoes secrets", async (t) => {
  password(t);
  const [a] = dirs(t, 1);
  await transport.refreshSyncConnections(a);
  assert.equal(existsSync(join(a, "sync.json")), false);
  await assert.rejects(http.readSyncJson(new Response("{private-secret"), 100), /Invalid synchronization JSON/);
  await assert.rejects(http.readSyncJson(new Response("x".repeat(101)), 100), /size limit/);
});
