import { randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "./frontmatter";
import { readRegularFileText } from "./regular-file";
import { writeSessionFileAtomicSync } from "./atomic-file";
import { contentHash, withEvolutionState } from "./skill-evolution-store";
import { reviewContentFingerprint } from "./skill-review-quality";
import { skillIdentity, skillProtection } from "./skill-protection";
import type { SkillInfo } from "./api-types";
import type { ReviewCandidate, ReviewEvidence, ReviewOutput, ReviewSkill } from "./skill-evolution-types";

export const SKILL_REVIEW_MAX_BYTES = 64 * 1024;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function newSkillPath(cwd: string, name: string): string {
  if (!NAME.test(name) || name.length > 64) throw new Error("Invalid skill name");
  const root = realpathSync(cwd);
  const target = join(root, ".pi", "skills", name, "SKILL.md");
  // New installs never traverse links; existing linked skills use an explicit discovery grant.
  let current = root;
  for (const part of [".pi", "skills", name]) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Unsafe new skill directory");
  }
  return target;
}
export function validateReviewOutput(value: unknown, cwd: string, skills: ReviewSkill[], evidence: ReviewEvidence[]): { summary: string; candidates: ReviewCandidate[] } {
  if (!value || typeof value !== "object") throw new Error("Invalid review output");
  const out = value as ReviewOutput;
  if (typeof out.summary !== "string" || out.summary.length > 4000 || !Array.isArray(out.candidates) || out.candidates.length > 3) throw new Error("Invalid review output");
  const used = new Set<string>();
  const candidates = out.candidates.map((candidate) => {
    if (!candidate || typeof candidate.name !== "string" || typeof candidate.content !== "string"
      || Buffer.byteLength(candidate.content) > SKILL_REVIEW_MAX_BYTES || typeof candidate.reason !== "string"
      || !candidate.reason.trim() || candidate.reason.length > 4000 || !Array.isArray(candidate.evidenceIds)
      || !candidate.evidenceIds.length || candidate.evidenceIds.length > evidence.length
      || !candidate.evidenceIds.every((id) => evidence.some((e) => e.id === id))) throw new Error("Candidate lacks valid evidence");
    const { data, rest } = parseFrontmatter(candidate.content);
    if (!data || data.name !== candidate.name || typeof data.description !== "string" || !data.description.trim()
      || data.description.length > 1024 || !rest.trim()) throw new Error("Invalid SKILL.md frontmatter or empty instructions");
    const existing = candidate.target === null ? undefined : skills.find((skill) => skill.id === candidate.target);
    if (candidate.target !== null && !existing) throw new Error("Unknown skill target");
    if (existing?.locked) throw new Error("Skill is locked; unlock it in Skills settings first");
    if (existing && candidate.name !== existing.name) throw new Error("A review cannot rename a skill");
    if (existing && parseFrontmatter(existing.content).data?.["disable-model-invocation"] !== data["disable-model-invocation"]) {
      throw new Error("A review cannot change skill invocation settings");
    }
    if (!existing && skills.some((skill) => skill.name.toLowerCase() === candidate.name.toLowerCase())) throw new Error("Skill already exists; do not duplicate a locked skill");
    const filePath = existing?.filePath ?? newSkillPath(cwd, candidate.name);
    const realPath = existing?.realPath ?? filePath;
    if (used.has(realPath)) throw new Error("Duplicate candidate target");
    used.add(realPath);
    if (existing?.content === candidate.content) throw new Error("Candidate changes nothing");
    if (!existing && lstatSync(filePath, { throwIfNoEntry: false })) throw new Error("New skill target already exists");
    return { id: randomUUID(), name: candidate.name, reason: candidate.reason, evidenceIds: candidate.evidenceIds,
      filePath, realPath, identity: existing?.identity, before: existing?.content ?? null,
      after: candidate.content, status: "pending" as const };
  });
  return { summary: out.summary, candidates };
}

export function snapshotReviewSkills(skills: SkillInfo[]): ReviewSkill[] {
  if (skills.length > 500) throw new Error("Too many skills for one review (maximum 500)");
  return skills.map((skill, index) => {
    const content = readRegularFileText(skill.filePath, SKILL_REVIEW_MAX_BYTES);
    if (content === undefined) throw new Error("A skill disappeared while preparing review");
    return { id: `skill-${index}`, name: skill.name, description: skill.description, filePath: skill.filePath,
      realPath: realpathSync(skill.filePath), identity: skillIdentity(skill), locked: skill.protection?.locked ?? true,
      content, hash: contentHash(content) };
  });
}

/** Resolve an interrupted write without rewriting files or repeating a model call. */
export function reconcileCandidate(candidate: ReviewCandidate): void {
  if (candidate.status !== "applying" && candidate.status !== "reverting") return;
  const current = readRegularFileText(candidate.realPath, SKILL_REVIEW_MAX_BYTES) ?? null;
  if (current === candidate.before) candidate.status = candidate.status === "applying" ? "pending" : "reverted";
  else if (current === candidate.after) candidate.status = "applied";
  else throw new Error("Interrupted skill write conflicts with current contents; restore it manually");
}

export async function decideReviewCandidate(cwd: string, runId: string, candidateId: string,
  action: "approve" | "reject" | "rollback", loadSkills: () => Promise<SkillInfo[]>, beforeWrite: () => void = () => {}) {
  return withEvolutionState(async (state, checkpoint) => {
    const candidate = state.projects[cwd]?.runs.find((r) => r.id === runId)?.candidates.find((c) => c.id === candidateId);
    if (!candidate) throw new Error("Candidate not found");
    reconcileCandidate(candidate);
    if (action === "reject") {
      if (candidate.status === "rejected") return;
      if (candidate.status !== "pending") throw new Error("Candidate is not pending");
      candidate.status = "rejected";
      const project = state.projects[cwd];
      project.ignoredContents = [...new Set([...(project.ignoredContents ?? []), reviewContentFingerprint(candidate.after)])].slice(-10000);
      return;
    }
    if (action === "approve" && candidate.status === "applied" || action === "rollback" && candidate.status === "reverted") return;
    if (candidate.status !== (action === "approve" ? "pending" : "applied")) throw new Error("Candidate state changed");
    const skills = await loadSkills();
    const matching = skills.filter((skill) => realpathSync(skill.filePath) === candidate.realPath);
    if (candidate.before !== null || action === "rollback") {
      if (!matching.length || matching.some((skill) => skillProtection(skill, state).locked)) throw new Error("Skill is locked or no longer discovered");
      if (candidate.identity && matching.some((skill) => skillIdentity(skill) !== candidate.identity)) throw new Error("Skill source changed");
      if (realpathSync(candidate.filePath) !== candidate.realPath) throw new Error("Skill path changed");
    } else {
      if (newSkillPath(cwd, candidate.name) !== candidate.realPath || skills.some((skill) => skill.name.toLowerCase() === candidate.name.toLowerCase())) throw new Error("Skill target already exists or changed");
    }
    // SDK file queue coordinates with built-in coding tools in this process as well.
    await withFileMutationQueue(candidate.realPath, async () => {
      beforeWrite();
      const expected = action === "approve" ? candidate.before : candidate.after;
      const current = readRegularFileText(candidate.realPath, SKILL_REVIEW_MAX_BYTES) ?? null;
      if (current !== expected) throw new Error("Skill changed since review; refusing to overwrite it");
      if (candidate.before === null && action === "approve") newSkillPath(cwd, candidate.name);
      else if (realpathSync(candidate.filePath) !== candidate.realPath) throw new Error("Skill path changed");
      const next = action === "approve" ? candidate.after : candidate.before;
      candidate.status = action === "approve" ? "applying" : "reverting";
      checkpoint(); // Write-ahead backup and intent, before any skill mutation.
      if (next === null) unlinkSync(candidate.realPath); // Only our new SKILL.md; never remove support files.
      else if (expected === null) {
        mkdirSync(dirname(candidate.realPath), { recursive: true });
        const temp = join(dirname(candidate.realPath), `.review-${randomUUID()}.tmp`);
        try {
          writeFileSync(temp, next, { flag: "wx", mode: 0o600, flush: true });
          linkSync(temp, candidate.realPath); // Atomic exclusive publish; never replace an intervening file.
        } finally { if (existsSync(temp)) unlinkSync(temp); }
      } else writeSessionFileAtomicSync(candidate.realPath, next);
      candidate.status = action === "approve" ? "applied" : "reverted";
      checkpoint();
    });
  });
}
