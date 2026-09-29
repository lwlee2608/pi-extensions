import assert from "node:assert/strict";
import { test } from "node:test";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { FavoritesManager } from "../src/manager.ts";
import { type Favorite, modelKey } from "../src/store.ts";

const models = [
  { provider: "example", id: "alpha", name: "Alpha Reasoner" },
  { provider: "another", id: "beta", name: "Beta Coder" },
];
function fixture(toggle?: (model: Favorite) => Promise<boolean>) {
  const favorites = new Set<string>();
  let closed = false;
  const identity = (text: string) => text;
  const manager = new FavoritesManager({
    models, favorites: [], keybindings: getKeybindings(),
    theme: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
    toggle: toggle ?? (async (model) => {
      const key = modelKey(model);
      if (favorites.delete(key)) return false;
      favorites.add(key);
      return true;
    }),
    render: () => {}, done: () => { closed = true; },
  });
  return { manager, favorites, closed: () => closed };
}

test("searches names and toggles multiple favorites without closing", async () => {
  const f = fixture();
  await f.manager.handleInput("coder");
  assert.match(f.manager.render(100).join("\n"), /another\/beta/);
  assert.doesNotMatch(f.manager.render(100).join("\n"), /example\/alpha/);
  await f.manager.handleInput("\r");
  assert.deepEqual([...f.favorites], ["another/beta"]);
  assert.match(f.manager.render(100).join("\n"), /★ another\/beta/);
  assert.equal(f.closed(), false);
  await f.manager.handleInput("\r");
  assert.equal(f.favorites.size, 0);
  await f.manager.handleInput("\u0015");
  await f.manager.handleInput("\r");
  await f.manager.handleInput("\u001b[B");
  await f.manager.handleInput("\r");
  assert.equal(f.favorites.size, 2);
  await f.manager.handleInput("\u001b");
  assert.equal(f.closed(), true);
});

test("failed writes do not mark models as saved; focus and narrow widths work", async () => {
  const f = fixture(async () => { throw new Error("disk full"); });
  f.manager.focused = true;
  assert.equal(f.manager.focused, true);
  await f.manager.handleInput("\r");
  assert.match(f.manager.render(100).join("\n"), /Could not save: disk full/);
  assert.match(f.manager.render(100).join("\n"), /☆ example\/alpha/);
  for (const width of [20, 40, 80]) {
    for (const line of f.manager.render(width)) assert.ok(visibleWidth(line) <= width);
  }
});

test("unmatched search fits narrow terminals and cannot toggle a model", async () => {
  const f = fixture();
  await f.manager.handleInput("zzzzzzzz");
  for (const width of [20, 21, 22, 40]) {
    for (const line of f.manager.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  await f.manager.handleInput("\r");
  assert.equal(f.favorites.size, 0);
});

test("waits for saving before allowing another toggle or closing", async () => {
  let resolve!: (value: boolean) => void;
  const f = fixture(() => new Promise<boolean>((done) => { resolve = done; }));
  const saving = f.manager.handleInput("\r");
  await f.manager.handleInput("\u001b");
  assert.equal(f.closed(), false);
  resolve(true);
  await saving;
  assert.match(f.manager.render(100).join("\n"), /★ example\/alpha/);
  await f.manager.handleInput("\u001b");
  assert.equal(f.closed(), true);
});
