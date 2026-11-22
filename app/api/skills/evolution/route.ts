import { NextResponse } from "next/server";
import { applyReviewDecision, authorizedReviewCwd, configureReview, reviewLiveStatus, startSkillReview, cancelSkillReview } from "@/lib/skill-evolution-service";
import { archiveReviewHistory, skipReviewEvidence } from "@/lib/skill-review-history";
import { queueReviewSource } from "@/lib/skill-review-source";
import { readReviewRequest, ReviewRequestTooLarge } from "@/lib/skill-review-request";
import { reviewErrorCode } from "@/lib/skill-review-errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const cwd = await authorizedReviewCwd(new URL(request.url).searchParams.get("cwd"));
    return NextResponse.json(await reviewLiveStatus(cwd));
  } catch (error) {
    return NextResponse.json({ code: reviewErrorCode(error), error: "Cannot read review state" }, { status: 400 });
  }
}
export async function POST(request: Request) {
  try {
    const body = await readReviewRequest(request, 16 * 1024);
    const cwd = await authorizedReviewCwd(body.cwd);
    switch (body.action) {
      case "configure": await configureReview(cwd, body.config); break;
      case "run": await startSkillReview(cwd, true); break;
      case "retry":
        if (body.evidenceIds !== undefined && (!Array.isArray(body.evidenceIds) || !body.evidenceIds.every((id: unknown) => typeof id === "string"))) throw new Error("Invalid review ID");
        if (body.runId !== undefined && typeof body.runId !== "string") throw new Error("Invalid review ID");
        if (typeof body.runId !== "string" && !body.evidenceIds) throw new Error("Review ID required");
        await startSkillReview(cwd, true, body.runId, body.evidenceIds as string[] | undefined); break;
      case "cancel":
        if (typeof body.runId !== "string") throw new Error("Review ID required");
        await cancelSkillReview(cwd, body.runId); break;
      case "archive":
        if (body.runId !== undefined && typeof body.runId !== "string") throw new Error("Invalid review ID");
        await archiveReviewHistory(cwd, body.runId); break;
      case "skip": await skipReviewEvidence(cwd, body.evidenceIds); break;
      case "source":
        await authorizedReviewCwd(cwd, true);
        await queueReviewSource(cwd, body); break;
      case "approve": case "reject": case "rollback":
        if (typeof body.runId !== "string" || typeof body.candidateId !== "string") throw new Error("Candidate ID required");
        await applyReviewDecision(cwd, body.runId, body.candidateId, body.action); break;
      default: return NextResponse.json({ code: "review-input", error: "Unknown action" }, { status: 400 });
    }
    return NextResponse.json(await reviewLiveStatus(cwd));
  } catch (error) {
    return NextResponse.json({ code: reviewErrorCode(error), error: "Review operation failed" }, { status: error instanceof ReviewRequestTooLarge ? 413 : 400 });
  }
}
