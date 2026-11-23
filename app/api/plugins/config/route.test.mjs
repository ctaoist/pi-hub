import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-plugin-config-route-"));
const agentDir = join(root, "agent"); const cwd = join(root, "cwd"); const pkg = join(root, "plugin");
for (const path of [agentDir, cwd, pkg]) mkdirSync(path);
mkdirSync(join(cwd, ".pi"));
writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [pkg] }));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
writeFileSync(join(pkg, "config.json"), JSON.stringify({ count: 1, apiKey: "route-test-secret" }));
// A configuration request must not evaluate the extension, even if it is broken.
writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fixture", pi: { extensions: ["index.ts"] } }));
writeFileSync(join(pkg, "index.ts"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(root, "EXECUTED"))}, 'bad'); throw new Error('must not import');`);
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
const { GET, POST } = await jiti.import("./route.ts");
const { trustProject } = await jiti.import("../../../../lib/project-trust.ts");
allowFileRoot(cwd);
after(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const identity = { cwd, source: pkg, scope: "global" };
function get(params = {}, headers = {}) {
  return GET(new Request(`http://localhost/api/plugins/config?${new URLSearchParams({ ...identity, ...params })}`, { headers: { host: "localhost", ...headers } }));
}
function post(body = {}, headers = {}) {
  return POST(new Request("http://localhost/api/plugins/config", { method: "POST", headers: { host: "localhost", "content-type": "application/json", ...headers }, body: JSON.stringify({ ...identity, ...body }) }));
}

test("GET is no-store, masks credentials, and never imports plugins or writes files", async () => {
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json();
  assert.equal(data.files.length, 1);
  assert.equal(JSON.stringify(data).includes("route-test-secret"), false);
  assert.equal(existsSync(join(root, "EXECUTED")), false);
  assert.equal(existsSync(join(pkg, "config.json.lock")), false);
});

test("same-origin, cwd access, scope, installed identity and project trust are enforced", async () => {
  assert.equal((await get({}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post({}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post({}, { "content-type": "text/plain" })).status, 415);
  assert.equal((await get({ scope: "invalid" })).status, 400);
  assert.equal((await get({ cwd: join(root, "not-allowed") })).status, 403);
  assert.equal((await get({ source: "npm:not-configured" })).status, 404);
  assert.equal((await get({ scope: "project" })).status, 403);
});

test("POST selects only server-discovered ids, patches changed fields and reports stale writes", async () => {
  const doc = (await (await get()).json()).files[0];
  const patch = { id: doc.id, revision: doc.revision, changes: [{ path: ["count"], action: "set", value: 5 }] };
  assert.equal((await post({ ...patch, id: "../../settings.json" })).status, 404);
  const response = await post({ ...patch, path: join(agentDir, "settings.json") });
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(await response.json()).includes("route-test-secret"), false);
  assert.deepEqual(JSON.parse(readFileSync(join(pkg, "config.json"), "utf8")), { count: 5, apiKey: "route-test-secret" });
  assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")), { packages: [pkg] });
  assert.equal((await post(patch)).status, 409);
  assert.equal(existsSync(join(root, "EXECUTED")), false);
});

test("standalone directory extensions edit adjacent config without importing or resolving packages", async () => {
  const extensionDir = join(agentDir, "extensions", "hindsight-distill");
  mkdirSync(extensionDir, { recursive: true });
  const entry = join(extensionDir, "index.ts");
  writeFileSync(entry, readFileSync(join(pkg, "index.ts")));
  writeFileSync(join(extensionDir, "config.json"), '{"distill_enabled":true,"distill_max_tokens":1000}');
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:must-not-install-from-config-request"], extensions: [`-${entry}`] }));
  const selection = { kind: "extension", source: entry };
  try {
    const response = await get(selection);
    assert.equal(response.status, 200);
    const doc = (await response.json()).files[0];
    assert.equal(doc.id, "extension");
    assert.equal(doc.path, join(extensionDir, "config.json"));
    assert.equal(doc.fields.length, 2);
    const saved = await post({ ...selection, id: doc.id, revision: doc.revision, changes: [{ path: ["distill_enabled"], action: "set", value: false }] });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(readFileSync(join(extensionDir, "config.json"), "utf8")).distill_enabled, false);
    assert.equal(existsSync(join(root, "EXECUTED")), false);
    assert.equal(existsSync(join(agentDir, "npm")), false);
    rmSync(entry);
    assert.equal((await post({ ...selection, id: doc.id, revision: doc.revision, changes: [{ path: ["distill_enabled"], action: "set", value: true }] })).status, 404);
  } finally { writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] })); }
});

test("standalone identities cannot authorize arbitrary files or the shared extensions config", async () => {
  assert.equal((await get({ kind: "extension", source: join(pkg, "index.ts") })).status, 404);
  assert.equal((await get({ kind: "bad" })).status, 400);
  const shared = join(agentDir, "extensions"); mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, "index.ts"), "export default () => {};");
  writeFileSync(join(shared, "config.json"), '{"unrelated":true}');
  const response = await get({ kind: "extension", source: join(shared, "index.ts") });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).files, []);
});

test("project standalone extensions require trust and exact scope, then support example-only creation", async () => {
  const dir = join(cwd, ".pi", "extensions", "example"); mkdirSync(dir, { recursive: true });
  const entry = join(dir, "index.js"); writeFileSync(entry, "throw new Error('must not import');");
  writeFileSync(join(dir, "config.example.json"), '{"enabled":true}');
  const identity = { kind: "extension", source: entry, scope: "project" };
  assert.equal((await get(identity)).status, 403);
  trustProject(cwd, agentDir);
  assert.equal((await get({ ...identity, scope: "global" })).status, 404);
  const response = await get(identity); assert.equal(response.status, 200);
  const doc = (await response.json()).files[0]; assert.equal(doc.exists, false);
  const saved = await post({ ...identity, id: doc.id, revision: doc.revision, confirmCreate: true, changes: [{ path: ["enabled"], action: "set", value: false }] });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), { enabled: false });
});

test("unregistered package cannot be written using a previously read revision", async () => {
  const doc = (await (await get()).json()).files[0];
  writeFileSync(join(agentDir, "settings.json"), '{"packages":[]}');
  try {
    assert.equal((await post({ id: doc.id, revision: doc.revision, changes: [{ path: ["count"], action: "set", value: 6 }] })).status, 404);
  } finally { writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] })); }
});
