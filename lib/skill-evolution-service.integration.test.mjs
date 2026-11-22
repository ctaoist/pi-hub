import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const root = mkdtempSync(join(tmpdir(), "pi-review-service-"));
const cwd = join(root, "project"); mkdirSync(cwd); mkdirSync(join(cwd, ".git"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PI_OFFLINE = "1";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const service = await jiti.import("./skill-evolution-service.ts");
const store = await jiti.import("./skill-evolution-store.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
const { acquireSyncLock } = await jiti.import("./sync-lock.ts");
const { POST: protect } = await jiti.import("../app/api/skills/protection/route.ts");
const { GET: statusGet } = await jiti.import("../app/api/skills/evolution/route.ts");
allowFileRoot(cwd);
const faux = fauxProvider({ models: [{ id: "review", reasoning: false }] });
const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
runtime.registerNativeProvider(faux.provider); await runtime.refresh({ allowNetwork: false });
const model = faux.getModel("review");
globalThis.__piWebSharedModelRuntime = { agentDir: process.env.PI_CODING_AGENT_DIR, runtime: Promise.resolve(runtime), queueKey: "review-test", expiresAt: Infinity };
const config = { enabled: true, provider: model.provider, modelId: model.id, thinkingLevel: "off" };
const ev = (id) => ({ id, text: "Verified procedure", sessionId: "source", leafId: id, at: Date.now() });
const worker = () => globalThis[Symbol.for("pi-hub.skill-review.worker")];
after(() => { service.stopSkillReviewScheduler(); rmSync(root, { recursive: true, force: true }); });

test("batch execution survives its request, consumes only its snapshot, keeps actual model settings", async () => {
  await service.configureReview(cwd, config);
  await store.withEvolutionState((s) => { s.projects[cwd].turns.push(ev("one")); });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let entered; const started = new Promise((resolve) => { entered = resolve; });
  faux.setResponses([async () => { entered(); await gate; return fauxAssistantMessage([fauxText('{"summary":"Nothing new","candidates":[]}')]); }]);
  const id = await service.startSkillReview(cwd, true);
  await started;
  assert.equal(service.reviewStatus(cwd).runs[0].status, "running");
  await assert.rejects(service.startSkillReview(cwd, true), /Another/);
  await store.withEvolutionState((s) => { s.projects[cwd].turns.push(ev("two")); });
  const done = worker().active.promise; release(); await done;
  const state = store.readEvolutionState().projects[cwd];
  assert.equal(state.runs.find((r) => r.id === id).status, "unchanged");
  assert.deepEqual(state.turns.map((e) => e.id), ["two"]);
  assert.deepEqual(state.runs[0].config, config);
  assert.equal(state.runs[0].usage.tokens >= 0, true);
});

test("cross-process lease excludes dispatch; restart marks claims interrupted without a model call", async () => {
  const lease = await acquireSyncLock(join(store.evolutionDirectory(), "reviewer"), 0);
  try { await assert.rejects(service.startSkillReview(cwd, true), /lock/i); }
  finally { await lease.release(); }
  await store.withEvolutionState((s) => {
    s.projects[cwd].runs.push({ id: "crashed", config, status: "running", startedAt: 1, evidence: [ev("two")], candidates: [] });
    s.projects[cwd].lastAttempt = 0;
  });
  await service.checkSkillReviews();
  const state = store.readEvolutionState().projects[cwd];
  assert.equal(state.runs.find((r) => r.id === "crashed").status, "interrupted");
  assert.equal(state.turns.length, 1);
  assert.equal(worker().active, undefined);
});

test("HTTP reads do not dispatch; lock route cannot authorize arbitrary file paths", async () => {
  const response = await statusGet(new Request(`http://localhost/api/skills/evolution?cwd=${encodeURIComponent(cwd)}`));
  assert.equal(response.status, 200); assert.equal(worker().active, undefined);
  const response2 = await protect(new Request("http://localhost/api/skills/protection", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, locked: false, filePaths: [join(root, "auth.json")] }) }));
  assert.equal(response2.status, 200);
  const body = await response2.json(); assert.match(body.results[0].error, /catalog/);
  assert.equal(store.readEvolutionState().locks[join(root, "auth.json")], undefined);
});

test("AUDIT: manual dispatch recovers an orphaned claim before scheduler startup", async () => {
  await store.withEvolutionState((s) => {
    const p = s.projects[cwd] = { ...store.emptyReviewProject(), config, turns: [ev("orphan")] };
    p.runs = [{ id: "orphan", config, status: "running", startedAt: Date.now(), evidence: p.turns, candidates: [] }];
  });
  await assert.rejects(service.startSkillReview(cwd, true), /No unreviewed evidence/);
  assert.equal(service.reviewStatus(cwd).runs[0].status, "interrupted");
  faux.setResponses([() => fauxAssistantMessage([fauxText('{"summary":"Recovered","candidates":[]}')])]);
  await service.startSkillReview(cwd, true, "orphan"); await worker().active.promise;
  assert.equal(service.reviewStatus(cwd).runs[0].status, "unchanged");
});

test("AUDIT: terminal status and observed token charge commit atomically", async () => {
  await store.withEvolutionState((s) => { s.projects[cwd] = { ...store.emptyReviewProject(), config: { ...config, dailyTokens: 1000 }, turns: [ev("atomic")] }; });
  const snapshots = [];
  const watcher = watch(store.evolutionDirectory(), () => {
    try { snapshots.push(store.readEvolutionState().projects[cwd]); } catch { /* atomic rename event */ }
  });
  try {
    faux.setResponses([() => {
      return fauxAssistantMessage([fauxText(JSON.stringify({ summary: "Measured ".repeat(400), candidates: [] }))]);
    }]);
    await service.startSkillReview(cwd, true); await worker().active.promise;
    snapshots.push(store.readEvolutionState().projects[cwd]);
    const finished = snapshots.filter((p) => p.runs[0]?.status === "unchanged");
    assert.ok(finished.length);
    for (const p of finished) {
      const day = new Date(p.runs[0].startedAt).toISOString().slice(0, 10);
      assert.equal(p.ledger[day].tokens, p.runs[0].usage.tokens);
      assert.ok(p.ledger[day].tokens > 1000, "must not retain the smaller preflight reservation");
    }
  } finally { watcher.close(); }
});

test("invalid reasoning and unavailable models fail without changing saved configuration", async () => {
  await assert.rejects(service.configureReview(cwd, { ...config, thinkingLevel: "high" }), /reasoning/);
  await assert.rejects(service.configureReview(cwd, { ...config, modelId: "missing" }), /unavailable/);
  assert.deepEqual(service.reviewStatus(cwd).config, { ...config, dailyTokens: 1000 });
});
