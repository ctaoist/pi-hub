import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-credential-route-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { POST } = await jiti.import("./route.ts");
const authPath = join(testAgentDir, "auth.json");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function post(body) {
  return new Request("http://localhost/api/models-config/credential", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  });
}

const credentials = async () => JSON.parse(await readFile(authPath, "utf8"));

test("a renamed provider's key follows it, and a key already under the new id wins", async () => {
  await writeFile(authPath, JSON.stringify({
    "old-gateway": { type: "api_key", key: "sk-moved" },
    typed: { type: "api_key", key: "sk-typed" },
    untouched: { type: "api_key", key: "sk-untouched" },
  }), { mode: 0o600 });

  const response = await POST(post({ renames: [
    { from: "old-gateway", to: "new-gateway" },
    { from: "old-typed", to: "typed" },
    { from: "absent", to: "elsewhere" },
  ] }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.moved, [{ from: "old-gateway", to: "new-gateway" }]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(await credentials(), {
    "new-gateway": { type: "api_key", key: "sk-moved" },
    typed: { type: "api_key", key: "sk-typed" },
    untouched: { type: "api_key", key: "sk-untouched" },
  });
});

test("malformed requests are refused and a bad entry does not stop the rest", async () => {
  assert.equal((await POST(post({ renames: "gateway" }))).status, 400);
  assert.equal((await POST(post({ renames: Array.from({ length: 101 }, () => ({ from: "a", to: "b" })) }))).status, 400);

  const response = await POST(post({ renames: [{ from: "new-gateway" }, { from: "new-gateway", to: "third" }] }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.moved, [{ from: "new-gateway", to: "third" }]);
  assert.equal(result.failed.length, 1);
  assert.equal((await credentials()).third.key, "sk-moved");
});
