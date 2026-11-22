import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import { getProjectTrustStatus } from "./project-trust";
import { loadSkillsWithInstallInfo } from "./skills-service";
import { acquireSyncLock } from "./sync-lock";
import { emptyReviewProject, evolutionDirectory, readEvolutionState, validateReviewConfig, withEvolutionState } from "./skill-evolution-store";
import { decideReviewCandidate, snapshotReviewSkills, validateReviewOutput } from "./skill-evolution-candidates";
import { runSkillReviewer, validateReviewerModel } from "./skill-reviewer";
import { blockedReviewEvidence, REVIEW_MAX_TURNS, reviewBudget, reviewDue, reviewPolicy, reviewWaitReason, type ReviewRun, type ReviewProject } from "./skill-evolution-types";
import { SkillReviewError, reviewErrorCode } from "./skill-review-errors";
import { filterReviewCandidates, reviewHistoryHints, sensitiveReviewText } from "./skill-review-quality";
import { canArchiveReview, pruneReviewHistory } from "./skill-review-history";

export async function authorizedReviewCwd(value: unknown, requireTrust = false): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value) || !isExistingFilePathAllowed(value, await getAllowedFileRoots())) throw new SkillReviewError("review-access", "Project access denied");
  const cwd = realpathSync(value);
  if (!statSync(cwd).isDirectory()) throw new SkillReviewError("review-access", "Project folder not found");
  if (requireTrust && !getProjectTrustStatus(cwd, getAgentDir()).trusted) throw new SkillReviewError("review-trust", "Trust this project before running skill review");
  return cwd;
}
export async function configureReview(cwd: string, config: unknown): Promise<void> {
  validateReviewConfig(config);
  await authorizedReviewCwd(cwd, config.enabled);
  if (config.provider && config.enabled) await validateReviewerModel(config);
  await withEvolutionState((state) => {
    const project = state.projects[cwd] ??= emptyReviewProject();
    if (config.enabled && !project.config.enabled) project.collectSince = Date.now();
    project.config = { ...config };
    // Persist cancellation, not just the current enabled flag: a quick off/on in
    // another process must never revive an already cancelled automatic batch.
    if (!config.enabled) for (const run of project.runs) {
      if (run.status === "running" && run.manual !== true) run.cancelRequested = true;
    }
  });
  const active = worker().active;
  if (!config.enabled && active?.cwd === cwd && !active.manual) active.controller.abort(new SkillReviewError("review-cancelled", "Automatic review disabled"));
}
export function reviewStatus(cwd: string) {
  const project = readEvolutionState().projects[cwd] ?? emptyReviewProject();
  const blocked = blockedReviewEvidence(project);
  return { config: project.config, policy: reviewPolicy(project.config), pendingTurns: project.turns.length,
    evidence: project.turns.map(({ windows, ...e }) => ({ ...e, blocked: blocked.has(e.id), availableWindows: windows?.length ?? 0 })),
    budget: reviewBudget(project, Date.now()), notice: project.notice, lastAttempt: project.lastAttempt,
    runs: project.runs.toReversed().map((r) => ({ ...r, canArchive: canArchiveReview(r) })),
    due: reviewDue(project, Date.now()), waitReason: reviewWaitReason(project, Date.now()) };
}
export async function reviewLiveStatus(cwd: string) {
  const status = reviewStatus(cwd);
  if (status.waitReason === "ready") {
    if (!getProjectTrustStatus(cwd, getAgentDir()).trusted) return { ...status, waitReason: "trust" };
    if (await projectBusy(cwd)) return { ...status, waitReason: "busy" };
  }
  return status;
}
function recoverReviewClaims(projects: Record<string, ReviewProject>) {
  // Called only while holding the exclusive reviewer lease. An old running
  // claim therefore has no owner, including when a manual request beats startup.
  for (const project of Object.values(projects)) for (const run of project.runs) if (run.status === "running") {
    run.status = "interrupted"; run.finishedAt = Date.now(); run.errorCode = "review-interrupted";
    project.blockedEvidence = [...new Set([...(project.blockedEvidence ?? []), ...run.evidence.map((e) => e.id)])];
  }
}
/** Settle the reservation in the same transaction as the terminal run state. */
function settleReviewBudget(project: ReviewProject, run: ReviewRun, usage: ReviewRun["usage"], errorCode?: string) {
  const day = new Date(run.startedAt).toISOString().slice(0, 10);
  const ledger = project.ledger?.[day];
  const incomplete = errorCode && ["review-provider", "review-cancelled", "review-timeout", "review-interrupted", "review-budget"].includes(errorCode);
  const charge = incomplete ? Math.max(usage?.tokens ?? 0, run.tokenAllowance ?? 0) : usage?.tokens ?? 0;
  if (ledger) ledger.tokens = Math.max(0, ledger.tokens - (run.tokenAllowance ?? 0) + charge);
}
async function abortableReview<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new SkillReviewError("review-cancelled", "Review aborted"));
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
interface WorkerState { active?: { id: string; cwd: string; manual: boolean; controller: AbortController; promise: Promise<void> }; timer?: ReturnType<typeof setInterval>; checking: boolean; stopped: boolean }
const KEY = Symbol.for("pi-hub.skill-review.worker");
const globals = globalThis as unknown as Record<symbol, WorkerState>;
function worker(): WorkerState { return globals[KEY] ??= { checking: false, stopped: false }; }
async function projectBusy(cwd: string): Promise<boolean> {
  const { hasBusyRpcSessionForCwd } = await import("./rpc-manager");
  return hasBusyRpcSessionForCwd(cwd);
}
export async function cancelSkillReview(cwd: string, runId: string): Promise<void> {
  await withEvolutionState((state) => {
    const run = state.projects[cwd]?.runs.find((r) => r.id === runId);
    if (!run) throw new SkillReviewError("review-not-found", "Review not found");
    if (run.status === "running") run.cancelRequested = true;
  });
  const active = worker().active;
  if (active?.cwd === cwd && active.id === runId) active.controller.abort(new SkillReviewError("review-cancelled", "Cancelled by user"));
}

/** Retry selects that run's retained evidence, never unrelated pending turns. */
export async function startSkillReview(cwd: string, manual = false, retryOf?: string, retryEvidence?: string[]): Promise<string> {
  await authorizedReviewCwd(cwd, true);
  const host = worker();
  if (host.stopped || host.active) throw new SkillReviewError("review-busy", "Another skill review is running or the server is stopping");
  if (await projectBusy(cwd)) throw new SkillReviewError("review-busy", "Project is active; retry after the conversation settles");
  mkdirSync(evolutionDirectory(), { recursive: true, mode: 0o700 });
  const lease = await acquireSyncLock(join(evolutionDirectory(), "reviewer"), 0);
  let run: ReviewRun;
  try {
    run = await withEvolutionState((state, checkpoint) => {
      lease.check();
      if (Object.values(state.projects).some((p) => p.runs.some((r) => r.status === "running"))) {
        recoverReviewClaims(state.projects);
        checkpoint(); // Recovery must survive even if the requested dispatch is refused.
      }
      if (host.stopped) throw new SkillReviewError("review-interrupted", "Server stopping");
      const project = state.projects[cwd];
      if (!project || !project.turns.length) throw new SkillReviewError("review-empty", "No completed turns are pending review");
      if (!manual && !reviewDue(project, Date.now())) throw new SkillReviewError("review-not-due", "Review is not due");
      validateReviewConfig(project.config);
      if (!project.config.provider) throw new SkillReviewError("review-model", "Select a review model first");
      // Capture the explicit retry before retention can move its record to archive.
      const retry = retryOf ? project.runs.find((r) => r.id === retryOf) : undefined;
      pruneReviewHistory(cwd, project);
      if (project.runs.length >= 100) throw new SkillReviewError("review-storage", "Review history is full; archive completed records");
      const startedAt = Date.now();
      const budget = reviewBudget(project, startedAt);
      if (budget.runs >= budget.maxRuns || budget.tokens >= budget.maxTokens) throw new SkillReviewError("review-budget", "Daily review budget exhausted");
      if (retryOf && (!manual || !retry || !["failed", "interrupted"].includes(retry.status))) throw new SkillReviewError("review-input", "Only failed or interrupted reviews can be retried");
      const blocked = blockedReviewEvidence(project);
      if (retryEvidence && (!manual || retryOf || !retryEvidence.length || retryEvidence.length > 200 || retryEvidence.some((id) => !blocked.has(id)))) throw new SkillReviewError("review-input", "Select retained failed evidence");
      const retryIds = new Set(retryEvidence ?? retry?.evidence.map((e) => e.id));
      let pool = retry || retryEvidence ? project.turns.filter((e) => retryIds.has(e.id)) : project.turns.filter((e) => !blocked.has(e.id) && (manual || !e.manualOnly));
      // Recurrence is an exact normalized-request heuristic, not semantic proof. Keep
      // the oldest item first so quality ranking cannot starve low-signal evidence.
      const counts = new Map<string, number>();
      for (const e of pool) if (e.workflowKey) counts.set(e.workflowKey, (counts.get(e.workflowKey) ?? 0) + 1);
      const oldest = pool.toSorted((a, b) => a.at - b.at)[0]?.id;
      pool = pool.map((e) => ({ ...e, occurrences: e.workflowKey ? counts.get(e.workflowKey) : 1 }));
      const score = (e: typeof pool[number]) => (e.signals?.length ?? 0) + Math.min(3, (e.occurrences ?? 1) - 1);
      pool = pool.toSorted((a, b) => Number(b.id === oldest) - Number(a.id === oldest) || score(b) - score(a) || a.at - b.at);
      const evidence = [];
      let bytes = 0;
      for (const item of pool) {
        const size = Buffer.byteLength(JSON.stringify(item));
        if (evidence.length >= REVIEW_MAX_TURNS) break;
        if (bytes + size > 80 * 1024) continue;
        evidence.push(item); bytes += size;
      }
      if (!evidence.length) throw new SkillReviewError("review-empty", "No unreviewed evidence; retry a failed batch explicitly");
      const tokenAllowance = Math.min(100_000, budget.maxTokens - budget.tokens);
      // Reservation survives crashes and archive; settle replaces it with observed usage.
      project.ledger ??= {};
      project.ledger[budget.day] = { runs: budget.runs + 1, tokens: budget.tokens + tokenAllowance };
      const created: ReviewRun = { id: randomUUID(), config: { ...project.config }, startedAt, status: "running", manual, evidence, candidates: [], phase: "preparing", tokenAllowance, inputBytes: bytes, ...(retryOf ? { retryOf } : {}) };
      project.runs.push(created); project.lastAttempt = created.startedAt; project.notice = undefined;
      return structuredClone(created);
    });
  } catch (error) { await lease.release(); throw error; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new SkillReviewError("review-timeout", "Review timed out")), reviewPolicy(run.config).timeoutMinutes * 60_000);
  timeout.unref?.();
  const ownership = setInterval(() => {
    try {
      lease.check();
      const project = readEvolutionState().projects[cwd];
      if (host.stopped) controller.abort(new SkillReviewError("review-interrupted", "Server stopping"));
      if (project?.runs.find((r) => r.id === run.id)?.cancelRequested || (!manual && !project?.config.enabled)) controller.abort(new SkillReviewError("review-cancelled", "Review cancelled"));
    } catch { controller.abort(new SkillReviewError("review-interrupted", "Review lease lost")); }
  }, 1000);
  ownership.unref?.();
  let usage: { tokens: number; cost: number } | undefined;
  const beforeRequest = () => {
    lease.check(); controller.signal.throwIfAborted();
    const p = readEvolutionState().projects[cwd];
    const saved = p?.runs.find((r) => r.id === run.id);
    if (host.stopped || !saved || saved.status !== "running" || saved.cancelRequested || (!manual && !p.config.enabled)) {
      throw new SkillReviewError("review-cancelled", "Review no longer authorized");
    }
    if (!getProjectTrustStatus(cwd, getAgentDir()).trusted) throw new SkillReviewError("review-trust", "Project trust changed");
  };
  const phase = async (value: ReviewRun["phase"]) => withEvolutionState((state) => {
    lease.check(); controller.signal.throwIfAborted();
    const saved = state.projects[cwd].runs.find((r) => r.id === run.id)!;
    if (saved.cancelRequested) throw new SkillReviewError("review-cancelled", "Review cancelled");
    saved.phase = value;
  });
  const promise = (async () => {
    let errorCode: string | undefined;
    try {
      await abortableReview(authorizedReviewCwd(cwd, true), controller.signal);
      controller.signal.throwIfAborted();
      const project = readEvolutionState().projects[cwd];
      if (!manual && !project.config.enabled) throw new SkillReviewError("review-cancelled", "Automatic review disabled");
      const skills = snapshotReviewSkills((await abortableReview(loadSkillsWithInstallInfo(cwd), controller.signal)).skills);
      await phase("reviewing");
      const result = await abortableReview(runSkillReviewer({ cwd, config: run.config, evidence: run.evidence, skills,
        signal: controller.signal, beforeRequest, tokenAllowance: run.tokenAllowance, priorSuggestions: reviewHistoryHints(project), onUsage: (next) => { usage = next; } }), controller.signal);
      usage = result.usage;
      await phase("validating");
      const output = validateReviewOutput(result.output, cwd, skills, run.evidence);
      if (sensitiveReviewText(output.summary)) throw new SkillReviewError("review-sensitive", "Summary contains possible credentials");
      await withEvolutionState((state) => {
        lease.check(); controller.signal.throwIfAborted();
        const p = state.projects[cwd];
        const saved = p.runs.find((r) => r.id === run.id)!;
        if (saved.status !== "running" || saved.cancelRequested || (!manual && !p.config.enabled)) throw new SkillReviewError("review-cancelled", "Review claim cancelled");
        if (!getProjectTrustStatus(cwd, getAgentDir()).trusted) throw new SkillReviewError("review-trust", "Project trust changed");
        const filtered = filterReviewCandidates(output.candidates, skills, p);
        settleReviewBudget(p, saved, usage);
        Object.assign(saved, output, filtered, { usage, finishedAt: Date.now(), status: filtered.candidates.length ? "pending" : "unchanged" });
        const consumed = new Set(run.evidence.map((e) => e.id));
        p.turns = p.turns.filter((e) => !consumed.has(e.id));
        p.blockedEvidence = (p.blockedEvidence ?? []).filter((id) => !consumed.has(id));
        p.seen = [...new Set([...p.seen, ...consumed])].slice(-10000);
      });
    } catch (error) {
      errorCode = reviewErrorCode(controller.signal.aborted ? controller.signal.reason : error);
      await withEvolutionState((state) => {
        lease.check();
        const p = state.projects[cwd];
        const saved = p?.runs.find((r) => r.id === run.id);
        if (saved?.status === "running") {
          settleReviewBudget(p, saved, usage, errorCode);
          saved.status = ["review-cancelled", "review-timeout", "review-interrupted"].includes(errorCode!) ? "interrupted" : "failed";
          saved.finishedAt = Date.now(); saved.errorCode = errorCode; saved.usage = usage;
          saved.error = undefined;
          p.blockedEvidence = [...new Set([...(p.blockedEvidence ?? []), ...run.evidence.map((e) => e.id)])];
        }
      });
    } finally {
      clearTimeout(timeout); clearInterval(ownership);
      try { await lease.release(); } finally { if (host.active?.id === run.id) host.active = undefined; }
    }
  })();
  host.active = { id: run.id, cwd, manual, controller, promise };
  void promise.catch(() => console.warn("[skill-review] Could not persist completion; recovery is required."));
  return run.id;
}
export async function applyReviewDecision(cwd: string, runId: string, candidateId: string, action: "approve" | "reject" | "rollback") {
  await authorizedReviewCwd(cwd, action !== "reject");
  await decideReviewCandidate(cwd, runId, candidateId, action, async () => (await loadSkillsWithInstallInfo(cwd)).skills, () => {
    if (!getProjectTrustStatus(cwd, getAgentDir()).trusted) throw new SkillReviewError("review-trust", "Project trust changed");
  });
}
export async function checkSkillReviews() {
  const host = worker();
  if (host.stopped || host.checking || host.active) return;
  host.checking = true;
  try {
    const state = readEvolutionState();
    if (Object.values(state.projects).some((p) => p.runs.some((r) => r.status === "running"))) {
      let lease;
      try { lease = await acquireSyncLock(join(evolutionDirectory(), "reviewer"), 0); } catch { return; }
      try {
        await withEvolutionState((latest) => {
          lease.check();
          recoverReviewClaims(latest.projects);
        });
      } finally { await lease.release(); }
    }
    for (const [cwd, project] of Object.entries(readEvolutionState().projects)) {
      if (project.runs.some((r) => canArchiveReview(r) && (r.finishedAt ?? r.startedAt) < Date.now() - reviewPolicy(project.config).retentionDays * 86400_000)) {
        await withEvolutionState((s) => pruneReviewHistory(cwd, s.projects[cwd]));
      }
      if (!reviewDue(project, Date.now())) continue;
      try { await startSkillReview(cwd); break; }
      catch (error) { await withEvolutionState((s) => { s.projects[cwd].notice = reviewErrorCode(error); }); }
    }
  } catch { console.warn("[skill-review] Scheduler could not read state; writes remain disabled."); }
  finally { host.checking = false; }
}
export function startSkillReviewScheduler(): void {
  const host = worker(); if (host.timer) return;
  host.stopped = false;
  host.timer = setInterval(() => { void checkSkillReviews(); }, 10 * 60_000);
  host.timer.unref?.(); void checkSkillReviews();
}
export function stopSkillReviewScheduler(): void {
  const host = worker(); host.stopped = true;
  clearInterval(host.timer); host.timer = undefined;
  host.active?.controller.abort(new SkillReviewError("review-interrupted", "Server stopping"));
}
