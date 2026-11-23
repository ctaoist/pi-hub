import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { discoverPluginConfigs, discoverStandaloneConfig, readPluginConfig, listPluginConfigs, savePluginConfig } = await jiti.import("./plugin-config.ts");
const { readPluginConfigRequest } = await jiti.import("./plugin-config-request.ts");
const { parsePluginConfigValue } = await jiti.import("./plugin-config-types.ts");

function fixture(t, current, example) {
  const root = mkdtempSync(join(tmpdir(), "pi-plugin-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, "plugin"); const home = join(root, "home"); const cwd = join(root, "project");
  for (const path of [pkg, home, cwd]) mkdirSync(path);
  const config = join(pkg, "config.json");
  const sample = join(pkg, "config.example.json");
  if (current !== undefined) writeFileSync(config, JSON.stringify(current));
  if (example !== undefined) writeFileSync(sample, JSON.stringify(example));
  const input = { source: "npm:test", installedPath: pkg, home, cwd, projectTrusted: true, env: { HOME: home } };
  const targets = () => discoverPluginConfigs(input);
  return { root, pkg, home, cwd, config, sample, input, targets, target: () => targets()[0], bytes: () => readFileSync(config, "utf8"), json: () => JSON.parse(readFileSync(config, "utf8")) };
}
const set = (path, value) => ({ path, action: "set", value });
const code = (expected) => (error) => error.code === expected;

test("discovery: four combinations, root only, no side effects", (t) => {
  for (const [current, example, count] of [[undefined, undefined, 0], [{ enabled: true }, undefined, 1], [undefined, { enabled: false }, 1], [{ enabled: true }, { retries: 3 }, 1]]) {
    const f = fixture(t, current, example);
    mkdirSync(join(f.pkg, "nested")); writeFileSync(join(f.pkg, "nested", "config.example.json"), "{}");
    assert.equal(f.targets().length, count);
    const result = listPluginConfigs(f.targets());
    if (count) { assert.equal(result.files[0].exists, current !== undefined); assert.equal(result.files[0].error, undefined); }
    assert.equal(existsSync(f.config), current !== undefined);
  }
});

test("standalone config requires a real index entry and refuses shared directories and config links", (t) => {
  const f = fixture(t, { enabled: true });
  const entry = join(f.pkg, "index.ts"); writeFileSync(entry, "throw new Error('not executed');");
  const targets = discoverStandaloneConfig(entry, [f.home]);
  assert.equal(targets.length, 1);
  assert.equal(readPluginConfig(targets[0]).fields[0].value, true);
  assert.deepEqual(discoverStandaloneConfig(entry, [f.pkg]), []);
  writeFileSync(join(f.pkg, "sibling.ts"), "");
  assert.deepEqual(discoverStandaloneConfig(join(f.pkg, "sibling.ts"), []), []);
  rmSync(f.config); symlinkSync(f.sample, f.config);
  assert.equal(listPluginConfigs(discoverStandaloneConfig(entry, [])).files[0].error, "unsafe");
  rmSync(entry); symlinkSync(join(f.pkg, "sibling.ts"), entry);
  assert.deepEqual(discoverStandaloneConfig(entry, []), []);
});

test("existing values win, missing sample fields are opt-in; extra fields survive", async (t) => {
  const f = fixture(t, { enabled: true, nested: { value: 2 }, extra: "keep", apiKey: "DO-NOT-SEND" }, { enabled: false, nested: { value: 10, mode: "fast" }, apiKey: "EXAMPLE-SECRET" });
  const doc = readPluginConfig(f.target());
  assert.equal(doc.fields.find((x) => x.path[0] === "enabled").value, true);
  assert.equal(doc.fields.find((x) => x.path.at(-1) === "mode").present, false);
  assert.equal(JSON.stringify(doc).includes("DO-NOT-SEND"), false);
  assert.equal(JSON.stringify(doc).includes("EXAMPLE-SECRET"), false);
  const exampleBefore = readFileSync(f.sample, "utf8");
  await savePluginConfig(f.target(), doc.revision, [set(["nested", "value"], 4)], false);
  assert.deepEqual(f.json(), { enabled: true, nested: { value: 4 }, extra: "keep", apiKey: "DO-NOT-SEND" });
  assert.equal(readFileSync(f.sample, "utf8"), exampleBefore);
  if (process.platform !== "win32") assert.equal(statSync(f.config).mode & 0o777, 0o600);
});

test("example-only requires confirmation, creates only explicitly selected fields", async (t) => {
  const f = fixture(t, undefined, { enabled: false, apiKey: "not-a-real-key", nested: { count: 2 }, list: [1, null] });
  const doc = readPluginConfig(f.target());
  await assert.rejects(savePluginConfig(f.target(), doc.revision, [set(["enabled"], true)], false), code("confirm"));
  assert.equal(existsSync(f.config), false);
  await savePluginConfig(f.target(), doc.revision, [set(["nested", "count"], 5), set(["list"], [2, null])], true);
  assert.deepEqual(f.json(), { nested: { count: 5 }, list: [2, null] });
  assert.equal(existsSync(`${f.config}.lock`), false);
});

test("secret replacement/removal is explicit, nested secrets and credential URLs are hidden", async (t) => {
  const f = fixture(t, { password: "hidden", headers: { Authorization: "Bearer hidden" }, servers: [{ url: "https://user:secret@example.com" }], endpoint: "https://foo.test/?api_key=hidden", normal: "visible" });
  const doc = readPluginConfig(f.target());
  assert.equal(doc.fields.filter((x) => x.secret).length, 4);
  assert.equal(JSON.stringify(doc).includes("hidden"), false);
  assert.equal(JSON.stringify(doc).includes("user:secret"), false);
  await savePluginConfig(f.target(), doc.revision, [set(["password"], "replacement"), { path: ["headers"], action: "remove" }], false);
  assert.equal(f.json().password, "replacement"); assert.equal(Object.hasOwn(f.json(), "headers"), false);
  const after = readPluginConfig(f.target()); assert.equal(JSON.stringify(after).includes("replacement"), false);
});

test("numeric token budgets remain editable while token credentials stay hidden", (t) => {
  const f = fixture(t, { distill_max_tokens: 1000, maxTokens: 2000, token: 12345, accessToken: "credential", secret_max_tokens: 5, max_tokens: "credential", nested: { input_tokens: 20 } });
  const fields = readPluginConfig(f.target()).fields;
  for (const name of ["distill_max_tokens", "maxTokens"]) assert.equal(fields.find((x) => x.path[0] === name).secret, false);
  for (const name of ["token", "accessToken", "secret_max_tokens", "max_tokens"]) assert.equal(fields.find((x) => x.path[0] === name).secret, true);
  assert.equal(fields.find((x) => x.path.join(".") === "nested.input_tokens").value, 20);
});

test("no example: unknown fields, duplicates, prototype pollution and wrong scalar types rejected", async (t) => {
  const f = fixture(t, { n: 2, options: {} });
  const doc = readPluginConfig(f.target()); const before = f.bytes();
  for (const changes of [[set(["new"], true)], [set(["n"], "3")], [set(["n"], Infinity)], [set(["n"], 1), set(["n"], 2)], [set(["__proto__", "bad"], true)], [set(["options"], JSON.parse('{"__proto__":{"bad":true}}'))]]) {
    await assert.rejects(savePluginConfig(f.target(), doc.revision, changes, false), code("invalid"));
    assert.equal(f.bytes(), before);
  }
  assert.equal({}.bad, undefined);
});

test("arrays, null, booleans, empty objects and typed parser preserve JSON", async (t) => {
  const f = fixture(t, { list: [1, "a"], nullable: null, empty: {}, enabled: true });
  const doc = readPluginConfig(f.target());
  await savePluginConfig(f.target(), doc.revision, [set(["list"], [null, { ok: true }]), set(["nullable"], null), set(["empty"], { x: 1 }), set(["enabled"], false)], false);
  assert.deepEqual(f.json(), { list: [null, { ok: true }], nullable: null, empty: { x: 1 }, enabled: false });
  assert.equal(parsePluginConfigValue("string", "123"), "123");
  assert.equal(parsePluginConfigValue("number", "1.5"), 1.5);
  for (const value of ["", "null", '"1"', "1e999"]) assert.throws(() => parsePluginConfigValue("number", value));
});

test("stale config, stale example, deletion and concurrent saves cannot silently overwrite", async (t) => {
  const f = fixture(t, { n: 1 }, { n: 0 });
  let doc = readPluginConfig(f.target());
  writeFileSync(f.config, '{"n": 2}');
  await assert.rejects(savePluginConfig(f.target(), doc.revision, [set(["n"], 3)], false), code("conflict"));
  doc = readPluginConfig(f.target()); writeFileSync(f.sample, '{"n":4}');
  await assert.rejects(savePluginConfig(f.target(), doc.revision, [set(["n"], 3)], false), code("conflict"));
  doc = readPluginConfig(f.target());
  const results = await Promise.allSettled([3, 4].map((n) => savePluginConfig(f.target(), doc.revision, [set(["n"], n)], false)));
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  doc = readPluginConfig(f.target()); rmSync(f.config);
  await assert.rejects(savePluginConfig(f.target(), doc.revision, [set(["n"], 5)], true), code("conflict"));
  assert.equal(existsSync(f.config), false);
});

test("corruption and size/depth/field limits fail closed without parser content", (t) => {
  const f = fixture(t, { n: 1 }, { n: 0 });
  for (const [text, expected] of [['{"password":"SECRET', "invalid"], ["[]", "invalid"], [" ".repeat(128 * 1024 + 1), "large"], [JSON.stringify(Object.fromEntries(Array.from({ length: 301 }, (_, n) => [String(n), true]))), "large"]]) {
    writeFileSync(f.config, text);
    const result = listPluginConfigs(f.targets());
    assert.equal(result.files[0].error, expected);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.equal(f.bytes(), text);
  }
  let deep = 1; for (let n = 0; n < 18; n++) deep = { nested: deep };
  writeFileSync(f.config, JSON.stringify(deep)); assert.equal(listPluginConfigs(f.targets()).files[0].error, "large");
  writeFileSync(f.config, '{"n":1}'); writeFileSync(f.sample, "broken");
  assert.equal(listPluginConfigs(f.targets()).files[0].error, "invalid");
});

test("symbolic links, hard links, directories and linked project parents are refused", (t) => {
  const f = fixture(t, { n: 1 }); const outside = join(f.root, "outside.json"); writeFileSync(outside, '{"secret":"outside"}');
  rmSync(f.config); symlinkSync(outside, f.config);
  assert.equal(listPluginConfigs(f.targets()).files[0].error, "unsafe");
  rmSync(f.config); linkSync(outside, f.config);
  assert.equal(listPluginConfigs(f.targets()).files[0].error, "unsafe");
  rmSync(f.config); mkdirSync(f.config);
  assert.equal(listPluginConfigs(f.targets()).files[0].error, "unsafe");
  const outsideDir = join(f.root, "external"); mkdirSync(outsideDir); writeFileSync(join(outsideDir, "lsp.json"), "{}");
  symlinkSync(outsideDir, join(f.cwd, ".pi"), "dir");
  f.input.source = "npm:pi-lsp";
  const project = f.targets().find((x) => x.id === "lsp-project");
  assert.equal(listPluginConfigs([project]).files[0].error, "unsafe");
});

test("external adapters use source identity, actual precedence and existing files only", (t) => {
  const f = fixture(t);
  const dir = join(f.home, ".pi", "agent"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "web-search.json"), '{"count":1}');
  writeFileSync(join(f.home, ".pi", "web-search.json"), '{"count":2}');
  writeFileSync(join(dir, "lsp.json"), '{"servers":[]}');
  writeFileSync(join(f.pkg, "package.json"), '{"name":"pi-lsp"}');
  assert.equal(f.targets().length, 0);
  f.input.source = "npm:pi-web-access@1.2.3";
  assert.equal(readPluginConfig(f.target()).path, join(dir, "web-search.json"));
  f.input.env.PI_CODING_AGENT_DIR = join(f.root, "missing"); assert.equal(f.targets().length, 0);
  f.input.source = "npm:pi-lsp";
  assert.equal(f.target().id, "lsp-global");
  mkdirSync(join(f.cwd, ".pi")); writeFileSync(join(f.cwd, ".pi", "lsp.json"), "{}");
  assert.equal(f.targets().length, 2);
  f.input.projectTrusted = false; assert.equal(f.targets().length, 1);
  f.input.source = "npm:@juicesharp/rpiv-ask-user-question@1.2.3";
  const rpiv = join(f.home, ".config", "rpiv-ask-user-question"); mkdirSync(rpiv, { recursive: true }); writeFileSync(join(rpiv, "config.json"), '{"notesKey":"n"}');
  assert.equal(f.target().id, "ask-user-question");
});

test("empty existing objects still expose missing example children without auto-merging", async (t) => {
  const f = fixture(t, { nested: {} }, { nested: { enabled: true } });
  const doc = readPluginConfig(f.target());
  assert.deepEqual(doc.fields.map((field) => [field.path, field.present]), [[["nested", "enabled"], false]]);
  await savePluginConfig(f.target(), doc.revision, [set(["nested", "enabled"], false)], false);
  assert.deepEqual(f.json(), { nested: { enabled: false } });
});

test("new containers cannot create an unreadable result and commit reauthorization can veto writes", async (t) => {
  const f = fixture(t, { options: {} }); const doc = readPluginConfig(f.target()); const before = f.bytes();
  const tooMany = Object.fromEntries(Array.from({ length: 301 }, (_, n) => [String(n), n]));
  await assert.rejects(savePluginConfig(f.target(), doc.revision, [set(["options"], tooMany)], false), code("large"));
  await assert.rejects(savePluginConfig(f.target(), doc.revision, [set(["options"], { n: 2 })], false, async () => { throw new Error("access revoked"); }), /access revoked/);
  assert.equal(f.bytes(), before);
});

test("request body is bounded before parsing, including chunked requests", async () => {
  let pulls = 0;
  const request = new Request("http://localhost/api/plugins/config", { method: "POST", duplex: "half", body: new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(100000)); } }) });
  await assert.rejects(readPluginConfigRequest(request), code("large"));
  assert.ok(pulls <= 4);
  await assert.rejects(readPluginConfigRequest(new Request("http://localhost", { method: "POST", body: '{"password":"SECRET' })), (error) => error.code === "invalid" && !error.message.includes("SECRET"));
});
