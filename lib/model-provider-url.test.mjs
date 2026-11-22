import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isManagedProviderOverride, normalizeProviderBaseUrls, withProviderBaseUrl } = await jiti.import("./model-provider-url.ts");

test("provider URL edits preserve credentials, models, overrides and other providers", () => {
  const original = { providers: {
    openai: { apiKey: "$TEST_KEY", headers: { "x-test": "keep" }, modelOverrides: { model: { contextWindow: 1234 } }, models: [{ id: "custom" }] },
    relay: { baseUrl: "http://localhost:1234" },
  }, extra: true };
  const draft = withProviderBaseUrl(original, "openai", "  https://gateway.invalid/custom/path/  ");
  const saved = normalizeProviderBaseUrls(draft);
  assert.equal(draft.providers.openai.baseUrl, "  https://gateway.invalid/custom/path/  ");
  assert.deepEqual(saved, { ...original, providers: { ...original.providers, openai: {
    ...original.providers.openai, baseUrl: "https://gateway.invalid/custom/path/",
  } } });
  assert.equal(original.providers.openai.baseUrl, undefined);
});

test("blank remains visible in the draft and removes only the URL when saved", () => {
  const original = { providers: { openai: { baseUrl: "https://gateway.invalid" }, relay: { baseUrl: "http://localhost" } } };
  const draft = withProviderBaseUrl(original, "openai", "");
  assert.equal(draft.providers.openai.baseUrl, "");
  assert.deepEqual(normalizeProviderBaseUrls(draft), { providers: { relay: original.providers.relay } });
  const withKey = withProviderBaseUrl({ providers: { openai: { apiKey: "$KEY", baseUrl: "old" } } }, "openai", "  ");
  assert.deepEqual(normalizeProviderBaseUrls(withKey), { providers: { openai: { apiKey: "$KEY" } } });
  assert.deepEqual(normalizeProviderBaseUrls(withProviderBaseUrl({}, "openai", "")), { providers: {} });
});

test("URL-only and URL plus context entries stay under their managed provider", () => {
  for (const entry of [
    { baseUrl: "https://gateway.invalid" }, { baseUrl: "" },
    { baseUrl: "https://gateway.invalid", modelOverrides: { model: { contextWindow: 1234 } } },
    { modelOverrides: { model: { contextWindow: 1234 } } },
  ]) assert.equal(isManagedProviderOverride(entry), true);
  for (const entry of [
    {}, { modelOverrides: {} }, { baseUrl: "url", apiKey: "$KEY" },
    { baseUrl: "url", name: "My provider" }, { baseUrl: "url", models: [{ id: "custom" }] },
    { baseUrl: "url", headers: { "x-test": "keep" } },
  ]) assert.equal(isManagedProviderOverride(entry), false);
});

test("arbitrary provider ids are own data properties", () => {
  const draft = withProviderBaseUrl({}, "__proto__", "https://gateway.invalid");
  assert.equal(Object.getPrototypeOf(draft.providers), Object.prototype);
  assert.equal(Object.hasOwn(draft.providers, "__proto__"), true);
  assert.equal(normalizeProviderBaseUrls(draft).providers.__proto__.baseUrl, "https://gateway.invalid");
});
