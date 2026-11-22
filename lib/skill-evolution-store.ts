import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { acquireSyncLock } from "./sync-lock";
import { readRegularFileText } from "./regular-file";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { DEFAULT_REVIEW_CONFIG, DEFAULT_REVIEW_POLICY, REVIEW_THINKING_LEVELS, type EvolutionState, type ReviewProject } from "./skill-evolution-types";

const MAX_STATE_BYTES = 16 * 1024 * 1024;
export const evolutionDirectory = () => join(getAgentDir(), "skill-evolution");
export const evolutionStatePath = () => join(evolutionDirectory(), "state.json");
export const contentHash = (text: string) => createHash("sha256").update(text).digest("hex");
export const emptyEvolutionState = (): EvolutionState => ({ version: 1, locks: {}, projects: {} });
export const emptyReviewProject = (): ReviewProject => ({
  config: { ...DEFAULT_REVIEW_CONFIG }, turns: [], seen: [], runs: [], lastAttempt: 0, collectSince: 0,
});

/** Fail closed: a damaged protection record is never treated as an unlocked library. */
export function readEvolutionState(): EvolutionState {
  try {
    const path = evolutionStatePath();
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return emptyEvolutionState();
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    const text = readRegularFileText(path, MAX_STATE_BYTES);
    if (text === undefined) throw new Error();
    const state = JSON.parse(text) as EvolutionState;
    if (state.version !== 1 || !record(state.locks) || !record(state.projects)) throw new Error();
    for (const lock of Object.values(state.locks)) {
      if (!lock || typeof lock.identity !== "string" || typeof lock.locked !== "boolean") throw new Error();
    }
    for (const project of Object.values(state.projects)) {
      if (!project || !Array.isArray(project.turns) || !Array.isArray(project.seen) || !Array.isArray(project.runs)
        || !Number.isFinite(project.lastAttempt) || !Number.isFinite(project.collectSince)) throw new Error();
      validateReviewConfig(project.config);
      if (project.ledger !== undefined && (!record(project.ledger) || Object.entries(project.ledger).some(([day, row]) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(day) || !row || !Number.isFinite(row.runs) || row.runs < 0 || !Number.isFinite(row.tokens) || row.tokens < 0))) throw new Error();
      for (const key of ["blockedEvidence", "ignoredContents"] as const) {
        if (project[key] !== undefined && (!Array.isArray(project[key]) || !project[key]!.every((s) => typeof s === "string"))) throw new Error();
      }
      for (const e of project.turns) validateEvidence(e);
      for (const run of project.runs) {
        if (!run || typeof run.id !== "string" || !Array.isArray(run.evidence) || !Array.isArray(run.candidates)
          || !["running", "pending", "unchanged", "failed", "interrupted"].includes(run.status)) throw new Error();
        validateReviewConfig(run.config);
        if (!Number.isFinite(run.startedAt) || (run.finishedAt !== undefined && !Number.isFinite(run.finishedAt))
          || (run.tokenAllowance !== undefined && (!Number.isFinite(run.tokenAllowance) || run.tokenAllowance < 0))
          || (run.manual !== undefined && typeof run.manual !== "boolean")
          || (run.cancelRequested !== undefined && typeof run.cancelRequested !== "boolean")
          || (run.usage !== undefined && (!Number.isFinite(run.usage.tokens) || run.usage.tokens < 0 || !Number.isFinite(run.usage.cost) || run.usage.cost < 0))) throw new Error();
        for (const e of run.evidence) validateEvidence(e);
        for (const c of run.candidates) {
          if (!c || typeof c.id !== "string" || typeof c.after !== "string" || !(c.before === null || typeof c.before === "string")
            || typeof c.filePath !== "string" || typeof c.realPath !== "string"
            || !["pending", "applying", "applied", "rejected", "reverting", "reverted"].includes(c.status)) throw new Error();
        }
      }
    }
    return state;
  } catch {
    throw new Error("Skill review state is damaged; restore state.json from a backup before changing skills.");
  }
}
function validateEvidence(value: unknown): void {
  if (!record(value) || typeof value.id !== "string" || typeof value.text !== "string" || !Number.isFinite(value.at)
    || typeof value.sessionId !== "string" || typeof value.leafId !== "string"
    || (value.manualOnly !== undefined && typeof value.manualOnly !== "boolean")
    || (value.workflowKey !== undefined && typeof value.workflowKey !== "string")
    || (value.truncated !== undefined && typeof value.truncated !== "boolean")
    || (value.signals !== undefined && (!Array.isArray(value.signals) || !value.signals.every((s) => typeof s === "string")))
    || (value.windows !== undefined && (!Array.isArray(value.windows) || value.windows.length > 100 || value.windows.some((w) => !record(w) || typeof w.entryId !== "string" || typeof w.text !== "string")))) throw new Error();
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validateReviewConfig(value: unknown): asserts value is ReviewProject["config"] {
  if (!record(value) || typeof value.enabled !== "boolean" || typeof value.provider !== "string"
    || typeof value.modelId !== "string" || value.provider.length > 256 || value.modelId.length > 512
    || !REVIEW_THINKING_LEVELS.includes(value.thinkingLevel as never)
    || (!!value.provider !== !!value.modelId) || (value.enabled && !value.provider)) {
    throw new Error("Select a review model and a valid reasoning level.");
  }
  const bounds: Record<keyof typeof DEFAULT_REVIEW_POLICY, [number, number]> = {
    intervalHours: [1, 168], minTurns: [1, 100], maxWaitHours: [1, 720], dailyRuns: [1, 100],
    dailyTokens: [1000, 10_000_000], timeoutMinutes: [1, 30], retentionDays: [1, 365],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const number = value[key];
    if (number !== undefined && (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max)) {
      throw new Error(`Invalid review policy: ${key} must be an integer between ${min} and ${max}`);
    }
  }
}
export function saveEvolutionState(state: EvolutionState): void {
  const text = JSON.stringify(state);
  if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error("Skill review storage is full; archive old review records before continuing.");
  writePrivateFileAtomicSync(evolutionStatePath(), text);
}

/** The same lease guards user lock changes and candidate writes across routes/processes. */
export async function withEvolutionState<T>(fn: (state: EvolutionState, checkpoint: () => void) => T | Promise<T>): Promise<T> {
  mkdirSync(evolutionDirectory(), { recursive: true, mode: 0o700 });
  const lease = await acquireSyncLock(join(evolutionDirectory(), "mutation"));
  try {
    const state = readEvolutionState();
    const checkpoint = () => { lease.check(); saveEvolutionState(state); };
    const result = await fn(state, checkpoint);
    checkpoint();
    return result;
  } finally { await lease.release(); }
}
