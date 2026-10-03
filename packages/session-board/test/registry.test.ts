import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HIDE_MS, Registration, readRows, UNKNOWN_MS, type Metadata } from "../src/registry.ts";

const metadata: Metadata = { sessionId: "s1", name: "first", cwd: "/project", status: "idle", statusSince: 1000 };

test("independent writers atomically replace private records and remove only their own", async () => {
  const root = await mkdtemp(join(tmpdir(), "board-test-"));
  try {
    const a = new Registration(root, () => 1000);
    const b = new Registration(root, () => 1000);
    await Promise.all([a.publish(metadata), b.publish({ ...metadata, sessionId: "s2" })]);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    for (const file of await readdir(root)) assert.equal((await stat(join(root, file))).mode & 0o777, 0o600);
    const writes = Array.from({ length: 12 }, (_, i) => a.publish({ ...metadata, name: `name-${i}` }));
    for (let i = 0; i < 12; i++) assert.equal((await readRows(root, 1000)).length, 2);
    await Promise.all(writes);
    assert.equal((await readRows(root, 1000)).find(r => r.registrationId === a.id)?.name, "name-11");
    assert.equal((await readdir(root)).length, 2);
    await a.close(); await a.close();
    assert.deepEqual((await readRows(root, 1000)).map(r => r.registrationId), [b.id]);
    await b.close();
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shutdown racing queued writes cannot resurrect an old registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "board-race-"));
  try {
    const old = new Registration(root);
    const writes = Array.from({ length: 50 }, () => old.publish(metadata));
    const closing = old.close();
    const current = new Registration(root);
    await current.publish(metadata);
    await Promise.all([...writes, closing]);
    await old.publish(metadata);
    assert.deepEqual((await readRows(root)).map(row => row.registrationId), [current.id]);
    await current.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed, unsupported, oversized, symlink and disappearing records do not break peers", async () => {
  const root = await mkdtemp(join(tmpdir(), "board-invalid-"));
  try {
    const good = new Registration(root); await good.publish(metadata);
    let i = 0;
    for (const text of ["{", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, registrationId: { toString: null } }), "x".repeat(40000), "null"]) {
      await writeFile(join(root, `00000000-0000-0000-0000-${String(i++).padStart(12, "0")}.json`), text);
    }
    await symlink(join(root, `${good.id}.json`), join(root, "00000000-0000-0000-0000-000000000009.json"));
    assert.deepEqual((await readRows(root)).map(row => row.registrationId), [good.id]);
    await Promise.all([readRows(root), good.close()]);
    assert.deepEqual(await readRows(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("writer recovers from an I/O failure on its next update", async () => {
  const root = await mkdtemp(join(tmpdir(), "board-io-"));
  const path = join(root, "registry");
  try {
    await writeFile(path, "blocked");
    const writer = new Registration(path);
    await assert.rejects(writer.publish(metadata));
    await rm(path);
    await writer.publish(metadata);
    assert.equal((await readRows(path)).length, 1);
    await writer.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("heartbeat boundaries use the supplied clock and never delete expired records", async () => {
  const root = await mkdtemp(join(tmpdir(), "board-test-"));
  let now = 1000;
  try {
    const writer = new Registration(root, () => now);
    await writer.publish(metadata);
    assert.equal((await readRows(root, now + UNKNOWN_MS - 1))[0].status, "idle");
    assert.equal((await readRows(root, now + UNKNOWN_MS))[0].status, "unknown");
    assert.equal((await readRows(root, now + HIDE_MS - 1)).length, 1);
    assert.equal((await readRows(root, now + HIDE_MS)).length, 0);
    assert.equal((await readdir(root)).length, 1);
    now += HIDE_MS;
    await writer.publish(metadata);
    const [row] = await readRows(root, now);
    assert.equal(row.status, "idle");
    assert.equal(row.statusSince, 1000);
    await writer.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
