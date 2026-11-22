import { NextResponse } from "next/server";
import { readPublicSyncState, removeSyncNode, setSyncNodeEnabled, setSyncOptions } from "@/lib/sync-config";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { connectSyncNode } from "@/lib/sync-socket";
import { notifySyncConfigurationChanged } from "@/lib/sync-transport-state";
import { readSyncJson, syncPublicError } from "@/lib/sync-http";

export const dynamic = "force-dynamic";

function refusal(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return refusal(403, "Untrusted API request");
  try {
    return NextResponse.json(await readPublicSyncState(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return refusal(500, syncPublicError(error));
  }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return refusal(403, "Untrusted API request");
  if (!hasJsonContentType(request)) return refusal(415, "Content-Type must be application/json");
  let body: unknown;
  try { body = await readSyncJson(request, 16 * 1024); }
  catch (error) {
    if (error instanceof Error && error.message === "Synchronization message exceeds size limit") return refusal(413, error.message);
    return refusal(400, "Invalid or timed out JSON body");
  }
  if (!isRecord(body) || typeof body.action !== "string") return refusal(400, "Expected a sync action");

  try {
    if (body.action === "add-node") {
      if (typeof body.name !== "string" || typeof body.url !== "string"
        || typeof body.password !== "string") {
        return refusal(400, "Invalid node details");
      }
      if (body.name.length > 100 || body.url.length > 2_000 || body.password.length > 4_096) {
        return refusal(400, "Node details exceed size limits");
      }
      await connectSyncNode({
        name: body.name,
        url: body.url,
        password: body.password,
      });
      return NextResponse.json(await readPublicSyncState(), { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "remove-node") {
      if (typeof body.id !== "string") return refusal(400, "Node id is required");
      const removed = await removeSyncNode(body.id);
      notifySyncConfigurationChanged();
      return NextResponse.json({ ...(await readPublicSyncState()), removed }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "node-enabled") {
      if (typeof body.id !== "string" || typeof body.enabled !== "boolean") return refusal(400, "Node id and enabled state are required");
      await setSyncNodeEnabled(body.id, body.enabled);
      notifySyncConfigurationChanged();
      return NextResponse.json(await readPublicSyncState(), { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "options") {
      const options: { enabled?: boolean; conflictStrategy?: "mtime" | "authority"; authorityNodeId?: string | null } = {};
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") return refusal(400, "enabled must be a boolean");
        options.enabled = body.enabled;
      }
      if (body.conflictStrategy !== undefined) {
        if (body.conflictStrategy !== "mtime" && body.conflictStrategy !== "authority") return refusal(400, "Invalid conflict strategy");
        options.conflictStrategy = body.conflictStrategy;
      }
      if (body.authorityNodeId !== undefined) {
        if (body.authorityNodeId !== null && typeof body.authorityNodeId !== "string") return refusal(400, "Invalid authority node id");
        options.authorityNodeId = body.authorityNodeId as string | null;
      }
      await setSyncOptions(options);
      notifySyncConfigurationChanged();
      return NextResponse.json(await readPublicSyncState(), { headers: { "Cache-Control": "no-store" } });
    }
    return refusal(400, "Unknown sync action");
  } catch (error) {
    return refusal(400, syncPublicError(error));
  }
}
