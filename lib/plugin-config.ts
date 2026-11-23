import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { PLUGIN_CONFIG_MAX_BYTES, PLUGIN_CONFIG_MAX_FIELDS, pluginConfigFieldKey, pluginConfigKind } from "./plugin-config-types";
import type { PluginConfigChange, PluginConfigDocument, PluginConfigField, PluginConfigJson, PluginConfigListing } from "./plugin-config-types";

type JsonObject = { [key: string]: PluginConfigJson };
export class PluginConfigError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
function fail(code: string, status = 400): never { throw new PluginConfigError(code, status); }
const own = (value: object, key: string) => Object.hasOwn(value, key);
const record = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);

export interface PluginConfigTarget {
  id: string;
  root: string;
  relativePath: string;
  example?: string;
  packageLocal: boolean;
}
export interface PluginConfigDiscovery {
  source: string;
  installedPath: string;
  cwd: string;
  projectTrusted: boolean;
  home: string;
  env: NodeJS.ProcessEnv;
}

/** SDK-approved package roots may themselves be links. Below a root no links are followed. */
function safePath(root: string, name: string): string {
  const base = realpathSync(root);
  const target = resolve(base, name);
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("unsafe", 403);
  let current = base;
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      if (i !== parts.length - 1) fail("unavailable");
      break;
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) fail("unsafe", 403);
    if (i === parts.length - 1 && stat.nlink !== 1) fail("unsafe", 403);
  }
  return target;
}

/** An SDK-discovered index entry owns its adjacent config, never a shared extensions directory. */
export function discoverStandaloneConfig(extensionPath: string, sharedDirectories: string[]): PluginConfigTarget[] {
  if (!/^index\.(ts|js)$/.test(basename(extensionPath))) return [];
  const entry = lstatSync(extensionPath, { throwIfNoEntry: false });
  if (!entry?.isFile() || entry.isSymbolicLink()) return [];
  const root = realpathSync(dirname(extensionPath));
  if (sharedDirectories.some((path) => {
    try { return realpathSync(path) === root; } catch { return resolve(path) === root; }
  })) return [];
  if (!lstatSync(join(root, "config.json"), { throwIfNoEntry: false })
    && !lstatSync(join(root, "config.example.json"), { throwIfNoEntry: false })) return [];
  return [{ id: "extension", root, relativePath: "config.json", example: "config.example.json", packageLocal: false }];
}

/** No recursive scan, README path scraping, arbitrary client path, import, or execution. */
export function discoverPluginConfigs(input: PluginConfigDiscovery): PluginConfigTarget[] {
  const { installedPath, source, home, env, cwd, projectTrusted } = input;
  if (!lstatSync(realpathSync(installedPath)).isDirectory()) return [];
  const root = realpathSync(installedPath);
  const targets: PluginConfigTarget[] = [];
  const has = (path: string) => !!lstatSync(path, { throwIfNoEntry: false });
  if (has(join(root, "config.json")) || has(join(root, "config.example.json"))) {
    targets.push({ id: "package", root, relativePath: "config.json", example: "config.example.json", packageLocal: true });
  }
  // Deliberate, source-identity-bound adapters, verified against each plugin's reader.
  // A package.json claiming another name does not grant that package's config files.
  const npmName = source.startsWith("npm:") ? source.slice(4).replace(/@[^/]*$/, "") : "";
  const existing = (id: string, path: string) => {
    if (!has(path)) return;
    // Below HOME reject linked ancestors too; an explicit environment root outside
    // HOME is host-owned, not a package- or request-supplied path grant.
    const fromHome = relative(home, path);
    const inHome = fromHome && fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome);
    targets.push({ id, root: inHome ? home : dirname(path), relativePath: inHome ? fromHome : path.split(sep).at(-1)!, packageLocal: false });
  };
  if (npmName === "pi-web-access") {
    const legacy = join(home, ".pi", "web-search.json");
    const base = env.PI_CODING_AGENT_DIR || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "pi") : join(home, ".pi", "agent"));
    const primary = join(base, "web-search.json");
    existing("web-search", env.PI_CODING_AGENT_DIR || existsSync(primary) || !existsSync(legacy) ? primary : legacy);
  }
  if (npmName === "pi-lsp") {
    existing("lsp-global", join(env.PI_AGENT_DIR ?? join(env.HOME ?? "", ".pi", "agent"), "lsp.json"));
    // Ancestor project configs are intentionally not offered: a cwd grant does not grant its parents.
    if (projectTrusted) {
      const projectPath = join(cwd, ".pi", "lsp.json");
      if (has(projectPath)) targets.push({ id: "lsp-project", root: cwd, relativePath: join(".pi", "lsp.json"), packageLocal: false });
    }
  }
  if (npmName === "@juicesharp/rpiv-ask-user-question") {
    let xdg = env.XDG_CONFIG_HOME?.trim() ?? "";
    if (xdg === "~" || xdg.startsWith("~/")) xdg = join(home, xdg.slice(2));
    const primary = join(isAbsolute(xdg) ? xdg : join(home, ".config"), "rpiv-ask-user-question", "config.json");
    const legacy = join(home, ".config", "rpiv-ask-user-question", "config.json");
    existing("ask-user-question", existsSync(primary) ? primary : legacy);
  }
  return targets;
}

/** Bound a single opened regular file, including FIFOs, devices and concurrent growth. */
function readText(path: string): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) fail("unsafe", 403);
    if (stat.size > PLUGIN_CONFIG_MAX_BYTES) fail("large", 413);
    const buffer = Buffer.alloc(PLUGIN_CONFIG_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > PLUGIN_CONFIG_MAX_BYTES) fail("large", 413);
    return buffer.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}

function validateJson(value: unknown, depth = 0, budget = { count: 0 }): asserts value is PluginConfigJson {
  if (++budget.count > 5000 || depth > 16) fail("large", 413);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const child of value) validateJson(child, depth + 1, budget); return; }
  if (!record(value)) fail("invalid");
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) fail("invalid");
    validateJson(child, depth + 1, budget);
  }
}
function parse(text: string): JsonObject {
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { fail("invalid"); }
  validateJson(value);
  if (!record(value)) fail("invalid");
  return value as JsonObject;
}

// Conservative heuristics, not a claim to recognize every proprietary credential format.
function secretKey(key: string, value?: PluginConfigJson): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
  // LLM token budgets are quantities, not access tokens. Only exempt finite
  // numbers with an explicit quantity name; token strings and credentials stay hidden.
  if (typeof value === "number" && Number.isFinite(value)
    && !/password|secret|key|credential|auth|cookie/.test(words)
    && /(?:^|_)(?:(?:max|min|input|output|total|reserve|reserved)_tokens|tokens_(?:max|min|count|budget|limit))$/.test(words)) return false;
  return /password|passwd|secret|token|api.?key|private.?key|credential|authorization|cookie|^auth$|^key$/i.test(key);
}
function secretValue(value: PluginConfigJson): boolean {
  if (typeof value === "string") return /(?:\b(?:Bearer|Basic)\s+\S+|:\/\/[^/\s]+:[^/\s]+@|[?&](?:key|token|api_key)=|-----BEGIN .*PRIVATE KEY-----|\b(?:sk-|ghp_|github_pat_|AKIA)[\w-]{12,}|\beyJ[\w-]+\.eyJ[\w-]+\.)/i.test(value);
  if (Array.isArray(value)) return value.some(secretValue);
  return record(value) && Object.entries(value).some(([key, child]) => secretKey(key, child) || secretValue(child));
}
function fieldsFor(current: JsonObject, example?: JsonObject): PluginConfigField[] {
  const result: PluginConfigField[] = [];
  function visit(actual: JsonObject, sample: JsonObject | undefined, prefix: string[]) {
    for (const key of new Set([...Object.keys(actual), ...Object.keys(sample ?? {})])) {
      const present = own(actual, key);
      const value = present ? actual[key] : sample![key];
      const reference = sample && own(sample, key) ? sample[key] : undefined;
      const path = [...prefix, key];
      const secret = path.some((part, index) => secretKey(part, index === path.length - 1 ? value : undefined))
        || secretValue(value) || (reference !== undefined && (secretKey(key, reference) || secretValue(reference)));
      if (!secret && record(value) && (Object.keys(value).length || record(reference) && Object.keys(reference).length)) {
        visit(present ? value : {}, record(reference) ? reference : undefined, path);
      } else {
        result.push({ path, kind: pluginConfigKind(value), present, secret, ...(!secret ? { value } : {}) });
      }
      if (result.length > PLUGIN_CONFIG_MAX_FIELDS) fail("large", 413);
    }
  }
  visit(current, example, []);
  return result;
}

function snapshot(target: PluginConfigTarget) {
  const path = safePath(target.root, target.relativePath);
  const examplePath = target.example ? safePath(target.root, target.example) : undefined;
  const text = readText(path);
  const exampleText = examplePath ? readText(examplePath) : undefined;
  if (text === undefined && exampleText === undefined) fail("missing", 404);
  const current = text === undefined ? {} : parse(text);
  const example = exampleText === undefined ? undefined : parse(exampleText);
  const revision = createHash("sha256").update(JSON.stringify([path, text ?? null, exampleText ?? null])).digest("hex");
  return { path, text, current, example, revision, fields: fieldsFor(current, example), examplePath: exampleText === undefined ? undefined : examplePath };
}
export function readPluginConfig(target: PluginConfigTarget): PluginConfigDocument {
  const data = snapshot(target);
  return { id: target.id, path: data.path, packageLocal: target.packageLocal, exists: data.text !== undefined,
    examplePath: data.examplePath, revision: data.revision, fields: data.fields };
}
export function listPluginConfigs(targets: PluginConfigTarget[]): PluginConfigListing {
  return { files: targets.map((target) => {
    try { return readPluginConfig(target); }
    catch (error) { return { id: target.id, path: join(target.root, target.relativePath), packageLocal: target.packageLocal,
      exists: true, error: error instanceof PluginConfigError ? error.code : "unavailable" }; }
  }) };
}

export async function savePluginConfig(target: PluginConfigTarget, revision: unknown, changes: unknown, confirmCreate: unknown,
  beforeCommit?: () => Promise<void>): Promise<PluginConfigDocument> {
  if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision) || !Array.isArray(changes) || !changes.length || changes.length > PLUGIN_CONFIG_MAX_FIELDS) fail("invalid");
  const path = safePath(target.root, target.relativePath);
  return withFileMutationQueue(path, async () => {
    let compromised = false;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(path, { realpath: false, retries: 0, onCompromised: () => { compromised = true; } });
    } catch { fail("conflict", 409); }
    try {
      const before = snapshot(target);
      if (before.revision !== revision) fail("conflict", 409);
      if (before.text === undefined && confirmCreate !== true) fail("confirm");
      const allowed = new Map(before.fields.map((field) => [pluginConfigFieldKey(field.path), field]));
      const seen = new Set<string>();
      for (const raw of changes) {
        if (!raw || !Array.isArray(raw.path) || !raw.path.length || !raw.path.every((part: unknown) => typeof part === "string")) fail("invalid");
        const change = raw as PluginConfigChange;
        const key = pluginConfigFieldKey(change.path);
        const field = allowed.get(key);
        if (!field || seen.has(key) || !["set", "remove"].includes(change.action)) fail("invalid");
        seen.add(key);
        if (change.action === "set") {
          validateJson(change.value);
          if (field.kind !== "json" && pluginConfigKind(change.value!) !== field.kind) fail("invalid");
        } else if (!field.present) fail("invalid");
        let container = before.current;
        for (const part of change.path.slice(0, -1)) {
          if (!own(container, part)) container[part] = {};
          if (!record(container[part])) fail("invalid");
          container = container[part] as JsonObject;
        }
        const leaf = change.path.at(-1)!;
        if (change.action === "remove") delete container[leaf];
        else container[leaf] = change.value!;
      }
      validateJson(before.current);
      fieldsFor(before.current, before.example); // Refuse a result the editor cannot safely read back.
      const indent = before.text?.match(/\n([\t ]+)\S/)?.[1] ?? "  ";
      const next = JSON.stringify(before.current, null, indent) + "\n";
      if (Buffer.byteLength(next) > PLUGIN_CONFIG_MAX_BYTES) fail("large", 413);
      await beforeCommit?.(); // Recheck package registration/access after waiting for writers.
      const temp = join(dirname(path), `.plugin-config-${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, next, { flag: "wx", mode: 0o600, flush: true });
        if (compromised || snapshot(target).revision !== revision || safePath(target.root, target.relativePath) !== path) fail("conflict", 409);
        if (before.text === undefined) linkSync(temp, path); // Exclusive publish, never replace an intervening file.
        else renameSync(temp, path);
      } finally { if (existsSync(temp)) unlinkSync(temp); }
      return readPluginConfig(target);
    } finally { await release!(); }
  });
}
