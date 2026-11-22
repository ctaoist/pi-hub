import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
const source = await readFile(new URL("./SyncSettings.tsx", import.meta.url), "utf8");
const panel = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url);
const navigation = await jiti.import("../lib/settings-navigation.ts");
const { getLocalePlugin } = await jiti.import("../lib/i18n/registry.ts");

test("Sync is a global settings section with an explicit submit button and no browser credential storage", () => {
  assert.equal(navigation.settingsSectionRequiresProject("sync"), false);
  assert.ok(navigation.SETTINGS_SECTION_VALUES.includes("sync"));
  assert.match(panel, /sectionHost\("sync", <SyncSettings/);
  assert.match(source, /ConfigButton type="submit"/);
  assert.match(source, /setPassword\(""\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  assert.match(source, /syncWaitingAuthority/);
  assert.match(source, /syncDecision/);
  assert.match(source, /syncLastSync/);
});

test("all literal Sync UI keys are translated in English, Simplified and Traditional Chinese", () => {
  const keys = [...source.matchAll(/"(settings\.sync\w*)"/g)].map((match) => match[1]);
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = getLocalePlugin(locale).messages;
    for (const key of keys) assert.equal(typeof messages[key], "string", `${locale}: ${key}`);
  }
});
