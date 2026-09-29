import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FavoritesStore } from "../src/store.ts";

const model = { provider: "example", id: "org/model" };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-model-plus-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new FavoritesStore(join(dir, "favorites.json"));
}

test("missing store is empty; bookmarks persist and toggle off", async (t) => {
  const store = await fixture(t);
  assert.deepEqual(await store.read(), []);
  assert.equal(await store.update(model, "toggle"), true);
  assert.deepEqual(await new FavoritesStore(store.path).read(), [model]);
  assert.equal(await store.update(model, "toggle"), false);
  assert.deepEqual(await store.read(), []);
});

test("exact provider and model identities remain distinct", async (t) => {
  const store = await fixture(t);
  const second = { ...model, provider: "another" };
  await store.update(model, "toggle");
  await store.update(second, "toggle");
  await store.update(model, "remove");
  await store.update(model, "remove");
  assert.deepEqual(await store.read(), [second]);
});

test("creates parent directories", async (t) => {
  const base = await fixture(t);
  const store = new FavoritesStore(join(base.path, "nested", "favorites.json"));
  await store.update(model, "toggle");
  assert.deepEqual(await store.read(), [model]);
});

test("rejects malformed data without overwriting it or leaving locks", async (t) => {
  const store = await fixture(t);
  for (const text of ["{", "null", "{}", '[{"provider":"example"}]', '[{"provider":"","id":"x"}]']) {
    await writeFile(store.path, text);
    await assert.rejects(store.read());
    await assert.rejects(store.update(model, "toggle"));
    assert.equal(await readFile(store.path, "utf8"), text);
  }
  assert.deepEqual(await readdir(join(store.path, "..")), ["favorites.json"]);
});

test("deduplicates stored bookmarks and ignores extra properties", async (t) => {
  const store = await fixture(t);
  await writeFile(store.path, JSON.stringify([{ ...model, secret: "not persisted" }, model]));
  assert.deepEqual(await store.read(), [model]);
});

test("concurrent store instances do not lose bookmarks", async (t) => {
  const store = await fixture(t);
  const models = Array.from({ length: 12 }, (_, i) => ({ provider: "example", id: `model-${i}` }));
  await Promise.all(models.map((item) => new FavoritesStore(store.path).update(item, "toggle")));
  assert.deepEqual((await store.read()).map((item) => item.id).sort(), models.map((item) => item.id).sort());
  assert.deepEqual(await readdir(join(store.path, "..")), ["favorites.json"]);
});
