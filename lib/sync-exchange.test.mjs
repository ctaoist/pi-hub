import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const config = await jiti.import("./sync-config.ts");
const protocol = await jiti.import("./sync-protocol.ts");
const { SyncExchange } = await jiti.import("./sync-exchange.ts");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) { const end = Date.now() + 6000; while (Date.now() < end) { if (check()) return; await wait(20); } assert.fail("exchange did not converge"); }
test("coordinator retries an omitted authority body and retains a dirty event during the round", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-exchange-test-"));
  const a = join(root, "a"), b = join(root, "b"); mkdirSync(a); mkdirSync(b);
  const password = process.env.PI_WEB_PASSWORD; process.env.PI_WEB_PASSWORD = "test-password";
  let client, server;
  t.after(() => { client?.close(); server?.close(); rmSync(root, { recursive: true, force: true }); if (password === undefined) delete process.env.PI_WEB_PASSWORD; else process.env.PI_WEB_PASSWORD = password; });
  const aid = (await config.readSyncConfig(a)).node.id, bid = (await config.readSyncConfig(b)).node.id;
  for (const [dir, peerId] of [[a, bid], [b, aid]]) {
    await config.registerInboundSyncNode({ id: peerId, connectionId: "test-link", name: "Peer", platform: "linux" }, dir);
    await config.setSyncOptions({ enabled: true }, dir);
    writeFileSync(join(dir, "settings.json"), '{"v":"authority"}');
  }
  await config.setSyncOptions({ conflictStrategy: "authority", authorityNodeId: aid }, a);
  await protocol.reconcileSnapshot(await protocol.createSyncSnapshot(a), b);
  const frames = []; let interfered = false, failed = false, synced = 0;
  const channel = (toClient) => ({ send: async (value) => {
    frames.push(structuredClone(value));
    if (value.type === "delta" && !interfered) {
      interfered = true;
      assert.deepEqual(value.delta.contents, {});
      writeFileSync(join(b, "settings.json"), '{"v":"concurrent"}');
      server.changed(); // event that crosses a pending message
    }
    queueMicrotask(() => (toClient ? client : server).receive(structuredClone(value)));
  } });
  const common = { connectionId: "test-link", allowed: async () => true, synced: async () => { synced++; }, fail: () => { failed = true; } };
  server = new SyncExchange({ ...common, server: true, agentDir: b, peerId: aid, channel: channel(true) });
  client = new SyncExchange({ ...common, server: false, agentDir: a, peerId: bid, channel: channel(false) });
  await until(() => synced >= 2 && readFileSync(join(b, "settings.json"), "utf8") === '{"v":"authority"}');
  assert.equal(failed, false);
  assert.ok(frames.some((frame) => frame.type === "retry"));
  assert.ok(frames.some((frame) => frame.type === "delta" && Object.hasOwn(frame.delta.contents, "settings.json")));
  await wait(1200); const settled = frames.length; await wait(800); assert.equal(frames.length, settled);
});
