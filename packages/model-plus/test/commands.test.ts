import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCommand } from "../src/commands.ts";
import { DefaultModelStore } from "../src/default-model.ts";
import { FavoritesStore } from "../src/store.ts";

type Context = Parameters<ReturnType<typeof createCommand>["handler"]>[1];
type Model = ReturnType<Context["modelRegistry"]["getAvailable"]>[number];
const model: Model = {
  provider: "example", id: "org/model", name: "Example model", api: "openai-completions",
  baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
};

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-model-plus-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FavoritesStore(join(dir, "favorites.json"));
  const notifications: string[] = [];
  const switched: Model[] = [];
  let options: string[] = [];
  const ctx: Context = {
    hasUI: true, model, mode: "rpc",
    modelRegistry: { getAvailable: () => [model] },
    ui: {
      custom: async () => { throw new Error("Unexpected custom UI"); },
      notify: (message) => { notifications.push(message); },
      select: async (_title, items) => { options = items; return items[0]; },
    },
  };
  const defaults = new DefaultModelStore(dir);
  const command = createCommand(store, async (next) => { switched.push(next); return true; }, defaults);
  return { store, defaults, dir, ctx, command, notifications, switched, options: () => options };
}

test("RPC picker switches through Pi API and cancellation leaves model unchanged", async (t) => {
  const f = await fixture(t);
  await f.store.update(model, "toggle");
  await f.command.handler("", f.ctx);
  assert.deepEqual(f.options(), ["example/org/model (current)"]);
  assert.deepEqual(f.switched, [model]);
  f.ctx.ui.select = async () => undefined;
  await f.command.handler("", f.ctx);
  assert.equal(f.switched.length, 1);
});

test("unavailable favorites remain saved and cannot be selected", async (t) => {
  const f = await fixture(t);
  await f.store.update(model, "toggle");
  f.ctx.modelRegistry.getAvailable = () => [];
  await f.command.handler("", f.ctx);
  assert.deepEqual(f.options(), ["example/org/model (unavailable)"]);
  assert.deepEqual(f.switched, []);
  assert.equal((await f.store.read()).length, 1);
});

test("empty RPC list, removed subcommands and non-UI modes are safe", async (t) => {
  const f = await fixture(t);
  await f.command.handler("", f.ctx);
  assert.match(f.notifications.at(-1)!, /No favorites yet/);
  for (const args of ["manage", "remove", "unexpected"]) {
    await f.command.handler(args, f.ctx);
    assert.match(f.notifications.at(-1)!, /Usage: \/model-plus/);
  }
  f.ctx.hasUI = false;
  await f.command.handler("", f.ctx);
  assert.match(f.notifications.at(-1)!, /requires interactive/);
});

test("failed authentication and model switch errors are reported", async (t) => {
  const f = await fixture(t);
  await f.store.update(model, "toggle");
  await createCommand(f.store, async () => false).handler("", f.ctx);
  assert.match(f.notifications.at(-1)!, /Could not switch/);
  await createCommand(f.store, async () => { throw new Error("switch failed"); }).handler("", f.ctx);
  assert.match(f.notifications.at(-1)!, /switch failed/);
});

test("terminal menu opens even with no favorites or available models", async (t) => {
  const f = await fixture(t);
  let opened = false;
  f.ctx.mode = "tui";
  f.ctx.modelRegistry.getAvailable = () => [];
  f.ctx.ui.custom = async () => { opened = true; return undefined as never; };
  await f.command.handler("", f.ctx);
  assert.equal(opened, true);
  assert.deepEqual(f.switched, []);
});

test("terminal save switches and persists a default, while Enter and cancellation do not", async (t) => {
  const f = await fixture(t);
  f.ctx.mode = "tui";
  f.ctx.ui.custom = async () => model as never;
  await f.command.handler("", f.ctx);
  assert.equal(f.defaults.read(), undefined);
  f.ctx.ui.custom = async () => ({ ...model, saveAsDefault: true }) as never;
  await f.command.handler("", f.ctx);
  assert.deepEqual(f.defaults.read(), { provider: model.provider, id: model.id });
  assert.match(f.notifications.at(-1)!, /Default model: example\/org\/model/);
  assert.deepEqual(f.switched, [model, model]);
  f.ctx.ui.custom = async () => undefined as never;
  await f.command.handler("", f.ctx);
  assert.equal(f.switched.length, 2);
});

test("unavailable models and failed switches never persist defaults", async (t) => {
  const f = await fixture(t);
  f.ctx.mode = "tui";
  f.ctx.ui.custom = async () => ({ ...model, saveAsDefault: true }) as never;
  for (const setModel of [async () => false, async () => { throw new Error("switch failed"); }]) {
    await createCommand(f.store, setModel, f.defaults).handler("", f.ctx);
    assert.equal(f.defaults.read(), undefined);
  }
  f.ctx.modelRegistry.getAvailable = () => [];
  await f.command.handler("", f.ctx);
  assert.equal(f.defaults.read(), undefined);
  assert.deepEqual(f.switched, []);
});

test("save failures distinguish the successful switch from the failed persistence", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, "settings.json"), "invalid json");
  f.ctx.mode = "tui";
  f.ctx.ui.custom = async () => ({ ...model, saveAsDefault: true }) as never;
  await f.command.handler("", f.ctx);
  assert.deepEqual(f.switched, [model]);
  assert.match(f.notifications.at(-1)!, /Switched to .*but could not save default/);
});

test("corrupt favorites are reported without overwriting the file", async (t) => {
  const f = await fixture(t);
  await writeFile(f.store.path, "{}");
  await f.command.handler("", f.ctx);
  assert.match(f.notifications.at(-1)!, /Could not use favorites/);
});
