import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/** Fail closed rather than retaining the old reverse-password registration. */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  return NextResponse.json({ error: "Synchronization requires a WSS-capable Pi Hub version on both nodes" }, {
    status: 410, headers: { "Cache-Control": "no-store" },
  });
}
export const POST = GET;
