/** Bound actual streamed bytes, including chunked HTTP responses. Never echo JSON parse errors. */
export async function readSyncJson(message: Request | Response, limit: number, timeoutMs = 30_000): Promise<unknown> {
  if (Number(message.headers.get("content-length")) > limit) {
    void message.body?.cancel().catch(() => {});
    throw new Error("Synchronization message exceeds size limit");
  }
  if (!message.body) throw new Error("Synchronization message is empty");
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("Synchronization request timed out"));
      void reader.cancel().catch(() => {});
    }, timeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        void reader.cancel().catch(() => {});
        throw new Error("Synchronization message exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown; }
  catch { throw new Error("Invalid synchronization JSON"); }
}

export const SYNC_WIRE_LIMIT = 36 * 1024 * 1024;

/** Never pass native filesystem, parser, crypto or remote response text to the UI/log. */
export function syncPublicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const safe = [
    "Sync peer is not configured or disabled", "Synchronization is disabled", "Sync peers have incompatible policies",
    "Authority node is not configured", "Choose a configured authority node before using authority conflict resolution",
    "Sync requires password authentication and must not be disabled by the operator",
    "Both Pi Web nodes must have password authentication enabled", "This Pi Web node is already configured",
    "A Pi Web node cannot synchronize with itself", "A different Pi Web node already uses this URL",
    "Node URL is invalid", "Node URL must use HTTPS", "Node URL must contain only an HTTPS origin",
    "Node name is required", "Node password is required", "Sync node is not configured",
    "Synchronization scope exceeds size limit", "Synchronization message exceeds size limit",
    "Synchronization scope contains an unsafe or nonportable path", "Synchronization paths collide across platforms",
    "Synchronization scope contains an unreadable or linked file", "Synchronization file changed during read",
    "Invalid local synchronization JSON; repair it before retrying", "Invalid local sync key",
    "Local sync key is missing; existing remote credentials cannot be decrypted",
  ];
  if (safe.includes(message) || /^Peer(?: registration)? returned HTTP \d{3}$/.test(message)) return message;
  return "Synchronization failed; check node connectivity, credentials and configuration";
}
