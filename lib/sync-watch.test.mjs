import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { watchSyncScope } = await jiti.import("./sync-watch.ts");
const { readSyncConfig } = await jiti.import("./sync-config.ts");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, timeout = 5000) { const end = Date.now() + timeout; while (Date.now() < end) { if (check()) return; await wait(30); } assert.fail("watch event was not observed"); }
function dir(t) { const root = mkdtempSync(join(tmpdir(), "pi-watch-test-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
test("scope watcher debounces atomic saves, sees new directories/deletion, ignores excluded data", async (t) => {
  const root = dir(t); await readSyncConfig(root);
  let changed = 0;
  const close = watchSyncScope(root, () => changed++); t.after(close);
  await until(() => changed === 1); await wait(500);
  mkdirSync(join(root, "sessions")); writeFileSync(join(root, "sessions", "x.jsonl"), "private session");
  writeFileSync(join(root, "sync.key.tmp"), "not synced");
  await wait(700); assert.equal(changed, 1);
  for (let i = 0; i < 4; i++) { writeFileSync(join(root, ".settings.tmp"), JSON.stringify({ i })); renameSync(join(root, ".settings.tmp"), join(root, "settings.json")); }
  await until(() => changed === 2); await wait(600); assert.equal(changed, 2);
  mkdirSync(join(root, "prompts", "new"), { recursive: true }); writeFileSync(join(root, "prompts", "new", "a.md"), "a");
  await until(() => changed === 3);
  writeFileSync(join(root, "prompts", "new", "a.md"), "b"); await until(() => changed === 4);
  rmSync(join(root, "prompts", "new"), { recursive: true }); await until(() => changed === 5);
  rmSync(join(root, "prompts"), { recursive: true });
  mkdirSync(join(root, "prompts")); writeFileSync(join(root, "prompts", "recreated.md"), "new inode");
  await until(() => changed === 6);
  writeFileSync(join(root, "prompts", "recreated.md"), "still watched"); await until(() => changed === 7);
  close(); writeFileSync(join(root, "settings.json"), '{}'); await wait(500); assert.equal(changed, 7);
});
test("watch audit requests reconciliation without metadata-trigger loops or symlink following", async (t) => {
  const root = dir(t), outside = dir(t); await readSyncConfig(root);
  mkdirSync(join(root, "prompts"));
  symlinkSync(outside, join(root, "prompts", "link"), "dir");
  let count = 0;
  const close = watchSyncScope(root, () => count++, 1400); t.after(close);
  await until(() => count === 1);
  writeFileSync(join(outside, "hidden.md"), "outside"); await wait(600); assert.equal(count, 1);
  await until(() => count === 2); close();
});
