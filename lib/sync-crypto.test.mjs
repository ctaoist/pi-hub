import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

const { createJiti } = await import("jiti");
const { decryptSyncSecret, encryptSyncSecret, generateSyncKey, encryptSyncPayload, decryptSyncPayload } = await createJiti(import.meta.url).import("./sync-crypto.ts");

test("encrypts sync credentials and authenticates ciphertext", () => {
  const key = generateSyncKey();
  const secret = "node-login-secret-with-symbols-!";
  const encrypted = encryptSyncSecret(secret, key);
  assert.equal(JSON.stringify(encrypted).includes(secret), false);
  assert.equal(decryptSyncSecret(encrypted, key), secret);
  assert.throws(() => decryptSyncSecret(encrypted, randomBytes(32)));
  assert.throws(() => decryptSyncSecret({ ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` }, key));
});

test("payload encryption binds credentials, operation and nonce without exposing file bytes", () => {
  const value = { auth: { provider: { token: "never-expose-this-token" } } };
  const payload = encryptSyncPayload(value, "web-password", "get:nonce-one");
  assert.equal(JSON.stringify(payload).includes("never-expose-this-token"), false);
  assert.deepEqual(decryptSyncPayload(payload, "get:nonce-one", "web-password"), value);
  assert.throws(() => decryptSyncPayload(payload, "post:nonce-one", "web-password"));
  assert.throws(() => decryptSyncPayload(payload, "get:nonce-two", "web-password"));
  assert.throws(() => decryptSyncPayload(payload, "get:nonce-one", "wrong-password"));
  assert.throws(() => decryptSyncPayload({ ...payload, salt: null }, "get:nonce-one", "web-password"));
});
