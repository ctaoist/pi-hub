import { lstatSync, opendirSync, watch, type FSWatcher } from "node:fs";
import { join, relative, sep } from "node:path";
import { SYNC_RESOURCE_DIRECTORIES, SYNC_ROOT_FILES, SYNC_EXCLUDED_DIRECTORY_NAMES } from "./sync-scope";
import { createSyncSnapshot, syncSnapshotFingerprint } from "./sync-protocol";

export const SYNC_DEBOUNCE_MS = 300;
export const SYNC_AUDIT_MS = 5 * 60_000;
const MAX_WATCHERS = 2_048;
function excluded(path: string): boolean {
  return path.split("/").some((part) => SYNC_EXCLUDED_DIRECTORY_NAMES.has(part.toLowerCase())
    || /(?:\.lock|\.tmp|\.swp|\.bak|\.log|\.exe|\.dll|\.so|\.dylib|\.node|\.zip|\.tgz)$/i.test(part));
}
/** Per-directory watches work on Linux too; no recursive watcher follows links. */
export function watchSyncScope(agentDir: string, onDirty: () => void, auditMs = SYNC_AUDIT_MS): () => void {
  const watchers = new Map<string, { watcher: FSWatcher; ino: number; dev: number }>();
  let closed = false, debounce: NodeJS.Timeout | undefined, firstEventAt = 0;
  let running = false, again = false, auditPending = false, fingerprint: string | undefined;
  const signal = (force = false) => {
    if (closed) return;
    auditPending ||= force;
    if (!firstEventAt) firstEventAt = Date.now();
    if (debounce) clearTimeout(debounce);
    // A continuous write stream cannot postpone synchronization indefinitely.
    debounce = setTimeout(() => { debounce = undefined; firstEventAt = 0; void scan(); }, Math.max(0, Math.min(SYNC_DEBOUNCE_MS, 2_000 - (Date.now() - firstEventAt))));
    debounce.unref();
  };
  const rebuild = () => {
    const directories = new Set<string>([agentDir]);
    let entries = 0;
    const walk = (path: string, depth: number) => {
      if (depth > 64 || directories.size >= MAX_WATCHERS) return;
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
      directories.add(path);
      const dir = opendirSync(path);
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (++entries > 20_000 || directories.size >= MAX_WATCHERS) break;
          if (entry.isDirectory() && !excluded(entry.name)) walk(join(path, entry.name), depth + 1);
        }
      } finally { dir.closeSync(); }
    };
    for (const root of SYNC_RESOURCE_DIRECTORIES) walk(join(agentDir, root), 0);
    for (const [path, entry] of watchers) {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!directories.has(path) || !stat || stat.ino !== entry.ino || stat.dev !== entry.dev || stat.isSymbolicLink()) {
        entry.watcher.close(); watchers.delete(path);
      }
    }
    for (const path of directories) {
      if (watchers.has(path)) continue;
      try {
        const stat = lstatSync(path);
        const watcher = watch(path, { persistent: false }, (_event, filename) => {
          if (!filename) { signal(); return; }
          const file = relative(agentDir, join(path, filename.toString())).split(sep).join("/");
          const top = file.split("/")[0];
          if (excluded(file)) return;
          if ((SYNC_ROOT_FILES as readonly string[]).includes(file) || (SYNC_RESOURCE_DIRECTORIES as readonly string[]).includes(top)) signal();
        });
        watcher.on("error", () => { watcher.close(); watchers.delete(path); signal(true); });
        watchers.set(path, { watcher, ino: stat.ino, dev: stat.dev });
      } catch { /* Watch quota/unsupported FS: the audit repairs missed events. */ }
    }
  };
  const scan = async () => {
    if (closed) return;
    if (running) { again = true; return; }
    running = true;
    const force = auditPending; auditPending = false;
    try {
      rebuild();
      const snapshot = await createSyncSnapshot(agentDir);
      const next = syncSnapshotFingerprint(snapshot);
      if (!closed && (force || next !== fingerprint)) { fingerprint = next; onDirty(); }
    } catch {
      // Let one bounded exchange report the safe error in node status. An
      // invalid/incomplete scan is NOT a deletion and never changes the index.
      if (!closed) onDirty();
    } finally {
      running = false;
      if (again) { again = false; signal(); }
    }
  };
  const audit = setInterval(() => signal(true), auditMs); audit.unref();
  signal(true);
  return () => { closed = true; if (debounce) clearTimeout(debounce); clearInterval(audit); for (const { watcher } of watchers.values()) watcher.close(); watchers.clear(); };
}

interface DirectoryWatch { listeners: Set<() => void>; close: () => void }
const key = Symbol.for("pi-web:sync-watches");
function registry(): Map<string, DirectoryWatch> {
  const globals = globalThis as Record<symbol, unknown>;
  return (globals[key] ??= new Map()) as Map<string, DirectoryWatch>;
}
export function subscribeSyncChanges(agentDir: string, listener: () => void): () => void {
  let entry = registry().get(agentDir);
  if (!entry) {
    const listeners = new Set<() => void>();
    entry = { listeners, close: watchSyncScope(agentDir, () => { for (const notify of listeners) notify(); }) };
    registry().set(agentDir, entry);
  }
  entry.listeners.add(listener);
  return () => {
    entry!.listeners.delete(listener);
    if (!entry!.listeners.size) { entry!.close(); if (registry().get(agentDir) === entry) registry().delete(agentDir); }
  };
}
export function notifySyncScopeChanged(agentDir: string): void {
  for (const listener of registry().get(agentDir)?.listeners ?? []) listener();
}
