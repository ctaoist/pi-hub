import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { createJiti } = await import("jiti");
const {
  addSyncNode,
  normalizeNodeUrl,
  readPublicSyncState,
  readSyncConfig,
  removeSyncNode,
  setSyncOptions,
} = await createJiti(import.meta.url).import("./sync-config.ts");

test("normalizes HTTPS origins and rejects credentials or non-HTTPS URLs", () => {
  assert.equal(normalizeNodeUrl("https://node.example:443/"), "https://node.example");
  assert.throws(() => normalizeNodeUrl("http://node.example"));
  assert.throws(() => normalizeNodeUrl("https://pi:secret@node.example"));
  assert.throws(() => normalizeNodeUrl("https://node.example/path"));
});

test("stores node credentials encrypted and never returns them publicly", async (t) => {
  const previous = process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_PASSWORD = "test-password";
  t.after(() => { if (previous === undefined) delete process.env.PI_WEB_PASSWORD; else process.env.PI_WEB_PASSWORD = previous; });
  const agentDir = mkdtempSync(join(tmpdir(), "pi-sync-config-"));
  try {
    const node = await addSyncNode({
      name: "Laptop",
      url: "https://laptop.example/",
      platform: "macos",
      password: "remote-password",
    }, agentDir);
    assert.equal(node.name, "Laptop");
    assert.equal("credential" in node, false);
    const rawConfig = readFileSync(join(agentDir, "sync.json"), "utf8");
    assert.equal(rawConfig.includes("remote-password"), false);
    assert.equal(rawConfig.includes("credential"), true);

    await setSyncOptions({ enabled: true, conflictStrategy: "authority", authorityNodeId: node.id }, agentDir);
    const state = await readPublicSyncState(agentDir);
    assert.equal(state.config.enabled, true);
    assert.equal(state.config.conflictStrategy, "authority");
    assert.equal(state.config.authorityNodeId, node.id);
    assert.equal(state.nodes[0].hasCredential, true);

    assert.equal(await removeSyncNode(node.id, agentDir), true);
    assert.equal((await readSyncConfig(agentDir)).nodes.length, 0);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
