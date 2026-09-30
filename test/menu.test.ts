import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { FavoritesMenu, type ModelSelection } from "../src/menu.ts";
import { type Favorite, FavoritesStore } from "../src/store.ts";

const models = [
  { provider: "example", id: "alpha", name: "Alpha Reasoner" },
  { provider: "another", id: "beta", name: "Beta Coder" },
];
async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  favorites: Favorite[] = [],
  availableModels = models,
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-model-plus-menu-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FavoritesStore(join(dir, "favorites.json"));
  for (const favorite of favorites) await store.update(favorite, "toggle");
  const keybindings = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.models.save": { defaultKeys: "ctrl+s" } });
  const identity = (text: string) => text;
  const result: (ModelSelection | undefined)[] = [];
  const menu = new FavoritesMenu({
    models: availableModels, favorites, store, current: availableModels[0], defaultModel: availableModels[0], keybindings,
    theme: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
    render: () => {}, done: (favorite) => result.push(favorite),
  });
  return { menu, store, keybindings, result };
}

test("empty menu supports adding multiple bookmarks, returning and switching", async (t) => {
  const f = await fixture(t);
  f.menu.focused = true;
  assert.match(f.menu.render(100).join("\n"), /No favorites yet/);
  await f.menu.handleInput("\u0001");
  assert.match(f.menu.render(100).join("\n"), /Model Plus/);
  assert.match(f.menu.render(100).join("\n"), /ctrl\+n add/);
  await f.menu.handleInput("\u000e");
  assert.match(f.menu.render(100).join("\n"), /Add favorite models/);
  await f.menu.handleInput("\r");
  await f.menu.handleInput("\u001b[B");
  await f.menu.handleInput("\r");
  await f.menu.handleInput("\u001b");
  assert.match(f.menu.render(100).join("\n"), /Model Plus/);
  assert.equal((await f.store.read()).length, 2);
  assert.deepEqual(f.result, []);
  await f.menu.handleInput("\r");
  assert.deepEqual(f.result, [{ provider: "example", id: "alpha" }]);
});

test("removing a filtered favorite keeps the menu open, including the last bookmark", async (t) => {
  const f = await fixture(t, models);
  await f.menu.handleInput("beta");
  await f.menu.handleInput("\u0012");
  assert.deepEqual(await f.store.read(), [{ provider: "example", id: "alpha" }]);
  await f.menu.handleInput("\u0015");
  await f.menu.handleInput("\u0012");
  assert.deepEqual(await f.store.read(), []);
  assert.match(f.menu.render(100).join("\n"), /No favorites yet/);
  assert.deepEqual(f.result, []);
  await f.menu.handleInput("\u0012");
  await f.menu.handleInput("\r");
  assert.deepEqual(f.result, []);
  await f.menu.handleInput("\u001b");
  assert.deepEqual(f.result, [undefined]);
});

test("unavailable models can be removed but not selected", async (t) => {
  const f = await fixture(t, [{ provider: "gone", id: "missing" }]);
  await f.menu.handleInput("\r");
  await f.menu.handleInput("\u0013");
  assert.match(f.menu.render(100).join("\n"), /unavailable/);
  assert.deepEqual(f.result, []);
  await f.menu.handleInput("\u0012");
  assert.deepEqual(await f.store.read(), []);
});

test("shortcuts are configurable and menu respects narrow widths", async (t) => {
  const f = await fixture(t, [models[0]]);
  f.keybindings.setUserBindings({ "pi-model-plus.add": "ctrl+o", "pi-model-plus.remove": "ctrl+x" });
  await f.menu.handleInput("\u0012");
  assert.equal((await f.store.read()).length, 1);
  await f.menu.handleInput("\u0018");
  assert.equal((await f.store.read()).length, 0);
  assert.match(f.menu.render(100).join("\n"), /ctrl\+o add/);
  for (const width of [20, 40, 80]) {
    for (const line of f.menu.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  await f.menu.handleInput("\u000e");
  assert.match(f.menu.render(100).join("\n"), /Model Plus/);
  await f.menu.handleInput("\u000f");
  assert.match(f.menu.render(100).join("\n"), /Add favorite models/);
});

test("unmatched search fits narrow terminals and cannot switch models", async (t) => {
  const f = await fixture(t, models);
  await f.menu.handleInput("zzzzzzzz");
  for (const width of [20, 21, 22, 40]) {
    for (const line of f.menu.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  await f.menu.handleInput("\r");
  assert.deepEqual(f.result, []);
});

for (const browser of [false, true]) {
  test(`${browser ? "model browser" : "favorites menu"} pages through filtered results and clamps at either end`, async (t) => {
    const catalog = Array.from({ length: 25 }, (_, i) => ({
      provider: "example", id: `model-${i}`, name: i % 2 === 0 ? "Target" : "Other",
    }));
    const f = await fixture(t, catalog, catalog);
    const pageDown = browser ? "\u0006" : "\u001b[6~";
    const pageUp = browser ? "\u0002" : "\u001b[5~";
    if (browser) {
      f.keybindings.setUserBindings({ "tui.select.pageDown": "ctrl+f", "tui.select.pageUp": "ctrl+b" });
      await f.menu.handleInput("\u000e");
    }
    const assertSelected = (index: number) => {
      const line = f.menu.render(120).find((line) => line.startsWith("→ "));
      assert.match(line ?? "", new RegExp(`example/model-${index}(?: |$)`));
    };
    for (const [key, index] of [
      [pageDown, 10], [pageDown, 20], [pageDown, 24], [pageDown, 24],
      [pageUp, 14], [pageUp, 4], [pageUp, 0], [pageUp, 0],
    ] as const) {
      await f.menu.handleInput(key);
      assertSelected(index);
    }
    await f.menu.handleInput("zzzzzzzz");
    await f.menu.handleInput(pageDown);
    await f.menu.handleInput(pageUp);
    await f.menu.handleInput("\r");
    assert.deepEqual(f.result, []);
    assert.equal((await f.store.read()).length, 25);
    await f.menu.handleInput("\u0015");
    await f.menu.handleInput("Target");
    await f.menu.handleInput(pageDown);
    assertSelected(20);
    await f.menu.handleInput(pageDown);
    assertSelected(24);
    await f.menu.handleInput(pageUp);
    assertSelected(4);
    await f.menu.handleInput("\r");
    if (browser) {
      assert.equal((await f.store.read()).some((model) => model.id === "model-4"), false);
      assert.equal((await f.store.read()).length, 24);
    } else {
      assert.deepEqual(f.result, [catalog[4]]);
    }
  });
}

test("Ctrl+S selects the filtered favorite as default without changing bookmarks", async (t) => {
  const f = await fixture(t, models);
  assert.match(f.menu.render(120).join("\n"), /example\/alpha \(current\) \(default\)/);
  assert.match(f.menu.render(120).join("\n"), /ctrl\+s set default/);
  await f.menu.handleInput("beta");
  await f.menu.handleInput("\u0013");
  assert.deepEqual(f.result, [{ ...models[1], saveAsDefault: true }]);
  assert.equal((await f.store.read()).length, 2);
});

test("save default follows Pi keybinding overrides and can be disabled", async (t) => {
  const f = await fixture(t, models);
  f.keybindings.setUserBindings({ "app.models.save": "ctrl+d" });
  assert.match(f.menu.render(120).join("\n"), /ctrl\+d set default/);
  await f.menu.handleInput("\u0013");
  assert.deepEqual(f.result, []);
  await f.menu.handleInput("\u0004");
  assert.deepEqual(f.result, [{ ...models[0], saveAsDefault: true }]);
  f.keybindings.setUserBindings({ "app.models.save": [] });
  await f.menu.handleInput("\u0013");
  await f.menu.handleInput("\u0004");
  assert.equal(f.result.length, 1);
});

test("default badge is searchable and empty results cannot set a default", async (t) => {
  const f = await fixture(t, models);
  await f.menu.handleInput("default");
  await f.menu.handleInput("\u0013");
  assert.deepEqual(f.result, [{ ...models[0], saveAsDefault: true }]);
  await f.menu.handleInput("zzzzzzzz");
  await f.menu.handleInput("\u0013");
  assert.equal(f.result.length, 1);
  const empty = await fixture(t);
  await empty.menu.handleInput("\u0013");
  assert.deepEqual(empty.result, []);
});

test("failed removal keeps bookmark visible and reports the error", async (t) => {
  const f = await fixture(t, [models[0]]);
  await writeFile(f.store.path, "{}");
  await f.menu.handleInput("\u0012");
  assert.match(f.menu.render(100).join("\n"), /Could not remove bookmark/);
  assert.match(f.menu.render(100).join("\n"), /★ example\/alpha/);
  assert.deepEqual(f.result, []);
});
