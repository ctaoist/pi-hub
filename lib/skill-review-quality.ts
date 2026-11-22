import { createHash } from "node:crypto";
import { parseFrontmatter } from "./frontmatter";
import { redactReviewText } from "./skill-evolution-evidence";
import { SkillReviewError } from "./skill-review-errors";
import type { ReviewCandidate, ReviewProject, ReviewSkill } from "./skill-evolution-types";

export function sensitiveReviewText(text: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{16,}|AKIA[0-9A-Z]{16})\b|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+|(?:https?|postgres(?:ql)?|mysql):\/\/[^\s/:]+:[^\s/@]+@/i.test(text)
    || /["']?(?:password|api[_-]?key|access[_-]?token|secret)["']?\s*[:=]\s*["']?[^"'\s]{8,}/i.test(text.replace(/\[REDACTED\]|\$\{[^}]+\}|<[^>]+>/g, ""));
}
export function reviewContentFingerprint(content: string): string {
  const text = parseFrontmatter(content).rest.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  return createHash("sha256").update(text).digest("hex");
}
export function reviewHistoryHints(project: ReviewProject) {
  return project.runs.flatMap((run) => run.candidates.map((c) => ({ name: c.name, status: c.status,
    reason: redactReviewText(c.reason).slice(0, 1000), content: redactReviewText(c.after).slice(0, 2000) }))).slice(-40);
}
export function filterReviewCandidates(candidates: ReviewCandidate[], skills: ReviewSkill[], project: ReviewProject) {
  const known = new Set([...(project.ignoredContents ?? []), ...skills.map((s) => reviewContentFingerprint(s.content)),
    ...project.runs.flatMap((r) => r.candidates.map((c) => reviewContentFingerprint(c.after)))]);
  let duplicateCount = 0;
  const active = project.runs.flatMap((r) => r.candidates).filter((c) => ["pending", "applying", "reverting"].includes(c.status));
  const filtered = candidates.filter((candidate) => {
    if (sensitiveReviewText(candidate.after) || sensitiveReviewText(candidate.reason)) throw new SkillReviewError("review-sensitive", "Candidate contains possible credentials; nothing was staged");
    const fingerprint = reviewContentFingerprint(candidate.after);
    if (known.has(fingerprint) || active.some((c) => c.name === candidate.name || c.realPath === candidate.realPath)) { duplicateCount++; return false; }
    known.add(fingerprint); return true;
  });
  return { candidates: filtered, duplicateCount };
}
