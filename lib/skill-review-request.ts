import { SkillReviewError } from "./skill-review-errors";

export class ReviewRequestTooLarge extends SkillReviewError {
  constructor() { super("review-input", "Request too large"); }
}
/** Bound the wire body before decoding/JSON parsing, including chunked requests. */
export async function readReviewRequest(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    void request.body?.cancel().catch(() => {});
    throw new ReviewRequestTooLarge();
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel().catch(() => {}); throw new ReviewRequestTooLarge(); }
      chunks.push(value);
    }
  } finally { reader?.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new SkillReviewError("review-input", "Invalid JSON request"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SkillReviewError("review-input", "Expected an object");
  return body as Record<string, unknown>;
}
