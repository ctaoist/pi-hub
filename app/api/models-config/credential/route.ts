import { NextResponse } from "next/server";
import { moveStoredCredential } from "@/lib/provider-credential-store";
import { invalidateModelsCache } from "@/lib/models-cache";

export const dynamic = "force-dynamic";

/**
 * Follows a models.json provider rename in auth.json, whose credential is filed
 * by provider id. Called by Settings › Models after a save that renamed a
 * provider; a credential already under `to` wins, since a key typed in the same
 * save is the newer one.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json() as { renames?: unknown };
    const renames = Array.isArray(body.renames) ? body.renames : null;
    if (!renames || renames.length > 100) {
      return NextResponse.json({ error: "renames must be an array of at most 100 entries" }, { status: 400 });
    }
    const moved: { from: string; to: string }[] = [];
    const failed: { from: string; to: string; error: string }[] = [];
    for (const entry of renames) {
      const from = typeof (entry as { from?: unknown })?.from === "string" ? (entry as { from: string }).from.trim() : "";
      const to = typeof (entry as { to?: unknown })?.to === "string" ? (entry as { to: string }).to.trim() : "";
      if (!from || !to) {
        failed.push({ from, to, error: "from and to are required" });
        continue;
      }
      try {
        if (await moveStoredCredential(from, to)) moved.push({ from, to });
      } catch (error) {
        failed.push({ from, to, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (moved.length > 0) invalidateModelsCache();
    return NextResponse.json({ moved, failed });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
