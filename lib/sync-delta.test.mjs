import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const p = await jiti.import("./sync-protocol.ts");
const config = await jiti.import("./sync-config.ts");
function dirs(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-sync-delta-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  return ["a", "b"].map((name) => { const dir = join(root, name); mkdirSync(dir); mkdirSync(join(dir, "prompts")); return dir; });
}
async function round(a, b) {
  const offer = await p.createSyncSnapshot(b);
  const local = await p.createSyncSnapshot(a);
  const outgoing = p.createSyncDelta(local, p.syncManifest(offer));
  const merged = await p.reconcileSyncDelta(outgoing, b);
  const incoming = p.createSyncDelta(merged, p.syncManifest(local));
  await p.reconcileSyncDelta(incoming, a);
  return { outgoing, incoming };
}
test("incremental exchange sends only differing bodies, tombstones contain no bytes", async (t) => {
  const [a, b] = dirs(t);
  for (const dir of [a, b]) writeFileSync(join(dir, "prompts", "same.md"), "same bytes");
  writeFileSync(join(a, "auth.json"), '{"key":"secret"}');
  writeFileSync(join(b, "settings.json"), '{}');
  const first = await round(a, b);
  assert.deepEqual(Object.keys(first.outgoing.contents), ["auth.json"]);
  assert.deepEqual(Object.keys(first.incoming.contents), ["settings.json"]);
  const again = await round(a, b);
  assert.deepEqual(again.outgoing.contents, {}); assert.deepEqual(again.incoming.contents, {});
  writeFileSync(join(a, "prompts", "same.md"), "new content");
  assert.deepEqual(Object.keys((await round(a, b)).outgoing.contents), ["prompts/same.md"]);
  rmSync(join(a, "auth.json"));
  const deleted = await round(a, b);
  assert.equal(deleted.outgoing.files["auth.json"].deleted, true);
  assert.equal(Object.hasOwn(deleted.outgoing.contents, "auth.json"), false);
  assert.equal(existsSync(join(b, "auth.json")), false);
});
test("omitted winning body after concurrent change refuses batch without advancing watermark", async (t) => {
  const [a, b] = dirs(t);
  const aid = (await config.readSyncConfig(a)).node.id;
  await config.setSyncOptions({ conflictStrategy: "authority", authorityNodeId: aid }, a);
  writeFileSync(join(a, "auth.json"), '{"key":"authority"}'); await round(a, b);
  const offer = await p.createSyncSnapshot(b), source = await p.createSyncSnapshot(a);
  const delta = p.createSyncDelta(source, p.syncManifest(offer)); assert.deepEqual(delta.contents, {});
  const before = await config.readSyncConfig(b);
  writeFileSync(join(b, "auth.json"), '{"key":"concurrent"}');
  await assert.rejects(p.reconcileSyncDelta(delta, b), p.SyncBasisChanged);
  assert.equal(readFileSync(join(b, "auth.json"), "utf8"), '{"key":"concurrent"}');
  assert.deepEqual((await config.readSyncConfig(b)).receivedSnapshots, before.receivedSnapshots);
  const retry = await round(a, b);
  assert.deepEqual(Object.keys(retry.outgoing.contents), ["auth.json"]);
  assert.equal(readFileSync(join(b, "auth.json"), "utf8"), '{"key":"authority"}');
});
test("incremental frames validate present bodies, identity and manifests just like snapshots", async (t) => {
  const [a, b] = dirs(t);
  writeFileSync(join(a, "settings.json"), '{}');
  const s = await p.createSyncSnapshot(a);
  const manifest = p.syncManifest(s);
  assert.equal(Object.hasOwn(manifest, "contents"), false);
  assert.throws(() => p.parseSyncManifest({ ...manifest, contents: {} }, b));
  assert.throws(() => p.parseSyncManifest(manifest, b, "different-peer"));
  assert.throws(() => p.parseSyncManifest({ ...manifest, files: { "../auth.json": s.files["settings.json"] } }, b));
  await assert.rejects(p.reconcileSyncDelta({ ...s, contents: { "settings.json": Buffer.from('{"tampered":true}').toString("base64") } }, b), /integrity/);
  await assert.rejects(p.reconcileSyncDelta({ ...s, contents: {} }, b), p.SyncBasisChanged);
  assert.equal(existsSync(join(b, "settings.json")), false);
});
test("incremental conflict omits losing bodies and metadata-only identical content", async (t) => {
  const [a, b] = dirs(t);
  writeFileSync(join(a, "settings.json"), '{"v":1}'); await round(a, b);
  writeFileSync(join(b, "settings.json"), '{"v":2}');
  const remote = await p.createSyncSnapshot(b), local = await p.createSyncSnapshot(a);
  assert.deepEqual(p.createSyncDelta(local, p.syncManifest(remote)).contents, {});
  assert.deepEqual(Object.keys(p.createSyncDelta(remote, p.syncManifest(local)).contents), ["settings.json"]);
  const aid = local.node.id;
  await config.setSyncOptions({ conflictStrategy: "authority", authorityNodeId: aid }, a);
  const authority = await p.createSyncSnapshot(a);
  // New authority policy first: do not transfer B's losing, newer body.
  assert.deepEqual(p.createSyncDelta(remote, p.syncManifest(authority)).contents, {});
  await round(a, b);
  assert.equal(readFileSync(join(b, "settings.json"), "utf8"), '{"v":1}');
});

test("omitted same-hash body cannot smuggle inconsistent size into the ledger", async (t) => {
  const [a, b] = dirs(t);
  writeFileSync(join(a, "auth.json"), '{}'); await round(a, b);
  const snapshot = await p.createSyncSnapshot(a);
  const version = snapshot.files["auth.json"];
  const forged = { ...snapshot, contents: {}, files: { "auth.json": { ...version, size: version.size + 1,
    updatedAt: new Date(Date.parse(version.updatedAt) + 1000).toISOString() } } };
  await assert.rejects(p.reconcileSyncDelta(forged, b), /integrity/);
  assert.equal((await config.readSyncConfig(b)).files["auth.json"].size, 2);
});

test("scope fingerprint excludes transport revisions but includes policy and deletions", async (t) => {
  const [a] = dirs(t);
  writeFileSync(join(a, "settings.json"), '{}');
  const one = await p.createSyncSnapshot(a), two = await p.createSyncSnapshot(a);
  assert.notEqual(one.snapshotRevision, two.snapshotRevision);
  assert.equal(p.syncSnapshotFingerprint(one), p.syncSnapshotFingerprint(two));
  rmSync(join(a, "settings.json"));
  assert.notEqual(p.syncSnapshotFingerprint(one), p.syncSnapshotFingerprint(await p.createSyncSnapshot(a)));
});
