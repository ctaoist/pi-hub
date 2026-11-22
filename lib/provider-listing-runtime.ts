import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readModelsConfig } from "@/lib/models-config-store";
import { isManagedProviderOverride } from "@/lib/model-provider-url";
import type { ProviderCredentialType, ProviderListingInput } from "@/lib/provider-listing";
import { LLAMA_CPP_PROVIDER_ID } from "@/lib/provider-listing";

/**
 * Adapter between `ModelRuntime` and the pure listing helpers in
 * `lib/provider-listing.ts`.
 */
export async function collectProviderListingInputs(
  modelRuntime: ModelRuntime,
): Promise<ProviderListingInput[]> {
  const models = modelRuntime.getModels();
  const customDefined = providersDefinedInModelsJson();

  const credentialTypes = new Map<string, ProviderCredentialType>();
  try {
    for (const credential of await modelRuntime.listCredentials()) {
      if (credential.type === "api_key" || credential.type === "oauth") {
        credentialTypes.set(credential.providerId, credential.type);
      }
    }
  } catch {
    // A damaged auth.json must not empty the provider list; fall back to the
    // per-provider auth status only.
  }

  return modelRuntime.getProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    hasApiKeyLogin: Boolean(provider.auth.apiKey?.login),
    hasOAuth: Boolean(provider.auth.oauth),
    ...(provider.auth.oauth?.name ? { oauthName: provider.auth.oauth.name } : {}),
    status: modelRuntime.getProviderAuthStatus(provider.id),
    ...(credentialTypes.has(provider.id)
      ? { credentialType: credentialTypes.get(provider.id) }
      : {}),
    ...(customDefined.has(provider.id) ? { definedInModelsJson: true } : {}),
    modelCount: models.filter((model) => model.provider === provider.id).length,
  }));
}

/**
 * Provider ids whose models.json entry defines the provider itself, so the
 * Models panel renders a custom row for it: its models, URL and key are managed
 * there rather than in a provider list. An entry holding only managed overrides
 * (a Base URL, model overrides) belongs to its built-in provider instead, and a
 * llama.cpp entry is the router login's, never a second row.
 */
function providersDefinedInModelsJson(): Set<string> {
  let providers: Record<string, unknown>;
  try {
    const config = readModelsConfig();
    providers = typeof config.providers === "object" && config.providers !== null
      ? config.providers as Record<string, unknown>
      : {};
  } catch {
    // Unreadable models.json blocks saving anyway; listing everything as managed
    // keeps every provider reachable meanwhile.
    return new Set();
  }
  return new Set(Object.keys(providers).filter((id) => (
    id !== LLAMA_CPP_PROVIDER_ID
    && typeof providers[id] === "object"
    && providers[id] !== null
    && !Array.isArray(providers[id])
    && !isManagedProviderOverride(providers[id] as { baseUrl?: string; modelOverrides?: Record<string, unknown> })
  )));
}
