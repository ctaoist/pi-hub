import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const { getSyncAgentDir, getSyncPlatform, syncScopeDescription, listSyncFiles, resolveSyncFilePath, isSyncPathAllowed } = await import("./sync-scope.ts");

test("uses the configured agent directory and a platform-neutral scope", () => {
  assert.equal(getSyncAgentDir({ PI_CODING_AGENT_DIR: join(tmpdir(), "pi agent") }), resolve(tmpdir(), "pi agent"));
  assert.equal(getSyncAgentDir({ PI_CODING_AGENT_DIR: "~/pi-agent" }).endsWith(join("pi-agent")), true);
  assert.equal(getSyncPlatform("win32"), "windows");
  assert.equal(getSyncPlatform("darwin"), "macos");
  assert.equal(getSyncPlatform("linux"), "linux");
  assert.deepEqual(syncScopeDescription(), [
    "auth.json", "settings.json", "models.json", "models-store.json",
    "extensions/", "skills/", "prompts/", "themes/",
  ]);
});

test("lists only allowed files and refuses dependency, runtime, and escaping symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sync-scope-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-sync-outside-"));
  try {
    mkdirSync(join(root, "extensions", "nested"), { recursive: true });
    mkdirSync(join(root, "node_modules", "bad"), { recursive: true });
    mkdirSync(join(root, "sessions"), { recursive: true });
    mkdirSync(join(root, "plugins"), { recursive: true });
    writeFileSync(join(root, "auth.json"), "secret");
    writeFileSync(join(root, "extensions", "nested", "index.js"), "export {};");
    writeFileSync(join(root, "node_modules", "bad", "index.js"), "bad");
    writeFileSync(join(root, "sessions", "one.jsonl"), "session");
    writeFileSync(join(root, "plugins", "ignored.json"), "ignored");
    writeFileSync(join(outside, "leak.txt"), "outside");
    symlinkSync(join(outside, "leak.txt"), join(root, "extensions", "leak.txt"));

    assert.deepEqual(listSyncFiles(root).map((entry) => entry.path), ["auth.json", "extensions/nested/index.js"]);
    assert.equal(resolveSyncFilePath("auth.json", root), join(root, "auth.json"));
    assert.equal(resolveSyncFilePath("extensions/nested/index.js", root), join(root, "extensions", "nested", "index.js"));
    assert.equal(resolveSyncFilePath("../leak.txt", root), null);
    assert.equal(resolveSyncFilePath("node_modules/bad/index.js", root), null);
    assert.equal(resolveSyncFilePath("plugins/ignored.json", root), null);
    assert.equal(isSyncPathAllowed("models.json"), true);
    assert.equal(isSyncPathAllowed("mcp-auth.json"), false);
    for (const path of ["C:\\Windows\\auth.json", "extensions\\a.ts", "extensions/../auth.json", "extensions/con.txt", "extensions/a. ", "extensions/a:stream", "extensions/.git/config", "extensions/index.ts.tmp", "sync.key", "sync.json"]) {
      assert.equal(resolveSyncFilePath(path, root), null, path);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
