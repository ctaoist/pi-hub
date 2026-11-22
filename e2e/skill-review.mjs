import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";
import { chromium } from "playwright";

// Offline layout smoke: production components, no server credentials or model requests.
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { SkillEvolutionPanel } = await jiti.import("../components/SkillEvolutionPanel.tsx");
const { SkillProtectionControl } = await jiti.import("../components/SkillProtectionControl.tsx");
const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
  React.createElement("div", { style: { padding: 16, width: "100%", boxSizing: "border-box" } },
    React.createElement(SkillEvolutionPanel, { cwd: "/test", skills: [], onSkillsChanged() {} }),
    React.createElement(SkillProtectionControl, { cwd: "/test", skills: [{ name: "external", filePath: "/test/SKILL.md", install: { source: "org/skills" }, protection: { locked: true, defaultLocked: true, overridden: false } }], onChanged() {} }),
  )));
const css = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent(`<style>:root{--bg:#fff;--bg-panel:#f7f7f7;--border:#ddd;--text:#222;--text-muted:#666;--text-dim:#777;--accent:#4264bb}body{margin:0;font:14px system-ui}*{box-sizing:border-box}button,select{font:inherit}button{border:0;background:transparent}${css}</style>${html}`);
    assert.equal(await page.getByRole("switch", { name: "Lock skill", exact: true }).isEnabled(), true);
    assert.equal(await page.getByLabel("Review reasoning level", { exact: true }).count(), 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, `${width}px horizontal overflow`);
    await page.screenshot({ path: `/tmp/pi-hub-skill-review-${width}.png`, fullPage: true });
    await page.close();
  }
  console.log("PASS: review/protection layout at 1280, 390 and 320px; screenshots in /tmp/pi-hub-skill-review-*.png");
} finally { await browser.close(); }
