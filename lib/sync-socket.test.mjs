import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const config = await jiti.import("./sync-config.ts");
const protocol = await jiti.import("./sync-protocol.ts");
function dir(t) { const path = mkdtempSync(join(tmpdir(), "pi-wss-unit-")); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
test("inbound registration stores neither reverse URL nor credential and never re-enables disabled nodes", async (t) => {
  const path = dir(t);
  await config.registerInboundSyncNode({ id: "client", connectionId: "one", name: "Client", platform: "linux" }, path);
  const value = await config.readSyncConfig(path);
  assert.equal(value.nodes[0].direction, "inbound"); assert.equal(value.nodes[0].credential, undefined); assert.equal(value.nodes[0].url, undefined);
  await config.setSyncNodeEnabled("client", false, path);
  await assert.rejects(config.registerInboundSyncNode({ id: "client", connectionId: "two", name: "Client", platform: "linux" }, path), /disabled/);
  assert.equal((await config.readSyncConfig(path)).nodes[0].enabled, false);
});
test("connection generation prevents an old socket writing after removal and re-registration", async (t) => {
  const a = dir(t), b = dir(t), oldPassword = process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_PASSWORD = "test-password";
  t.after(() => { if (oldPassword === undefined) delete process.env.PI_WEB_PASSWORD; else process.env.PI_WEB_PASSWORD = oldPassword; });
  const peer = (await config.readSyncConfig(a)).node;
  await config.registerInboundSyncNode({ ...peer, connectionId: "old" }, b);
  await config.setSyncOptions({ enabled: true }, b);
  writeFileSync(join(a, "auth.json"), '{"token":"private"}');
  const snapshot = await protocol.createSyncSnapshot(a);
  await config.removeSyncNode(peer.id, b);
  await config.registerInboundSyncNode({ ...peer, connectionId: "new" }, b);
  await assert.rejects(protocol.reconcileSnapshot(snapshot, b, peer.id, "old"), /disabled/);
  await protocol.reconcileSnapshot(snapshot, b, peer.id, "new");
  assert.equal(readFileSync(join(b, "auth.json"), "utf8"), '{"token":"private"}');
});
test("legacy outgoing records load, but inbound records cannot be used to dial a reverse login", async (t) => {
  const path = dir(t);
  await config.addSyncNode({ id: "legacy", name: "Legacy", url: "https://old.example", password: "secret", platform: "linux" }, path);
  const filename = join(path, "sync.json"), value = JSON.parse(readFileSync(filename, "utf8"));
  delete value.nodes[0].direction; delete value.nodes[0].connectionId;
  writeFileSync(filename, JSON.stringify(value));
  const legacy = (await config.readSyncConfig(path)).nodes[0];
  assert.equal(legacy.direction, "outbound"); assert.equal(legacy.connectionId, "legacy");
  await assert.rejects(config.registerInboundSyncNode({ id: "legacy", name: "Legacy", platform: "linux", connectionId: "new" }, path), /already configured/);
  await config.removeSyncNode("legacy", path);
  await config.registerInboundSyncNode({ id: "legacy", name: "Legacy", platform: "linux", connectionId: "new" }, path);
  await assert.rejects(config.decryptNodePassword((await config.readSyncConfig(path)).nodes[0], path), /no login credential/);
});
