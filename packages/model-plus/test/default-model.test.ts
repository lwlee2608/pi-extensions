import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultModelStore } from "../src/default-model.ts";

const model = { provider: "example", id: "org/model" };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-model-plus-default-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "settings.json"), store: new DefaultModelStore(dir) };
}

test("default persists across instances in the configured agent directory", async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.read(), undefined);
  await f.store.save(model);
  assert.deepEqual(new DefaultModelStore(f.dir).read(), model);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), {
    defaultProvider: model.provider, defaultModel: model.id,
  });
});

test("saving preserves unrelated settings and sees external default changes", async (t) => {
  const f = await fixture(t);
  const settings = { theme: "dark", defaultThinkingLevel: "high", enabledModels: ["example/*"], extensions: ["./custom.ts"] };
  await writeFile(f.path, JSON.stringify(settings));
  await f.store.save(model);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), {
    ...settings, defaultProvider: model.provider, defaultModel: model.id,
  });
  await writeFile(f.path, JSON.stringify({ ...settings, defaultProvider: "another", defaultModel: "beta" }));
  assert.deepEqual(f.store.read(), { provider: "another", id: "beta" });
});

test("corrupt settings are reported without being overwritten", async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, "invalid json");
  await assert.rejects(f.store.save(model));
  assert.equal(await readFile(f.path, "utf8"), "invalid json");
});

test("write errors are reported rather than silently succeeding", async (t) => {
  const f = await fixture(t);
  await mkdir(f.path);
  await assert.rejects(f.store.save(model));
});
