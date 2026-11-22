import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";
const root = mkdtempSync(join(tmpdir(), "pi-review-audit-"));
const cwd = join(root, "project"); mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PI_OFFLINE = "1";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const store = await jiti.import("./skill-evolution-store.ts");
const service = await jiti.import("./skill-evolution-service.ts");
const protection = await jiti.import("./skill-protection.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts"); allowFileRoot(cwd);
const { readReviewSourceFile } = await jiti.import("./skill-review-source.ts");
const { POST } = await jiti.import("../app/api/skills/evolution/route.ts");
const { POST: protect } = await jiti.import("../app/api/skills/protection/route.ts");
const config = { enabled: true, provider: "test", modelId: "test", thinkingLevel: "off" };
const evidence = [{ id: "e", text: "Verified", sessionId: "s", leafId: "l", at: 1 }];
after(() => rmSync(root, { recursive: true, force: true }));

test("AUDIT: disabling persists cancellation for automatic runs owned by another process", async () => {
  await store.withEvolutionState((s) => {
    s.projects[cwd] = { ...store.emptyReviewProject(), config, turns: evidence,
      runs: [{ id: "remote", config, startedAt: 1, status: "running", evidence, candidates: [], manual: false },
        { id: "manual", config, startedAt: 1, status: "running", evidence, candidates: [], manual: true }] };
  });
  await service.configureReview(cwd, { ...config, enabled: false });
  const runs = store.readEvolutionState().projects[cwd].runs;
  assert.equal(runs[0].cancelRequested, true);
  assert.equal(runs[1].cancelRequested, undefined);
  await store.withEvolutionState((s) => { s.projects[cwd].config.enabled = true; });
  assert.equal(store.readEvolutionState().projects[cwd].runs[0].cancelRequested, true, "re-enabling never revives cancelled work");
});
test("AUDIT: damaged optional review state does not break ordinary skill discovery", () => {
  const filePath = join(cwd, "SKILL.md"); writeFileSync(filePath, "rules");
  const saved = readFileSync(store.evolutionStatePath(), "utf8");
  try {
    writeFileSync(store.evolutionStatePath(), "damaged");
    const result = protection.annotateSkillProtection([{ filePath, sourceInfo: { source: "auto" } }]);
    assert.equal(result[0].protection.locked, true);
    assert.equal(result[0].protection.unavailable, true);
    assert.equal(readFileSync(store.evolutionStatePath(), "utf8"), "damaged");
  } finally { writeFileSync(store.evolutionStatePath(), saved); }
});
test("AUDIT: dangling private state must not silently clear lock policy", { skip: process.platform === "win32" }, () => {
  const path = store.evolutionStatePath(); const saved = readFileSync(path, "utf8");
  try {
    rmSync(path); symlinkSync(join(root, "missing"), path);
    assert.throws(() => store.readEvolutionState(), /damaged|state/i);
  } finally { rmSync(path); writeFileSync(path, saved); }
});
test("AUDIT: source reads reject FIFOs, oversized and malformed files without source writes", { skip: process.platform === "win32" }, () => {
  const path = join(root, "source.jsonl");
  execFileSync("mkfifo", [path]);
  assert.throws(() => readReviewSourceFile(path, cwd), /regular file/);
  rmSync(path); writeFileSync(path, "");
  assert.throws(() => readReviewSourceFile(path, cwd), /empty/);
  assert.equal(readFileSync(path, "utf8"), "");
  writeFileSync(path, "x".repeat(32 * 1024 * 1024 + 1));
  assert.throws(() => readReviewSourceFile(path, cwd), /larger/);
  writeFileSync(path, '{"type":"session","version":3,"id":"id","cwd":"/tmp"}\n{bad');
  assert.throws(() => readReviewSourceFile(path, cwd), /damaged/);
});
test("AUDIT: source graph rejects cycles and wrong project headers before SDK traversal", () => {
  const path = join(root, "graph.jsonl");
  const header = { type: "session", version: 3, id: "s", cwd, timestamp: new Date().toISOString() };
  writeFileSync(path, [header, { type: "message", id: "loop", parentId: "loop", message: { role: "user", content: "x" } }].map(JSON.stringify).join("\n"));
  assert.throws(() => readReviewSourceFile(path, cwd), /graph/);
  writeFileSync(path, JSON.stringify({ ...header, cwd: root }));
  assert.throws(() => readReviewSourceFile(path, cwd), /project/);
});
test("AUDIT: chunked oversized request stops reading at its cap", async () => {
  for (const [handler, chunkBytes] of [[POST, 16384], [protect, 256 * 1024]]) {
    let pulls = 0, cancelled = false;
    const body = new ReadableStream({ pull(controller) {
      pulls++;
      if (pulls <= 100) controller.enqueue(new Uint8Array(chunkBytes)); else controller.close();
    }, cancel() { cancelled = true; } });
    const response = await handler(new Request("http://localhost/api/skills/evolution", { method: "POST", body, duplex: "half" }));
    assert.equal(response.status, 413);
    assert.ok(pulls < 5, `Read ${pulls} chunks before applying body limit`);
    assert.equal(cancelled, true);
  }
});
