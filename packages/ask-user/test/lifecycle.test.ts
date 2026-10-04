import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, type Component, type TUI } from "@earendil-works/pi-tui";
import { theme } from "./helpers.ts";
import extension from "../src/index.ts";
import { runQuestionnaire } from "../src/questionnaire.ts";
import { description, parameters } from "../src/schema.ts";
import { core } from "./fixtures/demo.ts";

function host() {
  let tool!: ToolDefinition;
  let active = ["read", "ask_user_question"];
  const handlers = new Map<string, Function>();
  extension({
    registerTool: (definition: ToolDefinition) => { tool = definition; },
    on: (name: string, handler: Function) => { handlers.set(name, handler); },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI);
  return { tool, handlers, active: () => active, setActive: (names: string[]) => { active = names; } };
}

function ui() {
  let component: Component;
  let closes = 0;
  const ctx = {
    mode: "tui",
    ui: {
      custom: (factory: Function, options: any) => new Promise(resolve => {
        component = factory({ terminal: { rows: 30 }, requestRender() {} } as unknown as TUI, theme, new KeybindingsManager(TUI_KEYBINDINGS), (value: unknown) => { closes++; resolve(value); });
        queueMicrotask(() => options.onHandle?.({}));
      }),
    },
  } as unknown as ExtensionToolContext;
  return { ctx, input: (data: string) => component.handleInput!(data), closes: () => closes };
}

test("actual registration is lean, sequential, model-only, excludes non-TUI without reactivating disabled tools", async () => {
  const h = host();
  assert.equal(h.tool.description, description);
  assert.equal(h.tool.parameters, parameters);
  assert.ok(h.tool.description.length + JSON.stringify(h.tool.parameters).length <= 1800);
  assert.equal(h.tool.promptSnippet, undefined);
  assert.equal(h.tool.promptGuidelines, undefined);
  assert.equal(h.tool.exposure, "model-only");
  assert.equal(h.tool.executionMode, "sequential");
  for (const mode of ["rpc", "json", "print"] as const) {
    const ctx = { mode, hasUI: mode === "rpc" } as ExtensionToolContext;
    for (const event of ["session_start", "before_agent_start"]) {
      h.setActive(["read", "ask_user_question"]);
      assert.equal(h.handlers.get(event)!({}, ctx), undefined);
      assert.deepEqual(h.active(), ["read"]);
    }
    await assert.rejects(h.tool.execute("id", core, undefined, undefined, ctx), /terminal mode/);
  }
  h.setActive(["read"]);
  h.handlers.get("session_start")!({}, { mode: "tui" });
  h.handlers.get("before_agent_start")!({}, { mode: "tui" });
  assert.deepEqual(h.active(), ["read"]);
});

test("tool returns cancellation only on explicit user cancellation and cleans up its signal", async () => {
  const h = host(), view = ui();
  const pending = h.tool.execute("id", core, undefined, undefined, view.ctx);
  await Promise.resolve();
  view.input("\x1b");
  const output = await pending;
  assert.deepEqual(output.content, [{ type: "text", text: '{"cancelled":true,"answers":[]}' }]);
  assert.equal(view.closes(), 1);
  h.handlers.get("session_shutdown")!({});
  assert.equal(view.closes(), 1);
});

test("abort before mount, during UI, and shutdown reject rather than return cancellation", async () => {
  for (const beforeMount of [true, false]) {
    const view = ui(), controller = new AbortController();
    const pending = runQuestionnaire(view.ctx, core, controller.signal);
    if (!beforeMount) await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, /aborted/);
    assert.equal(view.closes(), 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
  const h = host(), view = ui();
  const pending = h.tool.execute("id", core, undefined, undefined, view.ctx);
  h.handlers.get("session_shutdown")!({});
  h.handlers.get("session_shutdown")!({});
  await assert.rejects(pending, /aborted/);
  assert.equal(view.closes(), 1);
});

test("already-aborted and unavailable UI fail without reporting user cancellation", async () => {
  const view = ui();
  await assert.rejects(runQuestionnaire(view.ctx, core, AbortSignal.abort()), /abort/i);
  assert.equal(view.closes(), 0);
  const noUI = { mode: "tui", ui: { custom: async () => undefined } } as unknown as ExtensionContext;
  await assert.rejects(runQuestionnaire(noUI, core), /unavailable/);
});
