import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolveSyncFilePath } from "./sync-scope";

export const SYNC_FILE_LIMIT = 8 * 1024 * 1024;

/** A single bounded, non-following descriptor read; never block on a FIFO. */
export function readSyncFile(agentDir: string, relativePath: string): { bytes: Buffer; mtimeMs: number } | null {
  const path = resolveSyncFilePath(relativePath, agentDir);
  if (!path) throw new Error("Synchronization scope contains an unreadable or linked file");
  let fd: number;
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Synchronization scope contains an unreadable or linked file");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > SYNC_FILE_LIMIT) throw new Error("Synchronization scope exceeds size limit");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (length !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || after.ino !== current.ino || after.dev !== current.dev || !resolveSyncFilePath(relativePath, agentDir)) {
      throw new Error("Synchronization file changed during read");
    }
    return { bytes: buffer.subarray(0, length), mtimeMs: after.mtimeMs };
  } finally { closeSync(fd); }
}

/** Refuse names that alias on Windows/macOS, including directory components. */
export function assertPortableSyncPaths(paths: Iterable<string>): void {
  const names = new Map<string, string>();
  const files = new Set(paths);
  for (const path of files) {
    const parts = path.split("/");
    for (let end = 1; end <= parts.length; end++) {
      const prefix = parts.slice(0, end).join("/");
      const folded = prefix.normalize("NFC").toLowerCase();
      const previous = names.get(folded);
      if ((previous && previous !== prefix) || (end < parts.length && files.has(prefix))) {
        throw new Error("Synchronization paths collide across platforms");
      }
      names.set(folded, prefix);
      if (names.size > 20_000) throw new Error("Synchronization scan exceeds entry limit");
    }
  }
}

export function validateSyncJsonFile(path: string, bytes: Buffer): void {
  if (path.includes("/") || !path.endsWith(".json")) return;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  } catch { throw new Error("Invalid synchronization configuration file"); }
}
