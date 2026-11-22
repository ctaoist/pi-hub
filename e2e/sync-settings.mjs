// Uses the existing dev server but mocks /api/sync: never writes real agent configuration.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => console.error("Browser error:", error.message));
  await page.addInitScript(() => { localStorage.setItem("pi-locale", "en"); });
  const state = { available: true, config: { node: { id: "local", name: "Desktop", platform: "linux" }, enabled: false, conflictStrategy: "mtime" }, nodes: [] };
  let holdRefresh;
  let releaseRefresh;
  let refreshStarted;
  let announceRefresh;
  await page.route("**/api/sync", async (route) => {
    const body = route.request().postDataJSON();
    if (!body && holdRefresh) { announceRefresh(); await holdRefresh; holdRefresh = undefined; }
    if (body?.action === "add-node") {
      assert.equal(body.password, "test-only-password");
      assert.equal(Object.hasOwn(body, "localUrl"), false);
      state.nodes.push({ id: "remote", name: body.name, url: body.url, platform: "windows", enabled: true, status: "online" });
    } else if (body?.action === "remove-node") state.nodes = [];
    else if (body?.action === "options") Object.assign(state.config, body);
    else if (body?.action === "node-enabled") state.nodes[0].enabled = body.enabled;
    await route.fulfill({ json: state });
  });
  const baseUrl = process.env.PI_SYNC_E2E_URL ?? "http://127.0.0.1:30141";
  if (process.env.PI_SYNC_E2E_PASSWORD) {
    const login = await page.request.post(`${baseUrl}/api/web-auth`, { data: { password: process.env.PI_SYNC_E2E_PASSWORD } });
    assert.equal(login.ok(), true, "Existing Pi Web login must succeed");
  }
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).pathname === "/login") throw new Error("Set PI_SYNC_E2E_PASSWORD to test the authenticated dev server");
  await page.waitForURL((url) => url.pathname === "/");
  // A server-rendered button can be visible before React has attached handlers.
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Settings"]');
    return button && Object.keys(button).some((key) => key.startsWith("__reactProps"));
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
  await page.getByRole("button", { name: "Sync", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Laptop");
  await page.getByLabel("Remote HTTPS URL", { exact: true }).fill("https://laptop.example");
  assert.equal(await page.getByLabel("This node's HTTPS URL", { exact: true }).count(), 0);
  await page.getByLabel("Remote Pi Web password", { exact: true }).fill("test-only-password");
  await page.getByRole("button", { name: "Connect node", exact: true }).click();
  await page.locator(".settings-sync-node").waitFor();
  assert.equal(await page.getByLabel("Remote Pi Web password", { exact: true }).inputValue(), "");
  await page.getByRole("switch", { name: "Automatic two-way sync" }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Automatic two-way sync"]').getAttribute("aria-checked") === "true");
  await page.locator("#settings-sync-strategy").selectOption("authority");
  await page.locator("#settings-sync-authority").waitFor();
  // A refresh must block policy writes, or its late response can restore old policy
  // and an invalidated loading request can leave the panel permanently disabled.
  holdRefresh = new Promise((resolve) => { releaseRefresh = resolve; });
  refreshStarted = new Promise((resolve) => { announceRefresh = resolve; });
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await refreshStarted;
  const strategyBlocked = await page.locator("#settings-sync-strategy").isDisabled();
  releaseRefresh();
  assert.equal(strategyBlocked, true, "policy writes must wait for a refresh");
  await page.waitForFunction(() => !document.querySelector("#settings-sync-strategy").disabled);
  await page.screenshot({ path: "/tmp/pi-sync-settings-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator(".settings-dialog-surface").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
  await page.screenshot({ path: "/tmp/pi-sync-settings-mobile.png" });
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".settings-sync-node"));
  console.log("PASS: Sync add, password clearing, toggle, authority, remove and mobile layout (mock API)");
} finally { await browser.close(); }
