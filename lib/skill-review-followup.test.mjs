import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
const root = mkdtempSync(join(tmpdir(), "review-followup-"));
const cwd = join(root, "project"); mkdirSync(join(cwd, ".git"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PI_OFFLINE = "1";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const store = await jiti.import("./skill-evolution-store.ts");
const service = await jiti.import("./skill-evolution-service.ts");
const history = await jiti.import("./skill-review-history.ts");
const quality = await jiti.import("./skill-review-quality.ts");
const evidence = await jiti.import("./skill-evolution-evidence.ts");
const types = await jiti.import("./skill-evolution-types.ts");
const { queueReviewSource } = await jiti.import("./skill-review-source.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts"); allowFileRoot(cwd);
const faux = fauxProvider({ models: [{ id: "review", reasoning: false }] });
const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
runtime.registerNativeProvider(faux.provider); await runtime.refresh({ allowNetwork: false });
const model = faux.getModel("review");
globalThis.__piWebSharedModelRuntime = { agentDir: process.env.PI_CODING_AGENT_DIR, runtime: Promise.resolve(runtime), queueKey: "followup", expiresAt: Infinity };
const config = { enabled: true, provider: model.provider, modelId: model.id, thinkingLevel: "off", dailyRuns: 20 };
const ev = (id) => ({ id, sessionId: "s", leafId: id, at: Date.now(), text: "Verified test procedure" });
const worker = () => globalThis[Symbol.for("pi-hub.skill-review.worker")];
const output = () => fauxAssistantMessage([fauxText('{"summary":"No new rule","candidates":[]}')]);
const skill = (name, body) => `---\nname: ${name}\ndescription: test\n---\n${body}`;
after(() => { service.stopSkillReviewScheduler(); rmSync(root, { recursive: true, force: true }); });
async function reset(turns = [ev("one")], overrides = {}) {
  await store.withEvolutionState((s) => { s.projects[cwd] = { ...store.emptyReviewProject(), config: { ...config, ...overrides }, turns }; });
}

test("policy upgrades are optional and malformed budgets fail closed", () => {
  store.validateReviewConfig(config);
  assert.equal(types.reviewPolicy(config).intervalHours, 6);
  for (const value of [0, -1, 1.5, null, "4", Infinity]) assert.throws(() => store.validateReviewConfig({ ...config, dailyRuns: value }));
  const p = { ...store.emptyReviewProject(), config: { ...config, minTurns: 1, intervalHours: 1 }, turns: [ev("a")] };
  assert.equal(types.reviewWaitReason(p, Date.now()), "ready");
  p.ledger = { [new Date().toISOString().slice(0, 10)]: { runs: 20, tokens: 1 } };
  assert.equal(types.reviewWaitReason(p, Date.now()), "budget");
});
test("cancellation rejects late results; retry is scoped and consumes a second daily call", async () => {
  await reset();
  let enter, release;
  const started = new Promise((r) => { enter = r; }); const gate = new Promise((r) => { release = r; });
  faux.setResponses([async () => { enter(); await gate; return output(); }]);
  const id = await service.startSkillReview(cwd, true); const done = worker().active.promise;
  await started; await service.cancelSkillReview(cwd, id); await done;
  assert.equal(service.reviewStatus(cwd).runs[0].errorCode, "review-cancelled");
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(service.reviewStatus(cwd).runs[0].status, "interrupted");
  await store.withEvolutionState((s) => { s.projects[cwd].turns.push(ev("unrelated")); });
  faux.setResponses([output]);
  await service.startSkillReview(cwd, true, id); await worker().active.promise;
  assert.deepEqual(store.readEvolutionState().projects[cwd].turns.map((e) => e.id), ["unrelated"]);
  assert.equal(service.reviewStatus(cwd).budget.runs, 2);
  await assert.rejects(service.startSkillReview(cwd, true, "missing"), /Only failed/);
});
test("disabling collection cancels automatic review without deleting evidence", async () => {
  await reset([ev("auto")], { minTurns: 1 });
  let enter, release; const started = new Promise((r) => { enter = r; }); const gate = new Promise((r) => { release = r; });
  faux.setResponses([async () => { enter(); await gate; return output(); }]);
  await service.startSkillReview(cwd); const done = worker().active.promise; await started;
  await service.configureReview(cwd, { ...config, enabled: false }); await done; release();
  assert.equal(service.reviewStatus(cwd).runs[0].errorCode, "review-cancelled");
  assert.equal(service.reviewStatus(cwd).pendingTurns, 1);
});
test("archives preserve budgets, rejection fingerprints and failed-evidence quarantine", async () => {
  await reset();
  await store.withEvolutionState((s) => {
    const p = s.projects[cwd]; p.runs.push({ id: "failed", status: "failed", config, evidence: p.turns, candidates: [], startedAt: Date.now(), usage: { tokens: 77, cost: 0 } });
  });
  await history.archiveReviewHistory(cwd, "failed");
  const p = store.readEvolutionState().projects[cwd];
  assert.equal(p.runs.length, 0); assert.equal(types.reviewWaitReason(p, Date.now()), "retry");
  assert.equal(types.reviewBudget(p, Date.now()).tokens, 77);
  assert.equal(types.reviewBudget(p, Date.now()).runs, 1);
  const directory = join(store.evolutionDirectory(), "archive", store.contentHash(cwd));
  assert.equal(JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), "utf8")).run.id, "failed");
  await history.skipReviewEvidence(cwd, ["one"]);
  assert.equal(service.reviewStatus(cwd).pendingTurns, 0);
  assert.ok(store.readEvolutionState().projects[cwd].seen.includes("one"));
  for (const status of ["pending", "applying", "applied", "reverting"]) assert.equal(history.canArchiveReview({ status: "pending", candidates: [{ status }] }), false);
  assert.equal(history.canArchiveReview({ status: "pending", candidates: [{ status: "reverted" }] }), true);
});
test("manual dispatch cannot bypass daily calls; provider errors expose only safe categories", async () => {
  await reset([ev("bad")], { dailyRuns: 1 });
  faux.setResponses([() => { throw new Error("provider secret password=never-return-this"); }]);
  const id = await service.startSkillReview(cwd, true); await worker().active.promise;
  const status = service.reviewStatus(cwd);
  assert.equal(status.runs[0].errorCode, "review-provider");
  assert.equal(JSON.stringify(status).includes("never-return-this"), false);
  await history.archiveReviewHistory(cwd, id);
  await assert.rejects(service.startSkillReview(cwd, true), /budget exhausted/);
});
test("content fingerprints ignore cosmetic rename; installed, pending and rejected rules deduplicate", () => {
  const p = store.emptyReviewProject();
  const c = { name: "new", after: skill("new", "Run TESTS.\n"), reason: "Verified", realPath: "/new" };
  assert.equal(quality.filterReviewCandidates([c], [{ content: skill("old", "Run TESTS.") }], p).duplicateCount, 1);
  assert.equal(quality.filterReviewCandidates([c], [{ content: skill("old", "run tests.") }], p).duplicateCount, 0, "case-sensitive code changes must not disappear");
  assert.notEqual(quality.reviewContentFingerprint(skill("a", "if ok:\n  run()")), quality.reviewContentFingerprint(skill("b", "if ok:\nrun()")), "indentation is meaningful");
  assert.notEqual(quality.reviewContentFingerprint(skill("a", "    run()")), quality.reviewContentFingerprint(skill("b", "run()")), "first-line indentation is meaningful too");
  p.ignoredContents = [quality.reviewContentFingerprint(c.after)];
  assert.equal(quality.filterReviewCandidates([c], [], p).candidates.length, 0);
  p.ignoredContents = []; p.runs = [{ candidates: [{ ...c, after: skill("new", "Different procedure"), status: "pending" }] }];
  assert.equal(quality.filterReviewCandidates([c], [], p).duplicateCount, 1);
  assert.throws(() => quality.filterReviewCandidates([{ ...c, after: skill("new", "password=longcredentialvalue") }], [], p), /credentials/);
});
test("long evidence retains bounded retrievable windows, coverage and redacts sensitive patterns", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nABCDEF\n-----END PRIVATE KEY-----";
  const secret = '"password":"longcredentialvalue" https://user:longcredentialvalue@host';
  assert.equal(evidence.redactReviewText(`${key} ${secret}`).includes("longcredentialvalue"), false);
  const branch = [{ type: "message", id: "u", timestamp: new Date().toISOString(), message: { role: "user", content: "Correction: instead run tests" } },
    ...Array.from({ length: 12 }, (_, i) => ({ type: "message", id: `t${i}`, message: { role: "toolResult", isError: i === 1, content: [{ type: "text", text: "x".repeat(5000) + secret }] } })),
    { type: "message", id: "a", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Tests passed" }] } }];
  const item = evidence.turnEvidence("s", branch);
  assert.ok(item.truncated); assert.ok(item.totalEntries > item.includedEntries);
  assert.ok(item.windows.length); assert.ok(JSON.stringify(item).length < 25000);
  const longOutcome = evidence.turnEvidence("s", [branch[0], { type: "message", id: "long", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "x".repeat(20000) + "FINAL VERIFICATION PASSED" }] } }]);
  assert.match(longOutcome.text, /FINAL VERIFICATION PASSED/);
  assert.deepEqual(item.signals.toSorted(), ["correction", "failure", "validation"]);
});
test("explicit historical range is branch-correct and idempotent with automation disabled", async () => {
  await reset([], { enabled: false });
  const sm = SessionManager.create(cwd);
  sm.appendMessage({ role: "user", content: "First", timestamp: Date.now() }); const forkPoint = sm.appendMessage(output());
  sm.appendMessage({ role: "user", content: "Discarded branch", timestamp: Date.now() }); sm.appendMessage(output());
  sm.branch(forkPoint);
  sm.appendMessage({ role: "user", content: "Second", timestamp: Date.now() }); sm.appendMessage(output());
  const selection = { sessionId: sm.getSessionId(), fromTurn: 2, toTurn: 2 };
  assert.equal(await queueReviewSource(cwd, selection), 1);
  assert.match(service.reviewStatus(cwd).evidence[0].text, /Second/);
  assert.doesNotMatch(service.reviewStatus(cwd).evidence[0].text, /Discarded/);
  assert.equal(await queueReviewSource(cwd, selection), 0);
  assert.equal(service.reviewStatus(cwd).config.enabled, false);
  await service.configureReview(cwd, { ...config, minTurns: 1 });
  assert.equal(service.reviewStatus(cwd).waitReason, "manual");
  await service.checkSkillReviews();
  assert.equal(worker().active, undefined, "historical selection must wait for explicit manual dispatch");
  await assert.rejects(queueReviewSource(cwd, { ...selection, toTurn: 3 }), /exceeds/);
  await assert.rejects(queueReviewSource(cwd, { ...selection, sessionId: "../../auth" }), /Select/);
  await history.skipReviewEvidence(cwd, [service.reviewStatus(cwd).evidence[0].id]);
  assert.equal(await queueReviewSource(cwd, selection), 0);
  sm.appendCustomEntry("pi-web:side", { broken: true });
  await assert.rejects(queueReviewSource(cwd, { ...selection, fromTurn: 1, toTurn: 1 }), /Side|ordinary/);
});

test("retention preserves approval and rollback records; rejected proposals stay suppressed", async () => {
  await reset([]);
  await store.withEvolutionState((s) => {
    const p = s.projects[cwd];
    const base = { config, evidence: [], startedAt: 1, finishedAt: 2, status: "pending" };
    const candidate = { id: "c", name: "guide", reason: "verified", evidenceIds: [], filePath: "/fake", realPath: "/fake", before: "before", after: skill("guide", "Run the tests"), status: "rejected" };
    p.runs = [{ ...base, id: "old", candidates: [candidate] },
      { ...base, id: "pending", candidates: [{ ...candidate, status: "pending" }] },
      { ...base, id: "applied", candidates: [{ ...candidate, status: "applied" }] }];
  });
  assert.equal(await history.archiveReviewHistory(cwd), 1);
  const p = store.readEvolutionState().projects[cwd];
  assert.deepEqual(p.runs.map((r) => r.id), ["pending", "applied"]);
  assert.ok(p.ignoredContents.includes(quality.reviewContentFingerprint(skill("guide", "Run the tests"))));
  await assert.rejects(history.archiveReviewHistory(cwd, "applied"), /backups/);
});

test("archived failures remain explicitly retryable from the evidence queue", async () => {
  await reset([ev("retained"), ev("fresh")]);
  await store.withEvolutionState((s) => {
    const p = s.projects[cwd];
    p.runs = [{ id: "failed-archived", config, evidence: [p.turns[0]], candidates: [], startedAt: 1, status: "failed" }];
  });
  await history.archiveReviewHistory(cwd, "failed-archived");
  assert.equal(service.reviewStatus(cwd).evidence[0].blocked, true);
  faux.setResponses([output]);
  await service.startSkillReview(cwd, true, undefined, ["retained"]); await worker().active.promise;
  assert.deepEqual(service.reviewStatus(cwd).evidence.map((e) => e.id), ["fresh"]);
  await assert.rejects(service.startSkillReview(cwd, true, undefined, ["fresh"]), /failed evidence/);
});

test("an explicit retry survives retention moving its old record to archive", async () => {
  await reset([ev("old")]);
  await store.withEvolutionState((s) => {
    const p = s.projects[cwd];
    p.runs = [{ id: "old-failure", config, evidence: p.turns, candidates: [], startedAt: 1, finishedAt: 2, status: "failed" }];
  });
  faux.setResponses([output]);
  await service.startSkillReview(cwd, true, "old-failure"); await worker().active.promise;
  assert.equal(service.reviewStatus(cwd).runs[0].status, "unchanged");
  assert.equal(service.reviewStatus(cwd).runs[0].retryOf, "old-failure");
});

test("timeout stops an uncooperative model and quarantines evidence without late writes", async () => {
  await reset([ev("timeout")], { timeoutMinutes: 1 });
  const original = globalThis.setTimeout;
  let release;
  const gate = new Promise((r) => { release = r; });
  faux.setResponses([async () => { await gate; return output(); }]);
  globalThis.setTimeout = (fn, delay, ...args) => original(fn, delay === 60000 ? 100 : delay, ...args);
  try {
    await service.startSkillReview(cwd, true);
    await worker().active.promise;
    assert.equal(service.reviewStatus(cwd).runs[0].errorCode, "review-timeout");
    assert.equal(service.reviewStatus(cwd).pendingTurns, 1);
    assert.equal(service.reviewStatus(cwd).budget.tokens, 100000);
    release(); await new Promise((r) => setImmediate(r));
    assert.equal(service.reviewStatus(cwd).runs[0].status, "interrupted");
  } finally { globalThis.setTimeout = original; release?.(); }
});
