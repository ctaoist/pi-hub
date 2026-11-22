/** Real WSS, distinct processes and private agent dirs. Requires openssl. */
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { createServer } from "node:https";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const filename = fileURLToPath(import.meta.url);
if (process.argv.includes("--worker")) {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { alias: { "@": resolve(".") } });
  const transport = await jiti.import("../lib/sync-socket.ts");
  const config = await jiti.import("../lib/sync-config.ts");
  const server = createServer({ key: readFileSync(process.env.TEST_KEY), cert: readFileSync(process.env.TEST_CERT) }, (_req, res) => { res.writeHead(404); res.end(); });
  server.on("upgrade", (req, socket, head) => transport.handleSyncUpgrade(req, socket, head));
  let leaked = false;
  const frames = [];
  const { SyncChannel } = await jiti.import("../lib/sync-channel.ts");
  const sendFrame = SyncChannel.prototype.send;
  SyncChannel.prototype.send = function (value) {
    frames.push({ type: value.type, paths: Object.keys(value.delta?.contents ?? {}), bytes: Buffer.byteLength(JSON.stringify(value)) });
    if (frames.length > 1000) frames.shift();
    return sendFrame.call(this, value);
  };
  // Inspect the WS payloads, not TLS ciphertext. Configuration and passwords
  // must remain encrypted even at the TLS termination/application boundary.
  const { default: WebSocket } = await import("ws");
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data, ...args) {
    const text = String(data);
    if (text.includes("WSS-PRIVATE-TOKEN") || text.includes(process.env.PI_WEB_PASSWORD)) leaked = true;
    return send.call(this, data, ...args);
  };
  transport.startSyncScheduler();
  server.listen(Number(process.env.TEST_PORT || 0), "127.0.0.1", () => process.send({ port: server.address().port }));
  process.on("message", async ({ id, action, body }) => {
    try {
      let result;
      if (action === "connect") result = await transport.connectSyncNode(body);
      if (action === "state") result = await config.readPublicSyncState();
      if (action === "frames") result = frames.splice(0);
      if (action === "enable") { await config.setSyncOptions({ enabled: body }); (await jiti.import("../lib/sync-watch.ts")).notifySyncScopeChanged(process.env.PI_CODING_AGENT_DIR); }
      if (action === "remove") await config.removeSyncNode(body);
      if (action === "disable-node") await config.setSyncNodeEnabled(body, false);
      if (action === "enable-node") await config.setSyncNodeEnabled(body, true);
      if (action === "policy") { await config.setSyncOptions(body); (await jiti.import("../lib/sync-watch.ts")).notifySyncScopeChanged(process.env.PI_CODING_AGENT_DIR); }
      if (action === "refresh") await transport.refreshSyncConnections();
      process.send({ id, ok: true, result, leaked });
    } catch (error) { process.send({ id, ok: false, message: error.message }); }
  });
  process.on("SIGTERM", () => { transport.stopSyncScheduler(); server.closeAllConnections(); server.close(() => process.exit(0)); });
} else {
  const root = mkdtempSync(join(tmpdir(), "pi-sync-wss-"));
  const key = join(root, "key.pem"), cert = join(root, "cert.pem");
  const children = new Set(); let seq = 0;
  const start = (dir, password, port) => new Promise((ready, reject) => {
    const child = fork(filename, ["--worker"], { env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_WEB_PASSWORD: password,
      PI_WEB_DISABLE_SYNC: "0", NODE_EXTRA_CA_CERTS: cert, TEST_KEY: key, TEST_CERT: cert, TEST_PORT: String(port || 0) }, silent: true });
    children.add(child); child.stdout.resume(); child.stderr.resume();
    const timer = setTimeout(() => reject(new Error("Worker startup timeout")), 20_000);
    child.once("message", ({ port }) => { clearTimeout(timer); ready({ child, port, password, dir }); });
    child.once("error", reject); child.once("exit", () => { clearTimeout(timer); reject(new Error("Worker exited")); });
  });
  const command = (worker, action, body) => new Promise((done, reject) => {
    const id = ++seq;
    const listener = (data) => { if (data.id === id) { clearTimeout(timer); worker.child.off("message", listener); done(data); } };
    const timer = setTimeout(() => { worker.child.off("message", listener); reject(new Error("Command timeout: " + action)); }, 20_000);
    worker.child.on("message", listener); worker.child.send({ id, action, body });
  });
  async function stop(worker) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
    await new Promise((done) => {
      const timer = setTimeout(() => worker.child.kill("SIGKILL"), 3000);
      worker.child.once("exit", () => { clearTimeout(timer); children.delete(worker.child); done(); }); worker.child.kill("SIGTERM");
    });
  }
  const until = async (condition, timeout = 45_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await condition()) return; await new Promise((r) => setTimeout(r, 200)); }
    assert.fail("Synchronization did not converge before deadline");
  };
  const content = (dir, file) => existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : undefined;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
    const aDir = join(root, "a"), bDir = join(root, "b"); mkdirSync(aDir); mkdirSync(bDir);
    const a = await start(aDir, randomBytes(24).toString("hex"));
    let b = await start(bDir, randomBytes(24).toString("hex"));
    // A's address/password are NEVER passed to B. Only B needs a reachable URL.
    const connected = await command(a, "connect", { name: "B", url: `https://127.0.0.1:${b.port}`, password: b.password });
    assert.equal(connected.ok, true, connected.message);
    const bid = connected.result.id;
    const bState = (await command(b, "state")).result;
    assert.equal(bState.nodes.length, 1); assert.equal(bState.nodes[0].direction, "inbound");
    assert.equal(bState.nodes[0].hasCredential, false); assert.equal(bState.nodes[0].url, undefined);
    const aid = bState.nodes[0].id;
    assert.equal(readFileSync(join(bDir, "sync.json"), "utf8").includes(a.password), false);
    for (const node of [a, b]) assert.equal((await command(node, "enable", true)).ok, true);
    writeFileSync(join(aDir, "auth.json"), '{"token":"WSS-PRIVATE-TOKEN"}');
    writeFileSync(join(bDir, "settings.json"), '{"theme":"dark"}');
    await until(() => content(bDir, "auth.json") === content(aDir, "auth.json") && content(aDir, "settings.json") === '{"theme":"dark"}', 12_000);
    assert.equal((await command(a, "state")).leaked, false); assert.equal((await command(b, "state")).leaked, false);
    const probe = (headers, trusted = true) => new Promise((done) => {
      const ws = new WebSocket(`wss://127.0.0.1:${b.port}/api/sync/socket`, { headers, ...(trusted ? { ca: readFileSync(cert) } : {}), handshakeTimeout: 3000 });
      ws.on("error", () => done("tls-error"));
      ws.on("unexpected-response", (_req, response) => { const status = response.statusCode; response.destroy(); ws.terminate(); done(status); });
      ws.on("message", () => { ws.terminate(); done(101); });
    });
    const authorization = `Basic ${Buffer.from(`pi:${b.password}`).toString("base64")}`;
    assert.equal(await probe({ authorization }, false), "tls-error");
    assert.equal(await probe({}), 401);
    assert.equal(await probe({ authorization, origin: "https://evil.example", "sec-fetch-site": "cross-site" }), 403);
    assert.equal(await probe({ authorization, host: "evil.example" }), 403);
    // Settle initial relays, then prove quiet links carry no application rounds.
    await new Promise((r) => setTimeout(r, 2500));
    await command(a, "frames"); await command(b, "frames");
    await new Promise((r) => setTimeout(r, 1800));
    assert.deepEqual((await command(a, "frames")).result, []);
    assert.deepEqual((await command(b, "frames")).result, []);
    // One burst = one changed file body, with no unchanged credential body.
    for (const theme of ["one", "two", "light"]) writeFileSync(join(bDir, "settings.json"), JSON.stringify({ theme }));
    await until(() => content(aDir, "settings.json") === '{"theme":"light"}', 8000);
    await new Promise((r) => setTimeout(r, 1800));
    const traffic = [...(await command(a, "frames")).result, ...(await command(b, "frames")).result];
    assert.deepEqual(traffic.flatMap((frame) => frame.paths), ["settings.json"]);
    assert.ok(traffic.length <= 12, "events coalesce without ping-pong rounds");
    const port = b.port, password = b.password;
    await stop(b);
    writeFileSync(join(aDir, "models.json"), '{"providers":{}}');
    b = await start(bDir, password, port);
    await until(() => content(bDir, "models.json") === '{"providers":{}}');
    rmSync(join(bDir, "settings.json"));
    await until(() => !existsSync(join(aDir, "settings.json")), 8000);
    // Third node joins B; membership and login credentials are not relayed.
    const cDir = join(root, "c"); mkdirSync(cDir);
    const c = await start(cDir, randomBytes(24).toString("hex"));
    const joined = await command(c, "connect", { name: "B", url: `https://127.0.0.1:${b.port}`, password: b.password });
    assert.equal(joined.ok, true, joined.message);
    await command(c, "enable", true);
    await until(() => content(cDir, "auth.json") === '{"token":"WSS-PRIVATE-TOKEN"}');
    assert.equal((await command(c, "state")).result.nodes.length, 1);
    writeFileSync(join(cDir, "models-store.json"), '{}');
    await until(() => content(aDir, "models-store.json") === '{}', 12_000);
    // B is the authority; both inbound clients resolve to its version.
    await command(b, "policy", { conflictStrategy: "authority", authorityNodeId: bid });
    writeFileSync(join(cDir, "auth.json"), '{"token":"WSS-PRIVATE-TOKEN-C"}');
    await until(() => content(cDir, "auth.json") === '{"token":"WSS-PRIVATE-TOKEN"}');
    assert.equal((await command(c, "state")).leaked, false);
    await command(b, "disable-node", aid); await command(b, "refresh");
    writeFileSync(join(aDir, "models.json"), '{"providers":{"paused":true}}');
    await new Promise((r) => setTimeout(r, 6500));
    assert.equal(content(bDir, "models.json"), '{"providers":{}}');
    await command(b, "enable-node", aid);
    await until(() => content(aDir, "models.json") === '{"providers":{}}');
    assert.equal((await command(b, "remove", aid)).ok, true);
    assert.equal((await command(b, "refresh")).ok, true);
    writeFileSync(join(aDir, "models.json"), '{"providers":{"blocked":true}}');
    await new Promise((r) => setTimeout(r, 7000));
    assert.equal(content(bDir, "models.json"), '{"providers":{}}');
    assert.equal((await command(b, "state")).result.nodes.some((node) => node.id === aid), false);
    assert.equal(await probe({ authorization: "Basic cGk6d3Jvbmc=" }), 401);
    assert.equal(await probe({ authorization }), 429);
    assert.equal((await command(a, "state")).result.nodes[0].id, bid);
    console.log("PASS: event-triggered three-node WSS, <8s edits/deletion, quiet idle, coalesced burst, unchanged bodies not resent, relay/authority, TLS/auth, reconnect, pause/resume/removal");
  } finally { await Promise.all([...children].map((child) => stop({ child }))); rmSync(root, { recursive: true, force: true }); }
}
