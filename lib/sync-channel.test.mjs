import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createJiti } from "jiti";
const { SyncChannel } = await createJiti(import.meta.url).import("./sync-channel.ts");
function socket() { return { readyState: 1, bufferedAmount: 0, frames: [], send(value, done) { this.frames.push(Buffer.from(value)); done(); } }; }
test("WSS encrypted frames bind direction, connection and sequence; reject replay/tamper", async () => {
  const key = randomBytes(32).toString("base64url"), a = socket(), b = socket();
  const client = new SyncChannel(a, key, "one", "client"), server = new SyncChannel(b, key, "one", "server");
  await client.send({ token: "private" });
  assert.equal(a.frames[0].includes("private"), false);
  assert.deepEqual(server.receive(a.frames[0]), { token: "private" });
  assert.throws(() => server.receive(a.frames[0]));
  assert.throws(() => new SyncChannel(b, key, "two", "server").receive(a.frames[0]));
  assert.throws(() => new SyncChannel(b, key, "one", "client").receive(a.frames[0]));
  const altered = JSON.parse(a.frames[0]); altered.ciphertext = (altered.ciphertext[0] === "A" ? "B" : "A") + altered.ciphertext.slice(1);
  assert.throws(() => new SyncChannel(b, key, "one", "server").receive(Buffer.from(JSON.stringify(altered))));
  await server.send({ ok: true }); assert.deepEqual(client.receive(b.frames[0]), { ok: true });
});
test("WSS backpressure refuses another large queued message", () => {
  const ws = socket(); ws.bufferedAmount = 2 * 1024 * 1024;
  assert.throws(() => new SyncChannel(ws, randomBytes(32).toString("base64url"), "one", "client").send({}), /backpressured/);
});
