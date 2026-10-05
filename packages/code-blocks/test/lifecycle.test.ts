import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import extension from "../src/index.ts";

test("only patches TUI sessions and restores across repeated starts and shutdowns", () => {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  extension({ on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  const prototype = Markdown.prototype as unknown as { renderToken: unknown };
  const original = prototype.renderToken;
  const warnings: string[] = [];
  const ctx = { mode: "rpc", ui: { theme: { fg: (_color: string, text: string) => text }, notify: (text: string) => warnings.push(text) } };
  const emit = (name: string) => handlers.get(name)?.({}, ctx as unknown as ExtensionContext);
  try {
    emit("session_start");
    assert.equal(prototype.renderToken, original);
    ctx.mode = "tui";
    emit("session_start");
    assert.notEqual(prototype.renderToken, original);
    emit("session_start");
    assert.notEqual(prototype.renderToken, original);
    assert.deepEqual(warnings, []);
    emit("session_shutdown");
    emit("session_shutdown");
    assert.equal(prototype.renderToken, original);
    prototype.renderToken = undefined;
    emit("session_start");
    assert.match(warnings[0], /unavailable/);
    assert.equal(prototype.renderToken, undefined);
  } finally {
    emit("session_shutdown");
    prototype.renderToken = original;
  }
});
