import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const route = await jiti.import("./route.ts");
const peer = await jiti.import("./peer/route.ts");
const config = await jiti.import("../../../lib/sync-config.ts");
const { proxy } = await jiti.import("../../../proxy.ts");
const { recordAuthSuccess } = await jiti.import("../../../lib/auth-throttle.ts");
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-sync-route-"));
  const old = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_WEB_PASSWORD: process.env.PI_WEB_PASSWORD, PI_WEB_DISABLE_SYNC: process.env.PI_WEB_DISABLE_SYNC };
  process.env.PI_CODING_AGENT_DIR = dir; process.env.PI_WEB_PASSWORD = "test-password"; delete process.env.PI_WEB_DISABLE_SYNC;
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(dir, { recursive: true, force: true }); recordAuthSuccess(); });
  return dir;
}
function request(body, headers = {}) {
  return new Request("http://localhost/api/sync", { method: "POST", headers: { host: "localhost", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
test("inbound nodes expose no address/credential; options, disable and remove return full state", async (t) => {
  setup(t);
  await config.registerInboundSyncNode({ id: "inbound", name: "Laptop", platform: "windows", connectionId: "connection-one" });
  const state = await (await route.GET(new Request("http://localhost/api/sync", { headers: { host: "localhost" } }))).json();
  assert.equal(state.nodes[0].hasCredential, false); assert.equal(state.nodes[0].url, undefined);
  assert.equal(JSON.stringify(state).includes("test-password"), false);
  const enabled = await (await route.POST(request({ action: "options", enabled: true }))).json();
  assert.equal(enabled.config.enabled, true);
  const disabled = await (await route.POST(request({ action: "node-enabled", id: "inbound", enabled: false }))).json();
  assert.equal(disabled.nodes[0].enabled, false);
  const removed = await (await route.POST(request({ action: "remove-node", id: "inbound" }))).json();
  assert.deepEqual(removed.nodes, []); assert.ok(removed.config.node.id);
});
test("existing login proxy protects sync; cross-site and malformed requests fail closed; old registration retired", async (t) => {
  const dir = setup(t); recordAuthSuccess();
  const req = new NextRequest("http://localhost/api/sync", { headers: { host: "localhost" } });
  assert.equal((await proxy(req)).status, 401);
  const authenticated = new NextRequest(req.url, { headers: { host: "localhost", authorization: `Basic ${Buffer.from("pi:test-password").toString("base64")}` } });
  assert.equal((await proxy(authenticated)).headers.get("x-middleware-next"), "1");
  assert.equal((await route.POST(request({ action: "options", enabled: true }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).status, 403);
  assert.equal((await route.POST(request({ action: "options", padding: "x".repeat(17000) }))).status, 413);
  assert.equal((await peer.GET(new Request("http://localhost/api/sync/peer?op=identity", { headers: { host: "localhost" } }))).status, 410);
  // New contract contains no localUrl. Invalid remote URL is rejected before dialing.
  const failed = await route.POST(request({ action: "add-node", name: "B", url: "http://b.example", password: "secret" }));
  assert.equal((await failed.json()).error, "Node URL must use HTTPS");
  writeFileSync(join(dir, "sync.json"), "{private-token");
  const error = await route.GET(new Request("http://localhost/api/sync", { headers: { host: "localhost" } }));
  assert.equal(error.status, 500); assert.equal((await error.text()).includes("private-token"), false);
});
