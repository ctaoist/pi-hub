import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { contentHash, evolutionDirectory, withEvolutionState } from "./skill-evolution-store";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { blockedReviewEvidence, reviewBudget, reviewPolicy, type ReviewProject, type ReviewRun } from "./skill-evolution-types";
import { reviewContentFingerprint } from "./skill-review-quality";
import { SkillReviewError } from "./skill-review-errors";

export function canArchiveReview(run: ReviewRun): boolean {
  return run.status !== "running" && run.candidates.every((c) => c.status === "rejected" || c.status === "reverted");
}
/** Archive before removing from hot state. Idempotent filenames make a crash/retry safe. */
export function archiveReviews(cwd: string, project: ReviewProject, runs: ReviewRun[]): number {
  const directory = join(evolutionDirectory(), "archive", contentHash(cwd));
  if (runs.some((r) => !canArchiveReview(r))) throw new SkillReviewError("review-protected-history", "Pending candidates and rollback backups must be retained");
  if (!runs.length) return 0;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const blocked = blockedReviewEvidence(project);
  // Do not let archive reset today's accounting or resurrect failed evidence.
  const budget = reviewBudget(project, Date.now());
  project.ledger ??= {};
  project.ledger[budget.day] = { runs: budget.runs, tokens: budget.tokens };
  project.ignoredContents = [...new Set([...(project.ignoredContents ?? []), ...runs.flatMap((r) => r.candidates.map((c) => reviewContentFingerprint(c.after)))])].slice(-10000);
  project.blockedEvidence = project.turns.filter((e) => blocked.has(e.id)).map((e) => e.id);
  for (const run of runs) {
    writePrivateFileAtomicSync(join(directory, `${contentHash(run.id)}.json`), JSON.stringify({ version: 1, cwd, run }));
  }
  const ids = new Set(runs.map((r) => r.id));
  project.runs = project.runs.filter((r) => !ids.has(r.id));
  return runs.length;
}
export function pruneReviewHistory(cwd: string, project: ReviewProject, now = Date.now()): number {
  const cutoff = now - reviewPolicy(project.config).retentionDays * 86400_000;
  return archiveReviews(cwd, project, project.runs.filter((r) => canArchiveReview(r) && (r.finishedAt ?? r.startedAt) < cutoff));
}
export async function archiveReviewHistory(cwd: string, runId?: string): Promise<number> {
  return withEvolutionState((state) => {
    const project = state.projects[cwd];
    if (!project) return 0;
    if (!runId) return pruneReviewHistory(cwd, project);
    const run = project.runs.find((r) => r.id === runId);
    if (!run) throw new SkillReviewError("review-not-found", "Review not found");
    return archiveReviews(cwd, project, [run]);
  });
}
export async function skipReviewEvidence(cwd: string, ids: unknown): Promise<void> {
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every((id) => typeof id === "string")) throw new SkillReviewError("review-input", "Select pending evidence");
  await withEvolutionState((state) => {
    const project = state.projects[cwd];
    if (!project) throw new SkillReviewError("review-not-found", "Project not found");
    const selected = new Set(ids);
    if (project.runs.some((r) => r.status === "running" && r.evidence.some((e) => selected.has(e.id)))) throw new SkillReviewError("review-busy", "Cancel the review before skipping its evidence");
    const skipped = project.turns.filter((e) => selected.has(e.id));
    if (!skipped.length) return;
    project.seen = [...new Set([...project.seen, ...skipped.map((e) => e.id)])].slice(-10000);
    project.turns = project.turns.filter((e) => !selected.has(e.id));
    project.blockedEvidence = (project.blockedEvidence ?? []).filter((id) => !selected.has(id));
  });
}
