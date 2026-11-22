import type { SyncFileVersion } from "./sync-config";

export function syncRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function syncId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(value);
}
export function syncTime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 30 && Number.isFinite(Date.parse(value)) && Date.parse(value) >= 0;
}
export function syncCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

/** Validate and COPY the wire schema; never persist an untrusted object by assertion. */
export function parseSyncVersion(value: unknown): SyncFileVersion {
  if (!syncRecord(value) || !syncId(value.sourceNodeId) || !syncTime(value.updatedAt)
    || !syncCounter(value.revision ?? 0) || typeof value.mtimeMs !== "number"
    || !Number.isFinite(value.mtimeMs) || value.mtimeMs < 0 || value.mtimeMs > 8.64e15
    || (value.deleted !== undefined && typeof value.deleted !== "boolean")) {
    throw new Error("Invalid synchronization version");
  }
  const common = { sourceNodeId: value.sourceNodeId, updatedAt: value.updatedAt, mtimeMs: value.mtimeMs, revision: value.revision ?? 0 };
  if (value.deleted === true) return { ...common, deleted: true } as SyncFileVersion;
  if (typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash)
    || !syncCounter(value.size) || value.size > 8 * 1024 * 1024) throw new Error("Invalid synchronization version");
  return { ...common, hash: value.hash, size: value.size } as SyncFileVersion;
}
