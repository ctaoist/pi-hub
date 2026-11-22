import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface SkillProtection {
  locked: boolean;
  defaultLocked: boolean;
  overridden: boolean;
  /** Optional review storage is unreadable; discovery remains usable, writes fail closed. */
  unavailable?: boolean;
}
export interface ReviewConfig {
  enabled: boolean;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  intervalHours?: number;
  minTurns?: number;
  maxWaitHours?: number;
  dailyRuns?: number;
  dailyTokens?: number;
  timeoutMinutes?: number;
  retentionDays?: number;
}
export interface ReviewEvidence {
  id: string;
  sessionId: string;
  leafId: string;
  at: number;
  text: string;
  /** Original user timestamp, independent of when evidence was queued. */
  sourceAt?: number;
  truncated?: boolean;
  totalEntries?: number;
  includedEntries?: number;
  signals?: string[];
  workflowKey?: string;
  occurrences?: number;
  manualOnly?: boolean;
  /** Bounded, redacted middle-of-turn windows, fetched only on demand. */
  windows?: { entryId: string; text: string }[];
}
export interface ReviewSkill {
  id: string;
  name: string;
  description: string;
  filePath: string;
  realPath: string;
  identity: string;
  locked: boolean;
  content: string;
  hash: string;
}
export interface ReviewCandidate {
  id: string;
  name: string;
  reason: string;
  evidenceIds: string[];
  filePath: string;
  realPath: string;
  identity?: string;
  before: string | null;
  after: string;
  status: "pending" | "applying" | "applied" | "rejected" | "reverting" | "reverted";
}
export interface ReviewRun {
  id: string;
  startedAt: number;
  finishedAt?: number;
  config: ReviewConfig;
  status: "running" | "pending" | "unchanged" | "failed" | "interrupted";
  evidence: ReviewEvidence[];
  candidates: ReviewCandidate[];
  summary?: string;
  error?: string;
  usage?: { tokens: number; cost: number };
  errorCode?: string;
  cancelRequested?: boolean;
  /** Missing on older claims: disabling conservatively cancels those too. */
  manual?: boolean;
  retryOf?: string;
  tokenAllowance?: number;
  phase?: "preparing" | "reviewing" | "validating";
  inputBytes?: number;
  duplicateCount?: number;
}
export interface ReviewProject {
  config: ReviewConfig;
  turns: ReviewEvidence[];
  seen: string[];
  runs: ReviewRun[];
  lastAttempt: number;
  collectSince: number;
  blockedEvidence?: string[];
  ignoredContents?: string[];
  /** Daily accounting survives history cleanup. UTC date keys. */
  ledger?: Record<string, { runs: number; tokens: number }>;
  notice?: string;
}
export interface EvolutionState {
  version: 1;
  locks: Record<string, { identity: string; locked: boolean }>;
  projects: Record<string, ReviewProject>;
}
export interface ReviewOutput {
  summary: string;
  candidates: { target: string | null; name: string; reason: string; evidenceIds: string[]; content: string }[];
}
export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  enabled: false, provider: "", modelId: "", thinkingLevel: "medium",
};
export const REVIEW_INTERVAL_MS = 6 * 60 * 60_000;
export const REVIEW_MAX_WAIT_MS = 24 * 60 * 60_000;
export const REVIEW_MIN_TURNS = 5;
export const REVIEW_MAX_TURNS = 12;
export const REVIEW_TIMEOUT_MS = 10 * 60_000;
export const REVIEW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const DEFAULT_REVIEW_POLICY = {
  intervalHours: 6, minTurns: 5, maxWaitHours: 24, dailyRuns: 4,
  dailyTokens: 500_000, timeoutMinutes: 10, retentionDays: 30,
};
export function reviewPolicy(config: ReviewConfig) {
  return { ...DEFAULT_REVIEW_POLICY, ...Object.fromEntries(Object.entries(config).filter(([key, value]) => Object.hasOwn(DEFAULT_REVIEW_POLICY, key) && value !== undefined)) } as typeof DEFAULT_REVIEW_POLICY;
}
export function reviewBudget(project: ReviewProject, now: number) {
  const day = new Date(now).toISOString().slice(0, 10);
  const row = project.ledger?.[day];
  const today = project.runs.filter((r) => new Date(r.startedAt).toISOString().slice(0, 10) === day);
  const policy = reviewPolicy(project.config);
  return { day, runs: row?.runs ?? today.length, tokens: row?.tokens ?? today.reduce((n, r) => n + (r.usage?.tokens ?? 0), 0),
    maxRuns: policy.dailyRuns, maxTokens: policy.dailyTokens };
}
export function blockedReviewEvidence(project: ReviewProject): Set<string> {
  return new Set([...(project.blockedEvidence ?? []), ...project.runs.filter((r) => r.status === "failed" || r.status === "interrupted" || r.status === "running").flatMap((r) => r.evidence.map((e) => e.id))]);
}
export function reviewWaitReason(project: ReviewProject, now: number): "running" | "disabled" | "empty" | "retry" | "interval" | "collecting" | "ready" | "budget" | "manual" {
  if (project.runs.some((r) => r.status === "running")) return "running";
  if (!project.config.enabled) return "disabled";
  if (!project.turns.length) return "empty";
  const blocked = blockedReviewEvidence(project);
  const eligible = project.turns.filter((e) => !blocked.has(e.id));
  if (!eligible.length) return "retry";
  const pending = eligible.filter((e) => !e.manualOnly);
  if (!pending.length) return "manual";
  const budget = reviewBudget(project, now);
  if (budget.runs >= budget.maxRuns || budget.tokens >= budget.maxTokens) return "budget";
  const policy = reviewPolicy(project.config);
  if (now - project.lastAttempt < policy.intervalHours * 3600_000) return "interval";
  return pending.length >= policy.minTurns || now - Math.min(...pending.map((e) => e.at)) >= policy.maxWaitHours * 3600_000 ? "ready" : "collecting";
}
export function reviewDue(project: ReviewProject, now: number): boolean {
  return reviewWaitReason(project, now) === "ready";
}
