import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { SkillEvolutionPanel } = await jiti.import("./SkillEvolutionPanel.tsx");
const { SkillProtectionControl } = await jiti.import("./SkillProtectionControl.tsx");
const { skillReviewDiff } = await jiti.import("../lib/skill-review-diff.ts");
const render = (component, props) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(component, props)));

test("review has independent model/reasoning controls, consent and bulk protection", () => {
  const html = render(SkillEvolutionPanel, { cwd: "/project", skills: [], onSkillsChanged() {} });
  for (const label of ["Review model", "Review reasoning level", "token charges", "Review now", "Unlock listed skills", "Daily token budget", "Batch timeout (minutes)", "Select a conversation to review", "Archive expired records"]) assert.ok(html.includes(label), label);
  assert.match(html, /aria-label="Review reasoning level"/);
});
test("installed and unknown skills expose an enabled lock switch, independent of invocation", () => {
  for (const source of ["builtin:core", "npm:external", "unknown", "auto"]) {
    const html = render(SkillProtectionControl, { cwd: "/project", skills: [{ name: "skill", sourceInfo: { source }, protection: { locked: true, overridden: false, defaultLocked: true } }], onChanged() {} });
    assert.match(html, /role="switch"[^>]*aria-checked="true"/);
    assert.doesNotMatch(html, /disabled=/);
    assert.ok(html.includes("Any skill can be unlocked"));
  }
});
test("lock heading reports the same current state as the switch, including the safe fallback", () => {
  for (const locked of [true, false, undefined]) {
    const html = render(SkillProtectionControl, { cwd: "/project", skills: [{ name: "skill", ...(locked === undefined ? {} : { protection: { locked, overridden: false, defaultLocked: true } }) }], onChanged() {} });
    assert.ok(html.includes(`<span class="config-field-label">${locked === false ? "Unlocked" : "Locked"}</span>`));
    assert.match(html, new RegExp(`role="switch"[^>]*aria-checked="${locked ?? true}"`));
    // Keep a stable accessible control name while aria-checked communicates its state.
    assert.match(html, /aria-label="Lock skill"/);
  }
});
test("line comparison shows added/removed content with bounded unchanged context", () => {
  assert.deepEqual(skillReviewDiff("a\nb\nc", "a\nx\nc"), [
    { kind: "context", text: "a" }, { kind: "removed", text: "b" }, { kind: "added", text: "x" }, { kind: "context", text: "c" },
  ]);
  assert.deepEqual(skillReviewDiff(null, "new"), [{ kind: "added", text: "new" }]);
});
