import { NextResponse } from "next/server";
import { authorizedReviewCwd } from "@/lib/skill-evolution-service";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { readReviewRequest, ReviewRequestTooLarge } from "@/lib/skill-review-request";
import { setSkillProtection } from "@/lib/skill-protection";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const body = await readReviewRequest(request, 256 * 1024);
    const cwd = await authorizedReviewCwd(body.cwd);
    if (!(body.locked === null || typeof body.locked === "boolean") || !Array.isArray(body.filePaths)
      || !body.filePaths.length || body.filePaths.length > 500 || !body.filePaths.every((p: unknown) => typeof p === "string")) throw new Error("Invalid skill lock request");
    const listing = await loadSkillsWithInstallInfo(cwd);
    const paths = new Set<string>(body.filePaths);
    const targets = listing.skills.filter((s) => paths.has(s.filePath));
    const missing = [...paths].filter((p) => !targets.some((s) => s.filePath === p));
    const results = await setSkillProtection(targets, body.locked);
    results.push(...missing.map((filePath) => ({ filePath, error: "Skill is not in this project's discovered catalog" })));
    return NextResponse.json({ results, ...(await loadSkillsWithInstallInfo(cwd)) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cannot change skill locks" }, { status: error instanceof ReviewRequestTooLarge ? 413 : 400 });
  }
}
