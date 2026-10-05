import assert from "node:assert/strict";
import test from "node:test";
import { Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import { installPatch } from "../src/patch.ts";

const identity = (text: string) => text;
const theme: MarkdownTheme = {
  heading: identity, link: identity, linkUrl: identity, code: identity,
  codeBlock: identity, codeBlockBorder: identity, quote: identity,
  quoteBorder: identity, hr: identity, listBullet: identity, bold: identity,
  italic: identity, strikethrough: identity, underline: identity,
};
const render = (source: string, overrides: Partial<MarkdownTheme> = {}, width = 80) =>
  new Markdown(source, 0, 0, { ...theme, ...overrides }).render(width).map(line => line.trimEnd());

test("removes only fences, preserves spacing and literal Markdown, and restores on disposal", () => {
  const source = "Before\n\n```text\n  A -> B\n\n**literal**\n```\n\nAfter";
  const before = render(source);
  const dispose = installPatch(text => `<accent>${text}</accent>`);
  try {
    assert.deepEqual(render(source), ["Before", "", "  <accent>  A -> B</accent>", "  <accent></accent>", "  <accent>**literal**</accent>", "", "After"]);
    assert.deepEqual(render("# Heading\n\nA `code` and **bold**."), ["Heading", "", "A code and bold."]);
    assert.throws(() => installPatch(identity), /already patched/);
  } finally { dispose(); dispose(); }
  assert.deepEqual(render(source), before);
});

test("preserves syntax highlighting, custom indentation, and literal fences inside code", () => {
  const dispose = installPatch(text => `<accent>${text}</accent>`);
  try {
    const overrides = { codeBlockIndent: "> ", highlightCode: (code: string) => code.split("\n").map(line => `<syntax>${line}</syntax>`) };
    assert.deepEqual(render("```ts\nconst a = 1;\n```", overrides), ["> <syntax>const a = 1;</syntax>"]);
    assert.deepEqual(render("````text\n```\n````"), ["  <accent>```</accent>"]);
    assert.deepEqual(render("~~~txt\nhello\n~~~"), ["  <accent>hello</accent>"]);
    assert.deepEqual(render("    hello"), ["  <accent>hello</accent>"]);
  } finally { dispose(); }
});

test("works with streamed partial blocks, nested blocks, narrow widths, and theme changes", () => {
  let color = "blue";
  const dispose = installPatch(text => `\u001b[34m${color}:${text}\u001b[39m`);
  try {
    for (const source of ["```text\nhello", "```text\nhello\n`", "> ```text\n> hello\n> ```", "- Item\n\n  ```text\n  hello\n  ```"]) {
      const result = render(source).join("\n");
      assert.doesNotMatch(result, /```/);
      assert.match(result, /blue:hello/);
    }
    const markdown = new Markdown("```text\n你好 😀 verylongwordhere\n```", 1, 0, theme);
    for (const width of [8, 20, 80]) {
      assert.ok(markdown.render(width).every(line => visibleWidth(line) <= width));
    }
    color = "cyan";
    markdown.invalidate();
    assert.match(markdown.render(80).join("\n"), /cyan:/);
  } finally { dispose(); }
});

test("rejects incompatible renderers without replacing them", () => {
  const prototype = Markdown.prototype as unknown as { renderToken: (...args: any[]) => string[] };
  const original = prototype.renderToken;
  prototype.renderToken = () => ["changed renderer"];
  try {
    const changed = prototype.renderToken;
    assert.throws(() => installPatch(identity), /incompatible/);
    assert.equal(prototype.renderToken, changed);
  } finally { prototype.renderToken = original; }
});

test("cleanup does not overwrite later patches and makes retained wrappers inert", () => {
  const prototype = Markdown.prototype as unknown as { renderToken: (...args: any[]) => string[] };
  const original = prototype.renderToken;
  const dispose = installPatch(identity);
  const patched = prototype.renderToken;
  const later = function (this: unknown, ...args: any[]) { return patched.apply(this, args); };
  prototype.renderToken = later;
  try {
    dispose();
    assert.equal(prototype.renderToken, later);
    assert.deepEqual(render("```text\nhello\n```"), ["```text", "  hello", "```"]);
  } finally { prototype.renderToken = original; }
});
