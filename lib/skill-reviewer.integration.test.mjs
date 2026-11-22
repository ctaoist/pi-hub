import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { getCurrentTools, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { runSkillReviewer, validateReviewerModel } = await jiti.import("./skill-reviewer.ts");

test("real SDK reviewer uses the explicit model/level, only bounded snapshot tools, no project extensions or persistent chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-sdk-"));
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent"); process.env.PI_OFFLINE = "1";
  try {
    await mkdir(join(dir, ".pi", "extensions"), { recursive: true });
    await writeFile(join(dir, ".pi", "extensions", "forbidden.ts"), 'throw new Error("Project extension must not load");');
    const faux = fauxProvider({ models: [{ id: "review-model", reasoning: false }] });
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider); await runtime.refresh({ allowNetwork: false });
    const model = faux.getModel("review-model");
    const config = { enabled: true, provider: model.provider, modelId: model.id, thinkingLevel: "off" };
    let requests = 0;
    faux.setResponses([
      (ctx) => {
        requests++;
        assert.deepEqual(getCurrentTools(ctx.messages).map((t) => t.name), ["read_skill", "read_evidence"]);
        return fauxAssistantMessage([fauxToolCall("read_skill", { id: "skill-0" })], { stopReason: "toolUse" });
      },
      () => { requests++; return fauxAssistantMessage([fauxText(JSON.stringify({ summary: "No verified new learning", candidates: [] }))]); },
    ]);
    const result = await runSkillReviewer({ cwd: dir, config, signal: new AbortController().signal,
      evidence: [{ id: "e", text: "task verified", sessionId: "s", leafId: "l", at: 1 }],
      skills: [{ id: "skill-0", name: "existing", description: "A skill", locked: true, content: "Existing rules" }],
    }, runtime);
    assert.equal(requests, 2); assert.equal(result.output.candidates.length, 0);
    // Retrieval cannot read a live file, and the initial prompt only advertises available windows.
    faux.setResponses([
      (ctx) => {
        const prompt = JSON.stringify(ctx.messages);
        assert.equal(prompt.includes("bounded-middle-evidence"), false);
        return fauxAssistantMessage([fauxToolCall("read_evidence", { id: "e" })], { stopReason: "toolUse" });
      },
      (ctx) => {
        assert.ok(JSON.stringify(ctx.messages).includes("bounded-middle-evidence"));
        return fauxAssistantMessage([fauxText('{"summary":"Retrieved evidence","candidates":[]}')]);
      },
    ]);
    await runSkillReviewer({ cwd: dir, config, signal: new AbortController().signal, skills: [],
      evidence: [{ id: "e", sessionId: "s", leafId: "l", at: 1, text: "Truncated", truncated: true,
        windows: [{ entryId: "middle", text: "bounded-middle-evidence" }] }] }, runtime);
    // The first completed response can cross the budget; no second provider request is allowed.
    let budgetRequests = 0;
    faux.setResponses([
      () => {
        budgetRequests++;
        // Faux computes usage from the real prompt; it ignores caller-provided usage.
        return fauxAssistantMessage([fauxToolCall("read_evidence", { id: "e" })], { stopReason: "toolUse" });
      },
      () => { budgetRequests++; throw new Error("Must not make another paid request"); },
    ]);
    let observedUsage;
    await assert.rejects(runSkillReviewer({ cwd: dir, config, signal: new AbortController().signal, skills: [], tokenAllowance: 100,
      onUsage: (usage) => { observedUsage = usage; }, evidence: [{ id: "e", sessionId: "s", leafId: "l", at: 1, text: "Verified" }] }, runtime), /budget/);
    assert.equal(budgetRequests, 1); assert.ok(observedUsage.tokens >= 200);
    // Trust/cancellation changes must be checked again before every model request,
    // not only once at dispatch or by a one-second monitor.
    let policyCalls = 0, providerCalls = 0;
    faux.setResponses([() => {
      providerCalls++;
      return fauxAssistantMessage([fauxToolCall("read_evidence", { id: "e" })], { stopReason: "toolUse" });
    }, () => { providerCalls++; throw new Error("unauthorized second call"); }]);
    await assert.rejects(runSkillReviewer({ cwd: dir, config, signal: new AbortController().signal, skills: [],
      beforeRequest: () => { if (++policyCalls === 3) throw new Error("policy revoked"); },
      evidence: [{ id: "e", sessionId: "s", leafId: "l", at: 1, text: "Verified" }] }, runtime), /policy revoked/);
    assert.equal(providerCalls, 1);
    await assert.rejects(validateReviewerModel({ ...config, modelId: "missing" }, runtime), /unavailable/);
    await assert.rejects(validateReviewerModel({ ...config, thinkingLevel: "high" }, runtime), /reasoning/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runSkillReviewer({ cwd: dir, config, signal: controller.signal, evidence: [], skills: [] }, runtime), /abort/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
