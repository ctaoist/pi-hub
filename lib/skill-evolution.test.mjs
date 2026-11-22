import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-skill-review-test-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_OFFLINE = "1";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const store = await jiti.import("./skill-evolution-store.ts");
const protection = await jiti.import("./skill-protection.ts");
const candidates = await jiti.import("./skill-evolution-candidates.ts");
const { reviewDue, REVIEW_INTERVAL_MS } = await jiti.import("./skill-evolution-types.ts");
const { turnEvidence, redactReviewText } = await jiti.import("./skill-evolution-evidence.ts");
after(() => rmSync(root, { recursive: true, force: true }));
const body = (name, text = "Run checks before reporting success.") => `---\nname: ${name}\ndescription: Reusable validation procedure\n---\n${text}\n`;
function skill(name, source = "auto", install) {
  const dir = join(root, `skill-${name}`); mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md"); writeFileSync(filePath, body(name));
  return { name, description: "Validate", filePath, baseDir: dir, sourceInfo: { source, scope: "user" }, install, disableModelInvocation: false };
}
const evidence = [{ id: "e1", text: "verified", sessionId: "s1", leafId: "leaf1", at: Date.now() }];
const cwd = join(root, "project"); mkdirSync(cwd);

async function propose(s, name = s?.name ?? "new-guide") {
  const skills = s ? candidates.snapshotReviewSkills(protection.annotateSkillProtection([s])) : [];
  return candidates.validateReviewOutput({ summary: "A verified improvement", candidates: [{ target: s ? skills[0].id : null, name,
    reason: "Validated by the completed test", evidenceIds: ["e1"], content: body(name, "Run focused tests, then the full suite.") }] }, cwd, skills, evidence).candidates[0];
}
async function putCandidate(c) {
  await store.withEvolutionState((state) => {
    const project = state.projects[cwd] ??= store.emptyReviewProject();
    project.runs.push({ id: c.id, config: project.config, status: "pending", startedAt: Date.now(), evidence, candidates: [c] });
  });
}

test("reads are side-effect free; external and unknown default locked, local unlocked", () => {
  assert.equal(existsSync(store.evolutionDirectory()), false);
  assert.deepEqual(store.readEvolutionState(), store.emptyEvolutionState());
  assert.equal(existsSync(store.evolutionDirectory()), false);
  assert.equal(protection.defaultSkillLocked(skill("local")), false);
  assert.equal(protection.defaultSkillLocked(skill("installed", "auto", { source: "org/pkg" })), true);
  assert.equal(protection.defaultSkillLocked(skill("package", "npm:pkg")), true);
  assert.equal(protection.defaultSkillLocked(skill("unknown", "mystery")), true);
});

test("every source can be unlocked; aliases share protection and updates keep overrides", async () => {
  for (const source of ["builtin:core", "npm:pkg", "git:repo", "cli", "unknown", "auto", "local"]) {
    const s = skill(`source-${source.replace(/[^a-z]/g, "-")}`, source);
    await protection.setSkillProtection([s], false);
    assert.equal(protection.annotateSkillProtection([s])[0].protection.locked, false);
    writeFileSync(s.filePath, body(s.name, "upstream version changed"));
    assert.equal(protection.annotateSkillProtection([s])[0].protection.locked, false);
    if (process.platform !== "win32") {
      const alias = `${s.filePath}.alias`; symlinkSync(s.filePath, alias);
      assert.equal(protection.annotateSkillProtection([{ ...s, filePath: alias }])[0].protection.locked, false);
    }
    assert.equal(protection.annotateSkillProtection([{ ...s, sourceInfo: { source: "npm:replacement" } }])[0].protection.locked, true);
    await protection.setSkillProtection([s], null);
    assert.equal(protection.annotateSkillProtection([s])[0].protection.overridden, false);
  }
});

test("locked targets and duplicate new names are refused; external unlock enables real approval", async () => {
  const s = skill("external-guide", "npm:external");
  await assert.rejects(propose(s), /locked/);
  await protection.setSkillProtection([s], false);
  const c = await propose(s); await putCandidate(c);
  await candidates.decideReviewCandidate(cwd, c.id, c.id, "approve", async () => [s]);
  assert.equal(readFileSync(s.filePath, "utf8"), c.after);
  await candidates.decideReviewCandidate(cwd, c.id, c.id, "approve", async () => [s]);
  await candidates.decideReviewCandidate(cwd, c.id, c.id, "rollback", async () => [s]);
  assert.equal(readFileSync(s.filePath, "utf8"), c.before);
});

test("locking after generation blocks approval, and later edits block rollback", async () => {
  const s = skill("protect-after"); const c = await propose(s); await putCandidate(c);
  await protection.setSkillProtection([s], true);
  await assert.rejects(candidates.decideReviewCandidate(cwd, c.id, c.id, "approve", async () => [s]), /locked/);
  assert.equal(readFileSync(s.filePath, "utf8"), c.before);
  await protection.setSkillProtection([s], false);
  await candidates.decideReviewCandidate(cwd, c.id, c.id, "approve", async () => [s]);
  writeFileSync(s.filePath, "user edit");
  await assert.rejects(candidates.decideReviewCandidate(cwd, c.id, c.id, "rollback", async () => [s]), /changed/);
  assert.equal(readFileSync(s.filePath, "utf8"), "user edit");
});

test("new skill creation is exclusive; rollback removes only its SKILL.md", async () => {
  const c = await propose(); await putCandidate(c);
  await candidates.decideReviewCandidate(cwd, c.id, c.id, "approve", async () => []);
  assert.equal(readFileSync(c.filePath, "utf8"), c.after);
  const support = join(cwd, ".pi", "skills", c.name, "notes.md"); writeFileSync(support, "keep");
  const s = { name: c.name, filePath: c.filePath, sourceInfo: { source: "auto" } };
  await candidates.decideReviewCandidate(cwd, c.id, c.id, "rollback", async () => [s]);
  assert.equal(existsSync(c.filePath), false); assert.equal(readFileSync(support, "utf8"), "keep");
  assert.throws(() => candidates.newSkillPath(cwd, "../../escape"), /Invalid/);
});

test("symlink destinations for new skills and stale existing targets are refused", async () => {
  if (process.platform === "win32") return;
  const linked = join(root, "linked-project"); mkdirSync(linked); symlinkSync(cwd, join(linked, ".pi"));
  assert.throws(() => candidates.newSkillPath(linked, "safe"), /Unsafe/);
  const s = skill("stale"); const c = await propose(s); await putCandidate(c);
  rmSync(s.filePath); symlinkSync(join(root, "skill-local", "SKILL.md"), s.filePath);
  await assert.rejects(candidates.decideReviewCandidate(cwd, c.id, c.id, "approve", async () => [s]), /discovered|path/);
});

test("write-ahead recovery compares both versions and never silently overwrites conflicts", () => {
  const s = skill("recover");
  const c = { realPath: s.filePath, before: body(s.name), after: body(s.name, "new"), status: "applying" };
  candidates.reconcileCandidate(c); assert.equal(c.status, "pending");
  c.status = "applying"; writeFileSync(s.filePath, c.after);
  candidates.reconcileCandidate(c); assert.equal(c.status, "applied");
  c.status = "reverting"; writeFileSync(s.filePath, "foreign");
  assert.throws(() => candidates.reconcileCandidate(c), /conflicts/);
});

test("schedule is low-frequency, failed/running evidence is not automatically retried", () => {
  const p = store.emptyReviewProject(); p.config = { enabled: true, provider: "p", modelId: "m", thinkingLevel: "low" };
  p.turns = Array.from({ length: 5 }, (_, i) => ({ ...evidence[0], id: String(i), at: 1 }));
  assert.equal(reviewDue(p, REVIEW_INTERVAL_MS + 2), true);
  p.lastAttempt = REVIEW_INTERVAL_MS; assert.equal(reviewDue(p, REVIEW_INTERVAL_MS + 2), false);
  p.lastAttempt = 0;
  for (const status of ["running", "failed", "interrupted"]) {
    p.runs = [{ status, evidence: p.turns }]; assert.equal(reviewDue(p, 100 * REVIEW_INTERVAL_MS), false);
  }
  p.runs = []; p.turns = p.turns.slice(0, 1);
  assert.equal(reviewDue(p, 24 * 60 * 60_000 + 2), true);
  p.config.enabled = false; assert.equal(reviewDue(p, 100 * REVIEW_INTERVAL_MS), false);
});

test("evidence excludes thinking/images and unfinished answers, scrubs common secrets", () => {
  const branch = [
    { id: "user", type: "message", message: { role: "user", content: "Validate" } },
    { id: "answer", type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Tests passed" }] } },
  ];
  const e = turnEvidence("s", branch); assert.match(e.text, /Tests passed/); assert.doesNotMatch(e.text, /private/);
  branch[1].message.stopReason = "aborted"; assert.equal(turnEvidence("s", branch), null);
  assert.doesNotMatch(redactReviewText("password=abc123 Bearer secret-token sk-1234567890123456789"), /abc123|secret-token|123456789/);
});

test("concurrent relock wins before approval when it holds the shared mutation lease", async () => {
  const s = skill("concurrent"); const c = await propose(s); await putCandidate(c);
  let entered; const acquired = new Promise((resolve) => { entered = resolve; });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const relock = store.withEvolutionState(async (state) => {
    state.locks[s.filePath] = { identity: protection.skillIdentity(s), locked: true };
    entered(); await gate;
  });
  await acquired;
  const approval = candidates.decideReviewCandidate(cwd, c.id, c.id, "approve", async () => [s]);
  const refused = assert.rejects(approval, /locked/);
  release(); await relock; await refused;
  assert.equal(readFileSync(s.filePath, "utf8"), c.before);
});

test("missing evidence and new-name duplicates are rejected before staging", async () => {
  const s = skill("no-duplicate", "npm:external");
  const skills = candidates.snapshotReviewSkills(protection.annotateSkillProtection([s]));
  const output = { summary: "test", candidates: [{ target: null, name: s.name, content: body(s.name), reason: "reason", evidenceIds: ["e1"] }] };
  assert.throws(() => candidates.validateReviewOutput(output, cwd, skills, evidence), /already exists/);
  output.candidates[0].name = "other"; output.candidates[0].content = body("other"); output.candidates[0].evidenceIds = ["made-up"];
  assert.throws(() => candidates.validateReviewOutput(output, cwd, skills, evidence), /evidence/);
});

test("damaged protection state fails closed, with no overwrite", async () => {
  const original = readFileSync(store.evolutionStatePath(), "utf8");
  writeFileSync(store.evolutionStatePath(), '{"version":1,"locks":{"x":{"locked":"false"}},"projects":{}}');
  assert.throws(() => store.readEvolutionState(), /damaged/);
  await assert.rejects(protection.setSkillProtection([skill("damage")], false), /damaged/);
  assert.match(readFileSync(store.evolutionStatePath(), "utf8"), /"false"/);
  writeFileSync(store.evolutionStatePath(), original);
});
