/**
 * One place for provider API keys: auth.json.
 *
 * A literal key typed in Settings › Models belongs in auth.json, whose single
 * credential per provider pi reads before models.json (`composeApiKeyAuth()` in
 * pi-coding-agent's provider-composer.js resolves a stored credential first).
 * models.json keeps the provider definition: Base URL, protocol, models,
 * headers, compat and modelOverrides.
 *
 * Not every `apiKey` value is a secret. pi reads a value starting with `!` as a
 * shell command and `$NAME` / `${NAME}` anywhere in it as environment
 * interpolation (`resolve-config-value.js`), and auth.json holds no such
 * references. Those stay in models.json, where they keep working.
 */

export interface MigratedApiKey {
  provider: string;
  key: string;
}

export interface ApiKeyExtraction {
  /** `config` without the literal keys; an entry nothing else defined is dropped. */
  config: Record<string, unknown>;
  keys: MigratedApiKey[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A value auth.json can hold as is. `$` covers `$NAME`, `${NAME}`, `$$` and
 * `$!`: pi resolves or escapes every one of them, so none is a plain key.
 */
export function isLiteralApiKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const key = value.trim();
  return key.length > 0 && !key.startsWith("!") && !key.includes("$");
}

/**
 * Splits literal keys out of `config` for storing in auth.json; the returned
 * config is what models.json keeps. Expressions stay untouched, and a provider
 * entry left with nothing is removed: pi refuses an empty entry, and its models
 * and URL are what the entry was for.
 */
export function extractLiteralApiKeys(config: Record<string, unknown>): ApiKeyExtraction {
  const providers = config.providers;
  if (!isRecord(providers)) return { config, keys: [] };

  const keys: MigratedApiKey[] = [];
  const kept: Record<string, unknown> = {};
  for (const [providerId, entry] of Object.entries(providers)) {
    if (!isRecord(entry) || !isLiteralApiKey(entry.apiKey)) {
      kept[providerId] = entry;
      continue;
    }
    keys.push({ provider: providerId, key: entry.apiKey.trim() });
    const rest = { ...entry };
    delete rest.apiKey;
    if (Object.keys(rest).length > 0) kept[providerId] = rest;
  }
  return { config: { ...config, providers: kept }, keys };
}
