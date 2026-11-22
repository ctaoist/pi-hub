/** Provider URL edits share the Models panel's models.json draft. */
interface ProviderUrlEntry {
  baseUrl?: string;
  modelOverrides?: Record<string, unknown>;
}
interface ProviderUrlConfig {
  providers?: Record<string, ProviderUrlEntry>;
}

/** Only fields the managed-provider panel can edit; custom definitions stay visible. */
export function isManagedProviderOverride(entry: ProviderUrlEntry): boolean {
  const keys = Object.keys(entry);
  return keys.length > 0
    && keys.every((key) => key === "baseUrl" || key === "modelOverrides")
    && (typeof entry.baseUrl === "string" || Object.keys(entry.modelOverrides ?? {}).length > 0);
}

/** Keep a blank draft explicit so clearing the field does not immediately show the default again. */
export function withProviderBaseUrl<T extends ProviderUrlConfig>(config: T, providerId: string, value: string): T {
  const provider = Object.hasOwn(config.providers ?? {}, providerId) ? config.providers?.[providerId] : undefined;
  return { ...config, providers: { ...config.providers, [providerId]: { ...provider, baseUrl: value } } };
}

/** Blank restores the provider default; never rewrite paths or append /v1. */
export function normalizeProviderBaseUrls<T extends ProviderUrlConfig>(config: T): T {
  const result = structuredClone(config);
  for (const [id, provider] of Object.entries(result.providers ?? {})) {
    if (!provider || typeof provider.baseUrl !== "string") continue;
    const url = provider.baseUrl.trim();
    if (url) provider.baseUrl = url;
    else {
      delete provider.baseUrl;
      if (!Object.keys(provider).length) delete result.providers![id];
    }
  }
  return result;
}
