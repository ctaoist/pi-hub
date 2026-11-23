import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const root = await mkdtemp(join(tmpdir(), "pi-plugin-config-browser-"));
const password = "isolated-plugin-fixture-password";
let server, browser;
try {
  await mkdir(join(root, "home"));
  await new Promise((done, reject) => webpack({ mode: "development", devtool: false, target: "web",
    entry: resolve("e2e/fixtures/plugin-config-client.tsx"), output: { path: join(root, "bundle"), filename: "client.js" },
    resolve: { extensions: [".tsx", ".ts", ".js"], alias: { "@": process.cwd() } },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: resolve("e2e/fixtures/skill-review-loader.cjs") }] },
  }, (error, stats) => error || stats.hasErrors() ? reject(error ?? new Error(stats.toString({ all: false, errors: true }))) : done()));
  server = fork(resolve("e2e/fixtures/plugin-config-server.mjs"), [], { env: { ...process.env,
    HOME: join(root, "home"), PLUGIN_CONFIG_FIXTURE_ROOT: root, PI_WEB_PASSWORD: password }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = ""; server.stderr.on("data", (chunk) => { errors += chunk; });
  const info = await Promise.race([once(server, "message").then(([data]) => data), once(server, "exit").then(() => { throw new Error(errors); })]);
  const url = `http://127.0.0.1:${info.port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const query = new URLSearchParams({ cwd: info.cwd, source: join(root, "existing"), scope: "global" });
  assert.equal((await context.request.get(`${url}/api/plugins/config?${query}`)).status(), 401);
  assert.equal((await context.request.post(`${url}/api/web-auth`, { data: { password } })).status(), 200);
  const page = await context.newPage(); const issues = []; page.on("pageerror", (error) => issues.push(error.message));
  await page.goto(url);
  const save = page.getByRole("button", { name: "Save configuration", exact: true });
  async function assertRemoveOnRight(control, removeName = "Remove field") {
    const field = page.locator(".config-field").filter({ has: control });
    const [value, button] = await Promise.all([
      control.boundingBox(), field.getByRole("button", { name: removeName, exact: true }).boundingBox(),
    ]);
    assert.ok(value && button, "Field control and remove button should be visible");
    assert.ok(button.x >= value.x + value.width - 1, "Remove button should be to the right of the value");
    assert.ok(button.y < value.y + value.height && value.y < button.y + button.height, "Remove button should be on the same row");
  }
  const count = page.getByLabel('"count"', { exact: true });
  const list = page.getByLabel('"list"', { exact: true });
  const enabled = page.getByRole("switch", { name: '"enabled"', exact: true });
  await count.waitFor();
  await assertRemoveOnRight(count);
  await assertRemoveOnRight(list);
  await assertRemoveOnRight(enabled);
  await count.fill("4");
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await page.getByLabel('"apiKey"', { exact: true }).fill("replacement-browser-secret");
  await save.click();
  await page.getByRole("status").filter({ hasText: "Saved. Existing sessions" }).waitFor();
  let actual = JSON.parse(await readFile(join(root, "existing", "config.json"), "utf8"));
  assert.equal(actual.count, 4); assert.equal(actual.apiKey, "replacement-browser-secret"); assert.equal(actual.extra, "preserve");
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  assert.equal((await page.locator("body").innerText()).includes("replacement-browser-secret"), false);
  await page.getByLabel('"list"', { exact: true }).fill("["); await save.click();
  await page.getByRole("alert").waitFor(); assert.equal(actual.count, 4);
  await page.getByRole("button", { name: "Cancel changes", exact: true }).click();
  assert.equal(await page.getByLabel('"list"', { exact: true }).inputValue(), "[\n  1,\n  null\n]");
  await page.getByLabel('"count"', { exact: true }).fill("7");
  actual.count = 8; await writeFile(join(root, "existing", "config.json"), JSON.stringify(actual));
  await save.click(); await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /draft is kept/);
  assert.equal(await page.getByLabel('"count"', { exact: true }).inputValue(), "7");
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.getByLabel('"count"', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('"count"', { exact: true }).inputValue(), "8");
  await page.getByRole("button", { name: "example", exact: true }).click();
  const countField = page.locator(".config-field").filter({ has: page.locator("label", { hasText: '"count"' }) });
  await countField.getByRole("button", { name: "Add field", exact: true }).click();
  assert.equal(await save.isDisabled(), true);
  await page.getByRole("checkbox").check(); await save.click(); await page.getByRole("status").filter({ hasText: "Saved. Existing sessions" }).waitFor();
  assert.deepEqual(JSON.parse(await readFile(join(root, "example", "config.json"), "utf8")), { count: 3 });
  await page.getByRole("button", { name: "existing", exact: true }).click();
  await page.getByLabel('"count"', { exact: true }).waitFor();
  const secretField = page.locator(".config-field").filter({ has: page.locator("label", { hasText: '"apiKey"' }) });
  await secretField.getByRole("button", { name: "Remove field", exact: true }).click();
  await save.click(); await page.getByRole("status").filter({ hasText: "Saved. Existing sessions" }).waitFor();
  assert.equal(Object.hasOwn(JSON.parse(await readFile(join(root, "existing", "config.json"), "utf8")), "apiKey"), false);
  for (const [language, removeName] of [["简体中文", "移除字段"], ["繁體中文", "移除欄位"], ["English", "Remove field"]]) {
    await page.getByRole("button", { name: language, exact: true }).click();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${language} ${width}px overflow`);
      await assertRemoveOnRight(count, removeName);
    }
  }
  await page.screenshot({ path: "/tmp/pi-plugin-config-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: "/tmp/pi-plugin-config-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "empty", exact: true }).click();
  await page.getByText(/No editable configuration found/).waitFor();
  assert.equal(await save.count(), 0);
  await page.getByRole("button", { name: "standalone", exact: true }).click();
  await page.getByLabel('"distill_max_tokens"', { exact: true }).fill("1500");
  await save.click();
  await page.getByRole("status").filter({ hasText: "Saved. Existing sessions" }).waitFor();
  assert.equal(JSON.parse(await readFile(join(root, "agent", "extensions", "hindsight-distill", "config.json"), "utf8")).distill_max_tokens, 1500);
  assert.deepEqual(issues, []);
  console.log("PASS: real API/auth, typed edits, secrets, JSON errors, cancel, conflict drafts, creation, empty state, standalone extension config, three locales and desktop/320px layout");
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill("SIGTERM"); await once(server, "exit"); }
  await rm(root, { recursive: true, force: true });
}
