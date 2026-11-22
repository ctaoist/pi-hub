import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const root = await mkdtemp(join(tmpdir(), "pi-review-browser-"));
const password = "isolated-review-fixture-password";
let server, browser;
try {
  await mkdir(join(root, "home"));
  await new Promise((resolveBuild, reject) => webpack({ mode: "development", devtool: false, target: "web",
    entry: resolve("e2e/fixtures/skill-review-client.tsx"), output: { path: join(root, "bundle"), filename: "client.js" },
    resolve: { extensions: [".tsx", ".ts", ".js"], alias: { "@": process.cwd() } },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: resolve("e2e/fixtures/skill-review-loader.cjs") }] },
  }, (error, stats) => error || stats.hasErrors() ? reject(error ?? new Error(stats.toString({ all: false, errors: true }))) : resolveBuild()));
  async function start() {
    server = fork(resolve("e2e/fixtures/skill-review-server.mjs"), [], { env: { ...process.env,
      HOME: join(root, "home"), REVIEW_FIXTURE_ROOT: root, PI_WEB_PASSWORD: password }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let errors = ""; server.stderr.on("data", (chunk) => { errors += chunk; });
    const result = await Promise.race([once(server, "message").then(([data]) => data), once(server, "exit").then(() => { throw new Error(errors); })]);
    return { ...result, url: `http://127.0.0.1:${result.port}` };
  }
  let info = await start();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext();
  const issues = [];
  context.on("page", (page) => page.on("pageerror", (e) => issues.push(e.message)));
  async function login() {
    assert.equal((await context.request.get(`${info.url}/api/skills/evolution?cwd=${encodeURIComponent(info.cwd)}`)).status(), 401);
    assert.equal((await context.request.post(`${info.url}/api/web-auth`, { data: { password } })).status(), 200);
  }
  const post = async (path, data) => {
    const response = await context.request.post(`${info.url}${path}`, { data });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const fixture = (data) => post("/api/fixture", data);
  const status = async () => (await context.request.get(`${info.url}/api/skills/evolution?cwd=${encodeURIComponent(info.cwd)}`)).json();
  async function until(fn, message) {
    for (let n = 0; n < 300; n++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error(message);
  }
  await login();
  let page = await context.newPage(); await page.goto(info.url);
  await page.getByRole("button", { name: "Fixture reviewer" }).count();
  // Production model selector, reasoning, opt-in and save.
  const selector = page.locator(".model-selector");
  if (await selector.count()) await selector.getByRole("button").first().click();
  else await page.getByRole("button", { name: /select.*model/i }).click();
  await page.getByText("Fixture reviewer", { exact: true }).click();
  await page.getByRole("switch", { name: "Automatic review for this project" }).click();
  await page.getByRole("button", { name: "Save review settings", exact: true }).click();
  await until(async () => (await status()).config.enabled, "configuration did not save").catch(async (e) => { console.log(await page.locator("main").innerText()); throw e; });
  await fixture({ action: "complete" });
  await until(async () => (await status()).pendingTurns === 1, "completion was not collected");
  // A remote refresh updates state/locks without discarding an unsaved local policy.
  await page.getByText("Schedule, budget & retention", { exact: true }).click();
  await page.getByLabel("Daily token budget", { exact: true }).fill("123456");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await until(async () => (await page.locator("main").innerText()).includes("1 turns pending review"), "idle queue refresh did not arrive");
  assert.equal(await page.getByLabel("Daily token budget", { exact: true }).inputValue(), "123456");
  await fixture({ action: "prepare", hold: true });
  await page.reload();
  await page.getByRole("button", { name: "Review now", exact: true }).click();
  await until(async () => (await status()).runs[0]?.phase === "reviewing", "review did not start");
  await page.close(); // HTTP request/browser is not the worker lifetime.
  await fixture({ action: "release" });
  await until(async () => (await status()).runs[0]?.status === "pending", "closed-browser review did not complete");
  page = await context.newPage(); await page.goto(info.url);
  await page.getByRole("button", { name: /Candidates ready/ }).click();
  await page.getByText("Compare changes", { exact: true }).click();
  assert.ok((await page.locator("pre").allTextContents()).some((t) => t.includes("full suite")));
  const second = await context.newPage(); await second.goto(info.url);
  const secondLock = second.getByRole("switch", { name: "Lock skill", exact: true });
  const secondHeading = second.locator(".config-field").filter({ has: secondLock }).locator(".config-field-label");
  await until(async () => await secondHeading.textContent() === "Unlocked", "initial unlocked heading missing");
  await secondLock.click();
  await until(async () => await secondHeading.textContent() === "Locked", "heading did not follow locking");
  await page.bringToFront(); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await until(() => page.getByRole("button", { name: "Approve", exact: true }).isDisabled(), "lock did not synchronize");
  const lock = page.getByRole("switch", { name: "Lock skill", exact: true });
  const heading = page.locator(".config-field").filter({ has: lock }).locator(".config-field-label");
  await until(async () => await heading.textContent() === "Locked", "remote lock heading did not synchronize");
  await lock.click();
  await until(async () => await heading.textContent() === "Unlocked", "heading did not follow unlocking");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const skillPath = join(info.cwd, ".pi", "skills", "fixture-guide", "SKILL.md");
  await until(async () => (await readFile(skillPath, "utf8")).includes("full suite"), "approval did not write");
  await page.getByRole("button", { name: "Roll back", exact: true }).click();
  await until(async () => !(await readFile(skillPath, "utf8")).includes("full suite"), "rollback did not restore");
  await page.getByRole("button", { name: "Archive record", exact: true }).click();
  await until(async () => (await status()).runs.length === 0, "archive did not clear finished history");
  // Cancel a manual reviewer; disabling automation must not cancel explicitly requested work.
  await fixture({ action: "complete" }); await fixture({ action: "prepare", hold: true });
  const state = await status();
  await post("/api/skills/evolution", { action: "configure", cwd: info.cwd, config: { ...state.config, minTurns: 1, intervalHours: 1 } });
  await page.reload(); await page.getByRole("button", { name: "Review now", exact: true }).click();
  await until(async () => (await status()).runs[0]?.phase === "reviewing", "second review did not start");
  await page.getByRole("button", { name: "Cancel review", exact: true }).click();
  await until(async () => (await status()).runs[0]?.errorCode === "review-cancelled", "cancel did not finish");
  await fixture({ action: "release" });
  // Abrupt restart retains failed claims and never calls a provider automatically on recovery.
  await fixture({ action: "prepare", hold: true });
  await page.getByRole("button", { name: "Retry this batch", exact: true }).click();
  await until(async () => (await status()).runs[0]?.phase === "reviewing", "retry did not start");
  await page.close(); await second.close();
  server.kill("SIGKILL"); await once(server, "exit");
  info = await start(); await context.clearCookies(); await login();
  // A killed process leaves a heartbeat lease; recovery must wait for its real stale interval.
  await until(async () => { await fixture({ action: "check" }); return (await status()).runs[0].errorCode === "review-interrupted"; }, "stale review lease was not recovered");
  assert.equal((await status()).pendingTurns, 1);
  page = await context.newPage(); await page.goto(info.url);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByText("Schedule, budget & retention", { exact: true }).evaluate((el) => { el.parentElement.open = true; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px overflow`);
    await page.screenshot({ path: `/tmp/pi-hub-review-workflow-${width}.png`, fullPage: true });
  }
  assert.deepEqual(issues, []);
  console.log("PASS authenticated production-component workflow: configure, collect, detached review, compare, cross-window lock/unlock, approve, rollback, archive, cancel/retry, process restart; 1280/390/320px. No paid calls or real-service writes.");
} finally {
  await browser?.close();
  if (server?.exitCode === null && server?.signalCode === null) { server.kill("SIGTERM"); await once(server, "exit"); }
  await rm(root, { recursive: true, force: true });
}
