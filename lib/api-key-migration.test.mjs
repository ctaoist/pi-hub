import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { extractLiteralApiKeys, isLiteralApiKey } = await jiti.import("./api-key-migration.ts");

test("a literal key is a secret to store in auth.json; pi's references are not", () => {
  for (const key of ["sk-live-123", "AIzaSyExample", "  spaced-key  "]) {
    assert.equal(isLiteralApiKey(key), true, key);
  }
  // pi resolves these itself (resolve-config-value.js): a command, an env
  // reference, or an escape that only means a literal $ / !.
  for (const value of ["$OPENAI_API_KEY", "${MY_KEY}", "prefix-${MY_KEY}", "$$escaped", "$!bang", "!op read secret"]) {
    assert.equal(isLiteralApiKey(value), false, value);
  }
  for (const value of ["", "   ", undefined, null, 42, {}]) {
    assert.equal(isLiteralApiKey(value), false, String(value));
  }
});

test("migrating keys leaves the provider definition and removes nothing else", () => {
  const config = {
    providers: {
      gateway: {
        baseUrl: "https://gateway.invalid/v1",
        api: "openai-completions",
        apiKey: "  sk-gateway-123  ",
        headers: { "x-tenant": "one" },
        models: [{ id: "fast" }],
        modelOverrides: { slow: { contextWindow: 4096 } },
      },
      "env-provider": { baseUrl: "https://env.invalid", apiKey: "${ENV_PROVIDER_KEY}", models: [{ id: "m" }] },
      "command-provider": { baseUrl: "https://cmd.invalid", apiKey: "!pass show pi", models: [{ id: "m" }] },
      bare: { baseUrl: "https://bare.invalid", models: [{ id: "m" }] },
    },
    other: true,
  };
  const { config: saved, keys } = extractLiteralApiKeys(config);
  assert.deepEqual(keys, [{ provider: "gateway", key: "sk-gateway-123" }]);
  assert.deepEqual(saved.providers.gateway, {
    baseUrl: "https://gateway.invalid/v1",
    api: "openai-completions",
    headers: { "x-tenant": "one" },
    models: [{ id: "fast" }],
    modelOverrides: { slow: { contextWindow: 4096 } },
  });
  assert.deepEqual(saved.providers["env-provider"], config.providers["env-provider"]);
  assert.deepEqual(saved.providers["command-provider"], config.providers["command-provider"]);
  assert.deepEqual(saved.providers.bare, config.providers.bare);
  assert.equal(saved.other, true);
  // The caller's object is never mutated: the draft it came from stays editable.
  assert.equal(config.providers.gateway.apiKey, "  sk-gateway-123  ");
});

test("an entry that held only a key is dropped, since pi refuses an empty provider", () => {
  const { config, keys } = extractLiteralApiKeys({ providers: {
    "key-only": { apiKey: "sk-only" },
    "kept": { authHeader: true, apiKey: "sk-with-header" },
  } });
  assert.deepEqual(keys, [{ provider: "key-only", key: "sk-only" }, { provider: "kept", key: "sk-with-header" }]);
  assert.deepEqual(config.providers, { kept: { authHeader: true } });
});

test("a config without providers is returned unchanged", () => {
  for (const config of [{}, { providers: null }, { providers: [] }, { providers: "text" }]) {
    assert.deepEqual(extractLiteralApiKeys(config), { config, keys: [] });
  }
});
