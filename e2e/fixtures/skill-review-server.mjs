// Isolated HTTP fixture: real proxy/auth, routes, state, locks and SDK reviewer. No Next dev/build.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
const cwd = join(process.env.REVIEW_FIXTURE_ROOT, "project");
mkdirSync(join(cwd, ".git"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(process.env.REVIEW_FIXTURE_ROOT, "agent"); process.env.PI_OFFLINE = "1";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { proxy } = await jiti.import("../../proxy.ts");
const auth = await jiti.import("../../app/api/web-auth/route.ts");
const evolution = await jiti.import("../../app/api/skills/evolution/route.ts");
const protect = await jiti.import("../../app/api/skills/protection/route.ts");
const skills = await jiti.import("../../app/api/skills/route.ts");
const service = await jiti.import("../../lib/skill-evolution-service.ts");
const { recordReviewTurn } = await jiti.import("../../lib/skill-evolution-evidence.ts");
const { listSessionSummaries } = await jiti.import("../../lib/session-reader.ts");
const { allowFileRoot } = await jiti.import("../../lib/file-access.ts"); allowFileRoot(cwd);
const faux = fauxProvider({ models: [{ id: "review", reasoning: false }] });
const runtime = await ModelRuntime.create({ authPath: join(process.env.REVIEW_FIXTURE_ROOT, "auth.json"), modelsPath: null, refreshOnCreate: false });
runtime.registerNativeProvider(faux.provider); await runtime.refresh({ allowNetwork: false });
const model = faux.getModel("review");
globalThis.__piWebSharedModelRuntime = { agentDir: process.env.PI_CODING_AGENT_DIR, runtime: Promise.resolve(runtime), queueKey: "review-e2e", expiresAt: Infinity };
const body = (text) => `---\nname: fixture-guide\ndescription: A validation procedure\n---\n${text}\n`;
const file = join(cwd, ".pi", "skills", "fixture-guide", "SKILL.md");
if (!existsSync(file)) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, body("Run focused tests.")); }
const { trustProject } = await jiti.import("../../lib/project-trust.ts");
trustProject(cwd, process.env.PI_CODING_AGENT_DIR);
let waiting, released, currentSession;
const respond = (content) => fauxAssistantMessage([fauxText(JSON.stringify(content))]);
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const url = `http://${req.headers.host}${req.url}`;
    const request = new NextRequest(url, { method: req.method, headers: req.headers,
      ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) });
    let response = proxy(request);
    if (response.headers.get("x-middleware-next") === "1") {
      const path = new URL(url).pathname;
      if (path === "/api/web-auth") response = await auth[req.method](request);
      else if (path === "/api/skills/evolution") response = await evolution[req.method](request);
      else if (path === "/api/skills/protection") response = await protect.POST(request);
      else if (path === "/api/skills") response = await skills.GET(request);
      else if (path === "/api/models") response = Response.json({ modelList: [{ ...model, name: "Fixture reviewer" }], thinkingLevels: { [`${model.provider}:${model.id}`]: ["off"] } });
      else if (path === "/api/sessions") response = Response.json({ sessions: await listSessionSummaries() });
      else if (path === "/api/fixture" && req.method === "POST") {
        const data = await request.json();
        if (data.action === "complete") {
          currentSession = SessionManager.create(cwd);
          currentSession.appendMessage({ role: "user", content: "Verify the corrected workflow", timestamp: Date.now() });
          currentSession.appendMessage(fauxAssistantMessage([fauxText("Tests passed after correction")]));
          recordReviewTurn(cwd, currentSession.getSessionId(), () => currentSession.getBranch());
        } else if (data.action === "prepare") {
          released = false; waiting = false;
          let finish; const gate = new Promise((r) => { finish = r; });
          globalThis.fixtureRelease = () => { released = true; finish(); };
          faux.setResponses([
            async (ctx) => {
              waiting = true;
              if (data.hold) await gate;
              const prompt = ctx.messages.find((m) => m.role === "user");
              const text = typeof prompt.content === "string" ? prompt.content : prompt.content.filter((b) => b.type === "text").map((b) => b.text).join("");
              const input = JSON.parse(text); globalThis.fixtureEvidence = input.evidence[0].id;
              return fauxAssistantMessage([fauxToolCall("read_skill", { id: "skill-0" })], { stopReason: "toolUse" });
            },
            () => respond(data.unchanged ? { summary: "No verified new rule", candidates: [] } : { summary: "Verified validation improvement", candidates: [{ target: "skill-0", name: "fixture-guide", reason: "The focused check caught a regression", evidenceIds: [globalThis.fixtureEvidence], content: body("Run focused tests, then verify the full suite before reporting success.") }] }),
          ]);
        } else if (data.action === "release") globalThis.fixtureRelease?.();
        else if (data.action === "check") await service.checkSkillReviews();
        response = Response.json({ waiting, released, sessionId: currentSession?.getSessionId(), cwd });
      } else if (path === "/api/fixture") response = Response.json({ waiting, released, cwd });
      else if (path === "/client.js") response = new Response(readFileSync(join(process.env.REVIEW_FIXTURE_ROOT, "bundle", "client.js")), { headers: { "content-type": "text/javascript" } });
      else if (path === "/") response = new Response(`<html><head><meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#f7f7f7;--border:#ddd;--text:#222;--text-muted:#666;--text-dim:#777;--accent:#4264bb}body{margin:0;font:14px system-ui}*{box-sizing:border-box}button,select{font:inherit}button{background:transparent;color:inherit;border:0}${readFileSync("app/settings.css", "utf8")}</style></head><body data-cwd="${cwd}"><div id="root"></div><script src="/client.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
      else response = new Response("Not found", { status: 404 });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { console.error(error); res.writeHead(500); res.end("Fixture failed"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.send({ port: server.address().port, cwd });
process.on("SIGTERM", () => { service.stopSkillReviewScheduler(); server.close(() => process.exit()); });
