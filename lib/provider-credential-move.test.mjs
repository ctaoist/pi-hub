import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { moveStoredCredential } = await jiti.import("./provider-credential-store.ts");

async function withAuthFile(data, run) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-credential-move-"));
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    await run(authPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const read = async (authPath) => JSON.parse(await readFile(authPath, "utf8"));

test("a renamed provider's credential follows it and keeps other providers", async () => {
  await withAuthFile({
    "old-gateway": { type: "api_key", key: "sk-moved" },
    openai: { type: "api_key", key: "sk-openai" },
  }, async (authPath) => {
    assert.equal(await moveStoredCredential("old-gateway", "new-gateway", authPath), true);
    assert.deepEqual(await read(authPath), {
      "new-gateway": { type: "api_key", key: "sk-moved" },
      openai: { type: "api_key", key: "sk-openai" },
    });
  });
});

test("a credential typed for the renamed id wins over the moved one", async () => {
  await withAuthFile({
    old: { type: "api_key", key: "sk-stale" },
    new: { type: "api_key", key: "sk-typed" },
  }, async (authPath) => {
    assert.equal(await moveStoredCredential("old", "new", authPath), false);
    assert.deepEqual(await read(authPath), { old: { type: "api_key", key: "sk-stale" }, new: { type: "api_key", key: "sk-typed" } });
  });
});

test("providers without a credential, and no-op renames, change nothing", async () => {
  await withAuthFile({ openai: { type: "api_key", key: "sk-openai" } }, async (authPath) => {
    assert.equal(await moveStoredCredential("missing", "target", authPath), false);
    assert.equal(await moveStoredCredential("openai", "openai", authPath), false);
    assert.equal(await moveStoredCredential("", "target", authPath), false);
    assert.deepEqual(await read(authPath), { openai: { type: "api_key", key: "sk-openai" } });
  });
});
