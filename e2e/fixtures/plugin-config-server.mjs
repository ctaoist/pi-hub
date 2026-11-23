// Isolated production API/proxy fixture. Writes only inside PLUGIN_CONFIG_FIXTURE_ROOT.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";
const root = process.env.PLUGIN_CONFIG_FIXTURE_ROOT;
const cwd = join(root, "project"); const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const packages = ["existing", "example", "empty"].map((name) => join(root, name));
for (const path of [cwd, agentDir, ...packages]) mkdirSync(path, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }));
writeFileSync(join(root, "existing", "config.json"), JSON.stringify({ count: 1, enabled: true, apiKey: "browser-test-secret", list: [1, null], nested: { label: "original" }, extra: "preserve" }));
writeFileSync(join(root, "example", "config.example.json"), JSON.stringify({ count: 3, nested: { label: "sample" }, apiKey: "example-secret" }));
const standalone = join(agentDir, "extensions", "hindsight-distill");
mkdirSync(standalone, { recursive: true });
writeFileSync(join(standalone, "index.ts"), "throw new Error('must not execute');");
writeFileSync(join(standalone, "config.json"), JSON.stringify({ distill_enabled: true, distill_max_tokens: 1000 }));
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { proxy } = await jiti.import("../../proxy.ts");
const auth = await jiti.import("../../app/api/web-auth/route.ts");
const config = await jiti.import("../../app/api/plugins/config/route.ts");
const { allowFileRoot } = await jiti.import("../../lib/file-access.ts"); allowFileRoot(cwd);
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = new NextRequest(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers,
      ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: Buffer.concat(chunks) }) });
    let response = proxy(request);
    if (response.headers.get("x-middleware-next") === "1") {
      const path = new URL(request.url).pathname;
      if (path === "/api/web-auth") response = await auth[req.method](request);
      else if (path === "/api/plugins/config") response = await config[req.method](request);
      else if (path === "/client.js") response = new Response(readFileSync(join(root, "bundle", "client.js")), { headers: { "content-type": "text/javascript" } });
      else if (path === "/") response = new Response(`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--bg:#fff;--bg-panel:#f7f7f7;--border:#ddd;--text:#222;--text-muted:#666;--text-dim:#777;--accent:#4264bb;--font-mono:monospace}body{margin:0;font:14px system-ui}*{box-sizing:border-box}button,select{font:inherit}button{color:inherit}${readFileSync("app/settings.css", "utf8")}</style></head><body data-root="${root}" data-cwd="${cwd}"><div id="root"></div><script src="/client.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
      else response = new Response("Not found", { status: 404 });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end("Fixture failed"); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
process.send({ port: server.address().port, cwd });
process.on("SIGTERM", () => server.close(() => process.exit()));
