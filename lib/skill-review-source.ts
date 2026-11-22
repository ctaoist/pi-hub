import { realpathSync } from "node:fs";
import { getAgentDir, SessionManager, parseSessionEntries, migrateSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { isExistingFilePathAllowed } from "./file-access";
import { resolveSessionPath, listSessionSummaries } from "./session-reader";
import { getRpcSession } from "./rpc-manager";
import { emptyReviewProject, withEvolutionState } from "./skill-evolution-store";
import { turnEvidence } from "./skill-evolution-evidence";
import { SIDE_META_TYPE } from "./side-session";
import { SUBAGENT_META_TYPE } from "./subagents";
import { readRegularFileText } from "./regular-file";
import { SkillReviewError } from "./skill-review-errors";

export function readReviewSourceFile(path: string, cwd: string): SessionManager {
  // One nonblocking bounded descriptor read; SDK open() would re-read without
  // either bound and may initialize/rewrite an empty source file.
  const text = readRegularFileText(path, 32 * 1024 * 1024);
  if (!text?.trim()) throw new SkillReviewError("review-source", "Session is empty or missing");
  // SDK parsing tolerates damaged lines. Review must not treat missing evidence
  // as a verified transcript, so reject malformed input before projecting it.
  for (const line of text.split("\n")) if (line.trim()) {
    try { JSON.parse(line); } catch { throw new SkillReviewError("review-source", "Session contains damaged entries"); }
  }
  const entries = parseSessionEntries(text);
  if (entries[0]?.type !== "session" || typeof entries[0].cwd !== "string" || realpathSync(entries[0].cwd) !== cwd) throw new SkillReviewError("review-source", "Session header missing or project changed");
  migrateSessionEntries(entries);
  const seen = new Set<string>();
  // A pi session is append-only: every parent is an earlier entry. Enforce this
  // before SDK getBranch(), whose traversal assumes a valid acyclic graph.
  for (const entry of entries.slice(1)) {
    if (!entry || entry.type === "session" || typeof entry.id !== "string" || !entry.id || seen.has(entry.id)
      || (entry.parentId !== null && (typeof entry.parentId !== "string" || !seen.has(entry.parentId)))) throw new SkillReviewError("review-source", "Session graph is damaged");
    seen.add(entry.id);
  }
  return SessionManager.inMemory(cwd, undefined, entries);
}

/** Explicit selection only: no background historical scan and no caller-supplied file path. */
export async function queueReviewSource(cwd: string, selection: { sessionId?: unknown; fromTurn?: unknown; toTurn?: unknown }): Promise<number> {
  const { sessionId, fromTurn, toTurn } = selection;
  if (typeof sessionId !== "string" || !/^[\w-]{1,100}$/.test(sessionId)
    || !Number.isInteger(fromTurn) || !Number.isInteger(toTurn) || (fromTurn as number) < 1
    || (toTurn as number) < (fromTurn as number) || (toTurn as number) - (fromTurn as number) >= 100) throw new SkillReviewError("review-input", "Select a session and a range of at most 100 turns");
  const row = (await listSessionSummaries()).find((s) => s.id === sessionId);
  if (!row || realpathSync(row.cwd) !== cwd || row.relation?.kind === "side" || row.relation?.kind === "subagent") throw new SkillReviewError("review-source", "Select an ordinary session in this project");
  const path = await resolveSessionPath(sessionId);
  if (!path || !isExistingFilePathAllowed(path, new Set([join(getAgentDir(), "sessions")]))) throw new SkillReviewError("review-source", "Session is missing or outside the session store");
  // Resolve the live wrapper after all awaits: it may have started meanwhile.
  const live = getRpcSession(sessionId);
  if (live?.isRunning()) throw new SkillReviewError("review-busy", "Wait for this session to settle");
  const snapshot = readReviewSourceFile(path, cwd);
  const manager = live?.inner.sessionManager ?? snapshot;
  if (snapshot.getSessionId() !== sessionId) throw new SkillReviewError("review-source", "Session identity changed");
  const entries = manager.getEntries();
  if (entries.some((e) => e.type === "custom" && [SIDE_META_TYPE, SUBAGENT_META_TYPE].includes(e.customType))) throw new SkillReviewError("review-source", "Side and subagent sessions cannot be reviewed");
  if (manager.getSessionId() !== sessionId || realpathSync(manager.getCwd()) !== cwd) throw new SkillReviewError("review-source", "Session identity changed");
  const branch = manager.getBranch();
  const starts = branch.flatMap((e, i) => e.type === "message" && e.message.role === "user" ? [i] : []);
  if ((toTurn as number) > starts.length) throw new SkillReviewError("review-input", "Turn range exceeds the current branch");
  const evidence = starts.slice((fromTurn as number) - 1, toTurn as number).flatMap((start, n) => {
    const end = starts[(fromTurn as number) + n] ?? branch.length;
    const item = turnEvidence(sessionId, branch.slice(start, end) as SessionEntry[]);
    return item ? [{ ...item, manualOnly: true }] : [];
  });
  return withEvolutionState((state) => {
    const project = state.projects[cwd] ??= emptyReviewProject();
    const known = new Set([...project.seen, ...project.turns.map((e) => e.id)]);
    const fresh = evidence.filter((e) => !known.has(e.id));
    if (project.turns.length + fresh.length > 200) throw new SkillReviewError("review-storage", "Pending evidence queue is full");
    project.turns.push(...fresh);
    return fresh.length;
  });
}
