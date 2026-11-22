import { lstatSync, opendirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Files and resource directories that may move between Pi Web nodes. */
export const SYNC_ROOT_FILES = [
  "auth.json",
  "settings.json",
  "models.json",
  "models-store.json",
] as const;

/** Top-level Pi resource directories; package installs are deliberately absent. */
export const SYNC_RESOURCE_DIRECTORIES = [
  "extensions",
  "skills",
  "prompts",
  "themes",
] as const;

/** Runtime, cache, and dependency directories never cross a node boundary. */
export const SYNC_EXCLUDED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "sessions",
  "cache",
  "caches",
  "install",
  "npm",
  "git",
  "bin",
  ".git",
  ".cache",
  "dist",
  "build",
]);

export type SyncRootFile = (typeof SYNC_ROOT_FILES)[number];
export type SyncResourceDirectory = (typeof SYNC_RESOURCE_DIRECTORIES)[number];

export interface SyncFileEntry {
  /** Agent-directory relative path, always using `/` on every platform. */
  path: string;
  size: number;
  mtimeMs: number;
  /** SHA-256 is calculated by the sync transport when content is read. */
  kind: "file";
}

function expandAgentDir(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/** Resolve Pi's agent directory without assuming a POSIX home directory. */
export function getSyncAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = expandAgentDir(env.PI_CODING_AGENT_DIR ?? "");
  return resolve(configured || join(homedir(), ".pi", "agent"));
}

function toRelativeSyncPath(agentDir: string, absolutePath: string): string | null {
  const relativePath = relative(agentDir, absolutePath);
  if (!relativePath || relativePath === "." || relativePath.startsWith("..")) return null;
  if (isAbsolute(relativePath)) return null;
  return relativePath.split(sep).join("/");
}

function isInsideAgentDir(agentDir: string, candidate: string): boolean {
  const relativePath = relative(agentDir, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function shouldExclude(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((part) => SYNC_EXCLUDED_DIRECTORY_NAMES.has(part.toLowerCase())
    || /(?:\.lock|\.tmp|\.swp|\.bak|\.log|\.exe|\.dll|\.so|\.dylib|\.node|\.zip|\.tgz)$/i.test(part));
}

function addRegularFile(agentDir: string, candidate: string, result: SyncFileEntry[]): void {
  let realPath: string;
  try {
    realPath = realpathSync(candidate);
  } catch {
    return;
  }
  if (!isInsideAgentDir(agentDir, realPath)) return;

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(realPath);
  } catch {
    return;
  }
  if (!stats.isFile()) return;
  const relativePath = toRelativeSyncPath(agentDir, realPath);
  if (!relativePath || shouldExclude(relativePath)) return;
  if (!resolveSyncFilePath(relativePath, agentDir)) throw new Error("Synchronization scope contains an unsafe or nonportable path");
  if (result.length >= 5_000) throw new Error("Too many files in synchronization scope");
  result.push({
    path: relativePath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    kind: "file",
  });
}

function walkDirectory(agentDir: string, directory: string, result: SyncFileEntry[], budget: { entries: number }, depth = 0): void {
  if (depth > 64) throw new Error("Synchronization scope contains an unsafe or nonportable path");
  const handle = opendirSync(directory);
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (++budget.entries > 20_000) throw new Error("Synchronization scan exceeds entry limit");
      const candidate = join(directory, entry.name);
      const relativePath = toRelativeSyncPath(agentDir, candidate);
      if (!relativePath || shouldExclude(relativePath)) continue;
      // Neither files nor directory symlinks are synchronized. Streaming the
      // enumeration also bounds a tree of empty directories/excluded files.
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) walkDirectory(agentDir, candidate, result, budget, depth + 1);
      else if (stats.isFile()) addRegularFile(agentDir, candidate, result);
    }
  } finally { handle.closeSync(); }
}

/**
 * Enumerate only the sync contract. Missing roots are normal and do not get
 * created merely by opening Settings.
 */
export function listSyncFiles(agentDir = getSyncAgentDir()): SyncFileEntry[] {
  const root = realpathSync(agentDir);
  const result: SyncFileEntry[] = [];
  const budget = { entries: 0 };
  for (const file of SYNC_ROOT_FILES) {
    const candidate = join(root, file);
    try {
      const stats = lstatSync(candidate);
      if (stats.isFile()) addRegularFile(root, candidate, result);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const directory of SYNC_RESOURCE_DIRECTORIES) {
    const candidate = join(root, directory);
    try {
      if (lstatSync(candidate).isDirectory()) walkDirectory(root, candidate, result, budget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/** Return the real path for an allowed relative file, or null for any escape. */
export function resolveSyncFilePath(relativePath: string, agentDir = getSyncAgentDir(), checkFilesystem = true): string | null {
  if (!relativePath || relativePath.length > 1024 || /[\\\x00-\x1f<>:"|?*]/.test(relativePath)) return null;
  const normalized = relativePath;
  // Resource root + at most 64 subdirectories + one filename, as the scanner.
  if (normalized.split("/").length > 66) return null;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  if (normalized.split("/").some((part) => !part || part.length > 255 || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?: *\.| *$)/i.test(part))) return null;
  if (shouldExclude(normalized)) return null;

  let root = resolve(agentDir);
  if (checkFilesystem) { try { root = realpathSync(root); } catch { /* new directory */ } }
  const candidate = resolve(root, ...normalized.split("/"));
  if (!isInsideAgentDir(root, candidate)) return null;
  let current = root;
  for (const part of checkFilesystem ? normalized.split("/") : []) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
  }
  const [topLevel, ...rest] = normalized.split("/");
  if (SYNC_ROOT_FILES.includes(topLevel as SyncRootFile)) {
    return rest.length === 0 ? candidate : null;
  }
  if (!SYNC_RESOURCE_DIRECTORIES.includes(topLevel as SyncResourceDirectory) || rest.length === 0) return null;
  return candidate;
}

/** Whether a relative path is part of the public synchronization contract. */
export function isSyncPathAllowed(relativePath: string): boolean {
  return resolveSyncFilePath(relativePath, "/agent") !== null;
}

export function getSyncPlatform(platform = process.platform): "windows" | "macos" | "linux" | "other" {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "other";
}

export function syncConfigPath(agentDir = getSyncAgentDir()): string {
  return join(agentDir, "sync.json");
}

export function syncKeyPath(agentDir = getSyncAgentDir()): string {
  return join(agentDir, "sync.key");
}

export function syncScopeDescription(): string[] {
  return [
    ...SYNC_ROOT_FILES,
    ...SYNC_RESOURCE_DIRECTORIES.map((directory) => `${directory}/`),
  ];
}
