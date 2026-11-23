import { PluginConfigError } from "./plugin-config";
import { PLUGIN_CONFIG_MAX_BYTES } from "./plugin-config-types";

/** Bound chunked requests before parsing; parser errors must never expose secret input. */
export async function readPluginConfigRequest(request: Request): Promise<Record<string, unknown>> {
  const max = PLUGIN_CONFIG_MAX_BYTES * 2;
  if (Number(request.headers.get("content-length")) > max) {
    void request.body?.cancel().catch(() => {});
    throw new PluginConfigError("large", 413);
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel().catch(() => {}); throw new PluginConfigError("large", 413); }
      chunks.push(value);
    }
  } finally { reader?.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new PluginConfigError("invalid"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PluginConfigError("invalid");
  return body as Record<string, unknown>;
}
