import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { given, taken } from "../src/index.ts";
import { renderCall, renderResult, type CallArgs } from "../src/render.ts";

initTheme();
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const call = (args: CallArgs, expanded = false) => renderCall(taken(args.action!, given(args)), theme, expanded).render(200).map(line => line.trimEnd());
const result = (text: string, expanded = false, action?: string, isError = false) =>
  renderResult({ content: [{ type: "text", text }], details: undefined }, expanded, theme, action, isError).render(200).map(line => line.trimEnd());

test("call line names the action and its target, dropping params the action ignores", () => {
  assert.deepEqual(call({ action: "navigate", url: "https://github.com/foo", ref: 0, point: [] }), ["Browser navigate github.com/foo"]);
  assert.deepEqual(call({ action: "click", ref: 12, point: [1, 2], tabId: 3 }), ["Browser click [12]"]);
  assert.deepEqual(call({ action: "click", point: [412, 230], button: "right", clickCount: 2 }), ["Browser click (412, 230) right ×2"]);
  assert.deepEqual(call({ action: "type", ref: 4, text: "pi\x1b[31m extensions" }), ['Browser type [4] "pi extensions"']);
  assert.deepEqual(call({ action: "drag", point: [1, 2], to: [3, 4] }), ["Browser drag (1, 2) → (3, 4)"]);
  assert.deepEqual(call({ action: "read" }), ["Browser read"]);
});

test("eval shows its code as lines, the first five until expanded", () => {
  assert.deepEqual(call({ action: "eval", code: "const n = 1;\nn + 1" }), ["Browser eval", "  const n = 1;", "  n + 1"]);
  const code = Array.from({ length: 8 }, (_, i) => `line${i}`).join("\n");
  assert.equal(call({ action: "eval", code }).length, 7);
  assert.equal(call({ action: "eval", code }, true).length, 9);
  assert.equal(renderCall({ action: "eval", code: "x".repeat(500) }, theme).render(80).length, 2);
});

test("expanded call shows long arguments in full", () => {
  const text = "x".repeat(100);
  assert.match(call({ action: "type", ref: 1, text })[0], /x…"$/);
  assert.equal(call({ action: "type", ref: 1, text }, true)[0], `Browser type [1] "${text}"`);
});

test("collapsed result shows the first line and counts the rest; expanded shows all", () => {
  const tree = "Tab 3: Home <https://x.test/>\n- [1] link\n- [2] button";
  assert.equal(result(tree)[0], "Tab 3: Home <https://x.test/>");
  assert.match(result(tree)[1], /… 2 more lines/);
  assert.deepEqual(result(tree, true), tree.split("\n"));
  assert.deepEqual(result("Clicked [12] button \"Sign in\" in tab 3."), ['Clicked [12] button "Sign in" in tab 3.']);
  assert.equal(result("{\n  \"a\": 1\n}", false, "eval").length, 3);
  assert.deepEqual(result("boom\nmore", false, "click", true), ["boom", "more"]);
  const url = `Tab 3: Search <https://x.test/?q=${"a".repeat(300)}>`;
  assert.equal(renderResult({ content: [{ type: "text", text: url }], details: undefined }, false, theme).render(80).length, 1);
});
