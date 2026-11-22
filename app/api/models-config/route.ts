import { NextResponse } from "next/server";
import { ModelsConfigReadError, readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import { ContextWindowError, normalizeContextWindowOverrides } from "@/lib/model-context";
import { checkProviderEntries, ProviderEntryError } from "@/lib/model-provider-check";
import { normalizeProviderBaseUrls } from "@/lib/model-provider-url";
import { checkImageMaxBytes, ImageMaxBytesError } from "@/lib/model-image-limits";
import { extractLiteralApiKeys } from "@/lib/api-key-migration";
import { storeProviderCredential } from "@/lib/provider-credential-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(readModelsConfig());
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    // API keys live in auth.json (lib/api-key-migration.ts); models.json keeps
    // the provider definition. Credentials are written first: a failed
    // models.json write then leaves a key pi already uses, never a lost one.
    const { config: withoutKeys, keys } = extractLiteralApiKeys(normalizeProviderBaseUrls(normalizeContextWindowOverrides(body)));
    checkProviderEntries(withoutKeys);
    checkImageMaxBytes(withoutKeys);
    for (const { provider, key } of keys) {
      await storeProviderCredential(provider, { type: "api_key", key });
    }
    writeModelsConfig(withoutKeys);
    return NextResponse.json({ success: true, migratedApiKeys: keys.map((entry) => entry.provider) });
  } catch (error) {
    if (error instanceof ContextWindowError || error instanceof ProviderEntryError || error instanceof ImageMaxBytesError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
