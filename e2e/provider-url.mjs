import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";

// Real ModelsConfig on a private fixture, never the live account configuration.
// route.test.mjs separately verifies persistence and SDK endpoint resolution.
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const root = await mkdtemp(join(tmpdir(), "pi-provider-url-browser-"));
let browser, server;
try {
  await new Promise((done, reject) => webpack({
    mode: "development", devtool: false, target: "web",
    entry: resolve("e2e/fixtures/provider-url-client.tsx"),
    output: { path: root, filename: "client.js" },
    resolve: { extensions: [".tsx", ".ts", ".js"], alias: { "@": process.cwd() } },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: resolve("e2e/fixtures/skill-review-loader.cjs") }] },
  }, (error, stats) => error || stats.hasErrors()
    ? reject(error ?? new Error(stats.toString({ all: false, errors: true }))) : done()));
  const bundle = await readFile(join(root, "client.js"));
  const css = await readFile("app/settings.css");
  server = createServer((req, res) => {
    if (req.url === "/client.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(bundle); }
    if (req.url === "/settings.css") { res.setHeader("Content-Type", "text/css"); return res.end(css); }
    res.setHeader("Content-Type", "text/html");
    res.end('<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/settings.css"><style>:root{--bg:#fff;--bg-panel:#f6f7f8;--border:#ccc;--text:#222;--text-dim:#666;--text-muted:#555;--accent:#3572e0;--accent-contrast:white;--font-mono:monospace}body{margin:0;font:14px sans-serif}#root{height:100vh}</style></head><body><div id="root"></div><script src="/client.js"></script></body></html>');
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  for (const width of [1280, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const other = { apiKey: "$NOT_A_REAL_KEY", models: [{ id: "keep" }] };
    const own = { api: "openai-completions", models: [{ id: "m" }] };
    let config = { providers: { relay: other, mine: own } };
    let writes = 0, keyWrites = 0, rejectSave = false;
    const storedTypes = { openai: "api_key" };
    await page.route("**/api/**", async (route) => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (path === "/api/models-config") {
        if (req.method() === "PUT") {
          writes++;
          if (rejectSave) return route.fulfill({ status: 500, json: { error: "Fixture save failed" } });
          const body = req.postDataJSON();
          // The real route moves a literal key to auth.json and reports it.
          const migratedApiKeys = [];
          for (const [id, entry] of Object.entries(body.providers ?? {})) {
            if (typeof entry.apiKey !== "string" || !entry.apiKey.trim()) continue;
            // `$ENV` / `!command` is a reference pi resolves, not a secret: it stays.
            if (entry.apiKey.includes("$") || entry.apiKey.startsWith("!")) continue;
            migratedApiKeys.push(id);
            storedTypes[id] = "api_key";
            delete entry.apiKey;
          }
          config = body;
          return route.fulfill({ json: { success: true, migratedApiKeys } });
        }
        return route.fulfill({ json: config });
      }
      if (path === "/api/auth/providers") return route.fulfill({ json: {
        oauthProviders: [{ id: "openai", name: "OpenAI", loggedIn: false, supportsApiKey: true }],
        apiKeyProviders: [{ id: "openai", displayName: "OpenAI", configured: true, source: "stored", modelCount: 1, supportsOAuth: true }],
        providerBaseUrls: { openai: config.providers.openai?.baseUrl ?? "https://api.openai.com/v1" },
        providerCredentialTypes: storedTypes,
      } });
      if (path === "/api/models/enabled") return route.fulfill({ json: {
        allEnabled: true, patterns: null, stalePatterns: [], enabledTotal: 1, availableTotal: 1,
        scope: "global", settingsPath: "fixture/settings.json", editable: true,
        providers: [{ id: "openai", name: "OpenAI", kind: "builtin", enabledCount: 1, models: [{
          id: "example", name: "Example", ref: "openai/example", enabled: true, contextWindow: 32000,
        }] }],
      } });
      if (path.startsWith("/api/auth/api-key/")) {
        keyWrites++;
        delete storedTypes[decodeURIComponent(path.split("/").pop() ?? "")];
        return route.fulfill({ json: { success: true } });
      }
      if (path === "/api/provider-usage/query") return route.fulfill({ json: { providers: [] } });
      throw new Error(`Unexpected API: ${path}`);
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    const input = page.getByRole("textbox", { name: "Base URL", exact: true });
    const open = async () => {
      await page.goto(url);
      await page.locator(".config-sidebar-item").filter({ hasText: /^OpenAI/ }).click();
      await input.waitFor();
    };
    const save = async () => {
      const response = page.waitForResponse((reply) => reply.url().endsWith("/api/models-config") && reply.request().method() === "PUT");
      await page.locator(".config-footer").getByRole("button", { name: "Save", exact: true }).click();
      await response;
    };
    await open();
    assert.equal(await input.inputValue(), "https://api.openai.com/v1", "default is an actual visible value, not a placeholder");
    assert.equal(await input.getAttribute("type"), "text");
    assert.equal(await page.locator('input[type="password"]').count(), 1, "key stays masked");
    await input.fill("  https://gateway.invalid/custom/path  ");
    assert.equal(writes, 0);
    await save();
    await page.waitForFunction(() => document.querySelector('input[aria-label="Base URL"]')?.value === "https://gateway.invalid/custom/path");
    assert.deepEqual(config.providers.openai, { baseUrl: "https://gateway.invalid/custom/path" });
    assert.deepEqual(config.providers.relay, other);
    assert.equal(keyWrites, 0, "changing only URL must not require or replace the key");
    assert.equal(await page.locator(".config-sidebar-item").filter({ hasText: /^openai$/ }).count(), 0);
    await open();
    assert.equal(await input.inputValue(), "https://gateway.invalid/custom/path");
    // A remembered custom selection must resolve to the configured API-key pane,
    // not the unconfigured OAuth pane for this dual-auth provider.
    await page.evaluate(() => localStorage.setItem("pi-web:settings-navigation", JSON.stringify({
      selections: { models: JSON.stringify({ type: "provider", name: "openai" }) },
    })));
    await page.reload();
    await input.waitFor();
    assert.equal(await page.locator('input[type="password"]').count(), 1);
    await input.fill("https://retry.invalid/v1");
    rejectSave = true;
    await save();
    await page.getByText("Fixture save failed", { exact: true }).waitFor();
    assert.equal(await input.inputValue(), "https://retry.invalid/v1");
    assert.equal(config.providers.openai.baseUrl, "https://gateway.invalid/custom/path");
    rejectSave = false;
    await input.fill("");
    assert.equal(await input.inputValue(), "");
    await save();
    await page.waitForFunction(() => document.querySelector('input[aria-label="Base URL"]')?.value === "https://api.openai.com/v1");
    assert.deepEqual(config, { providers: { relay: other, mine: own } });
    assert.equal(keyWrites, 0);
    const bounds = await input.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, "URL stays within viewport");

    // A key typed for a custom provider is stored in auth.json, so the field never
    // echoes it back: the pane says where it lives and offers removal instead.
    await page.locator(".config-sidebar-item").filter({ hasText: /^mine$/ }).click();
    const keyField = page.getByLabel("API Key", { exact: true });
    await keyField.waitFor();
    const writesBeforeKey = writes;
    assert.equal(await page.getByText("No key stored yet", { exact: true }).count(), 1);
    await keyField.fill("sk-custom-typed");
    assert.equal(writes, writesBeforeKey, "typing waits for the shared Save");
    await save();
    await page.getByText("Stored in auth.json", { exact: true }).waitFor();
    assert.equal(await keyField.inputValue(), "", "the saved key is not echoed back");
    assert.deepEqual(config.providers.mine, own);
    assert.equal(storedTypes.mine, "api_key");
    // A `$ENV` reference is not a secret and keeps its own editable field.
    await page.locator(".config-sidebar-item").filter({ hasText: /^relay$/ }).click();
    assert.equal(await page.getByPlaceholder("$MY_PROVIDER_KEY").inputValue(), "$NOT_A_REAL_KEY");
    assert.deepEqual(config.providers.relay, other);
    await page.locator(".config-sidebar-item").filter({ hasText: /^mine$/ }).click();
    await page.getByRole("button", { name: "Remove key", exact: true }).click();
    await page.getByText("No key stored yet", { exact: true }).waitFor();
    assert.equal(keyWrites, 1, "removal goes through the credential route");
    assert.deepEqual(errors, []);
    await mkdir("test-results/provider-url", { recursive: true });
    await page.screenshot({ path: `test-results/provider-url/${width}.png`, fullPage: true });
    console.log(`PASS ${width}px: visible URL, edit/save/reopen/failure/reset, no key writes or duplicate provider`);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise((done) => server ? server.close(done) : done());
  await rm(root, { recursive: true, force: true });
}
