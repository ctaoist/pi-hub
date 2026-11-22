import { realpathSync } from "node:fs";
import type { SkillInfo } from "./api-types";
import type { EvolutionState, SkillProtection } from "./skill-evolution-types";
import { contentHash, readEvolutionState, withEvolutionState } from "./skill-evolution-store";

export function skillIdentity(skill: SkillInfo): string {
  // No version hash: a routine upstream update must not revoke the user's decision.
  return contentHash(JSON.stringify([skill.install?.source ?? skill.sourceInfo?.source ?? "unknown",
    skill.install?.sourceType ?? "", skill.install?.skillPath ?? ""]));
}
export function defaultSkillLocked(skill: SkillInfo): boolean {
  if (skill.install) return true;
  return !["auto", "local", "user", "project"].includes(skill.sourceInfo?.source ?? "unknown");
}
export function skillProtection(skill: SkillInfo, state: EvolutionState): SkillProtection {
  const defaultLocked = defaultSkillLocked(skill);
  const saved = state.locks[realpathSync(skill.filePath)];
  // A lock survives source/alias changes; only an unlock is scoped to source identity.
  const overridden = !!saved && (saved.locked || saved.identity === skillIdentity(skill));
  return { defaultLocked, overridden, locked: overridden ? saved.locked : defaultLocked };
}
export function annotateSkillProtection(skills: SkillInfo[]): SkillInfo[] {
  let state: EvolutionState;
  try { state = readEvolutionState(); }
  catch {
    // Optional automation must not take ordinary Skills browsing/chat discovery down.
    // Mutation paths still read the state strictly; never persist this fallback.
    return skills.map((skill) => ({ ...skill, protection: { defaultLocked: defaultSkillLocked(skill), locked: true, overridden: false, unavailable: true } }));
  }
  return skills.map((skill) => {
    try { return { ...skill, protection: skillProtection(skill, state) }; }
    catch { return { ...skill, protection: { defaultLocked: defaultSkillLocked(skill), locked: true, overridden: false, unavailable: true } }; }
  });
}
/** Targets must come from fresh SDK discovery, not client-supplied arbitrary paths. */
export async function setSkillProtection(skills: SkillInfo[], locked: boolean | null) {
  return withEvolutionState((state) => {
    const results: { filePath: string; error?: string }[] = [];
    for (const skill of skills) {
      try {
        const real = realpathSync(skill.filePath);
        if (locked === null) delete state.locks[real];
        else state.locks[real] = { identity: skillIdentity(skill), locked };
        results.push({ filePath: skill.filePath });
      } catch { results.push({ filePath: skill.filePath, error: "Cannot resolve this skill." }); }
    }
    return results;
  });
}
