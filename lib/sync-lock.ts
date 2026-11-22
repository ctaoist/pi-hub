import * as fs from "node:fs";
import lockfile from "proper-lockfile";

/** A compromised lease fails the operation, not the process or another owner. */
export async function acquireSyncLock(path: string, retries = 10) {
  let compromised = false;
  let acquired = false;
  let identity: fs.Stats | undefined;
  const owned = () => {
    try {
      const current = fs.lstatSync(`${path}.lock`, { throwIfNoEntry: false });
      return !compromised && !!identity && !!current && current.isDirectory()
        && current.dev === identity.dev && current.ino === identity.ino && current.birthtimeMs === identity.birthtimeMs;
    } catch { return false; }
  };
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries, minTimeout: 20, maxTimeout: 100 },
    onCompromised: () => { compromised = true; },
    fs: {
      ...fs,
      // Always let release() cancel the heartbeat/exit cleanup. Only skip its
      // rmdir when ownership was lost; returning without release leaks both.
      // Before acquisition, proper-lockfile may remove a stale lock normally.
      rmdir(lockPath: fs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) {
        if (acquired && !owned()) { callback(null); return; }
        fs.rmdir(lockPath, callback);
      },
    },
  });
  acquired = true;
  const releaseLease = async () => {
    try { await release(); }
    catch (error) {
      // The heartbeat may already have relinquished its compromised lease.
      if (!compromised || (error as NodeJS.ErrnoException).code !== "ERELEASED") throw error;
    }
  };
  try { identity = fs.lstatSync(`${path}.lock`); }
  catch (error) { await releaseLease(); throw error; }
  return {
    check() {
      if (!owned()) {
        compromised = true;
        throw new Error("Synchronization lock was compromised");
      }
    },
    release: releaseLease,
  };
}
