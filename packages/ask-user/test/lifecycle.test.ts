import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, TerminalInputHandler, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, TuiMainScreen, Editor, type Component, type Terminal } from "@earendil-works/pi-tui";
import { theme } from "./helpers.ts";
import extension from "../src/index.ts";
import { Questionnaire, runQuestionnaire } from "../src/questionnaire.ts";
import { description, parameters } from "../src/schema.ts";
import { core } from "./fixtures/demo.ts";
import { completeOverlay } from "../src/overlay.ts";

const { createInteractiveTuiReference } = await import(new URL("modes/interactive/tui-renderer.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

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

function ui(bindings: Record<string, any> = {}) {
  let component: Questionnaire;
  let closes = 0, removals = 0;
  const tui = new TuiMainScreen({ rows: 30, columns: 100, hideCursor() {}, write() {} } as unknown as Terminal);
  tui.requestRender = () => {};
  const reference = createInteractiveTuiReference(() => tui);
  const identity = (text: string) => text;
  const main = new Editor(tui, { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } });
  tui.setFocus(main);
  const listeners = new Set<TerminalInputHandler>();
  const ctx = {
    mode: "tui",
    ui: {
      onTerminalInput: (handler: TerminalInputHandler) => {
        listeners.add(handler);
        return () => { if (listeners.delete(handler)) removals++; };
      },
      custom: (factory: Function, options: any) => new Promise(resolve => {
        component = factory(reference, theme, new KeybindingsManager(TUI_KEYBINDINGS, bindings), (value: unknown) => {
          closes++; reference.hideOverlay(); resolve(value);
        });
        queueMicrotask(() => options.onHandle?.(tui.showOverlay(component, options.overlayOptions)));
      }),
    },
  } as unknown as ExtensionToolContext;
  const input = (data: string) => {
    for (const listener of listeners) if (listener(data)?.consume) return;
    tui.getFocusedComponent()?.handleInput?.(data);
  };
  return { ctx, tui, reference, main, input, component: () => component, closes: () => closes, listeners, removals: () => removals };
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

test("hide while editing preserves draft/cursor and leaves main editor jump-forward intact", async () => {
  const view = ui();
  const pending = runQuestionnaire(view.ctx, core);
  await Promise.resolve();
  view.input("\x1b[B"); view.input("\x1b[B"); view.input("\r");
  view.input("a b c"); view.input("\x01"); view.input("\x1d"); view.input("c"); view.input("X");
  assert.equal(view.component().state.answers[0].draft, "a b Xc");
  view.input("\x1bh");
  assert.equal(view.tui.getFocusedComponent(), view.main);
  view.input("a b c"); view.input("\x01"); view.input("\x1d"); view.input("c"); view.input("Y");
  assert.equal(view.main.getText(), "a b Yc");
  view.input("\x1bh"); view.input("Z");
  assert.equal(view.component().state.answers[0].draft, "a b XZc");
  view.input("\x1b"); view.input("\x1b"); view.input("\x1b[B"); view.input("\r");
  assert.deepEqual(await pending, { cancelled: true, answers: [] });
  assert.equal(view.listeners.size, 0);
  assert.equal(view.removals(), 1);
  assert.equal(view.tui.hasOverlayEntries, false);
});

test("remapped toggles ignore repeat/release and other overlays keep input and cleanup ownership", async () => {
  const view = ui({ "pi-ask-user.toggle": "alt+j" });
  const controller = new AbortController();
  const pending = runQuestionnaire(view.ctx, core, controller.signal);
  await Promise.resolve();
  view.input("\x1bh"); assert.equal(view.tui.getFocusedComponent(), view.component());
  view.input("\x1b[106;3:2u"); view.input("\x1b[106;3:3u");
  assert.equal(view.tui.getFocusedComponent(), view.component());
  view.input("\x1bj"); assert.equal(view.tui.getFocusedComponent(), view.main);
  const other = { focused: false, render: () => ["other"], invalidate() {} };
  const overlay = view.tui.showOverlay(other);
  view.input("\x1bj"); assert.equal(overlay.isFocused(), true);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(overlay.isFocused(), true);
  overlay.hide();
  assert.equal(view.tui.hasOverlayEntries, false);
  assert.equal(view.tui.getFocusedComponent(), view.main);
  assert.equal(view.removals(), 1);
  controller.abort(); assert.equal(view.closes(), 1);
});

test("disabled toggle cannot hide and visible focus conflicts do not steal input", async () => {
  for (const bindings of [{ "pi-ask-user.toggle": [] }, {}]) {
    const view = ui(bindings), controller = new AbortController();
    const pending = runQuestionnaire(view.ctx, core, controller.signal);
    await Promise.resolve();
    if (Object.keys(bindings).length) {
      view.input("\x1bh"); assert.equal(view.tui.getFocusedComponent(), view.component());
    }
    const other = view.tui.showOverlay({ render: () => [], invalidate() {} });
    view.input("\x1bh"); assert.equal(other.isFocused(), true);
    controller.abort(); await assert.rejects(pending, /aborted/);
    assert.equal(other.isFocused(), true);
    other.hide(); assert.equal(view.tui.hasOverlayEntries, false);
  }
});

test("shutdown while hidden removes listeners/overlay and a new call starts cleanly", async () => {
  const h = host(), view = ui();
  const pending = h.tool.execute("id", core, undefined, undefined, view.ctx);
  await Promise.resolve(); view.input("\x1bh");
  h.handlers.get("session_shutdown")!({});
  await assert.rejects(pending, /aborted/);
  assert.equal(view.tui.hasOverlayEntries, false);
  assert.equal(view.listeners.size, 0);
  const next = h.tool.execute("next", core, undefined, undefined, view.ctx);
  await Promise.resolve(); view.input("\x1b");
  await next;
  assert.equal(view.removals(), 2);
});

test("ownership adapter restores the host method even if completion throws", () => {
  const view = ui();
  const overlay = view.tui.showOverlay({ render: () => [], invalidate() {} });
  assert.throws(() => completeOverlay(view.reference, overlay, () => { view.reference.hideOverlay(); throw new Error("failure"); }), /failure/);
  assert.equal(view.tui.hasOverlayEntries, false);
  view.tui.showOverlay({ render: () => [], invalidate() {} });
  view.reference.hideOverlay();
  assert.equal(view.tui.hasOverlayEntries, false);
});

test("older overlays block mounting so their completion cannot remove a hidden questionnaire", async () => {
  const view = ui();
  const older = view.tui.showOverlay({ render: () => [], invalidate() {} });
  await assert.rejects(runQuestionnaire(view.ctx, core), /Close the existing dialog/);
  assert.equal(view.listeners.size, 0);
  assert.equal(older.isFocused(), true);
  view.reference.hideOverlay();
  assert.equal(view.tui.hasOverlayEntries, false);
});

test("repeated completions restore exact renderer method and do not retain proxy wrappers", () => {
  const view = ui();
  const original = view.tui.hideOverlay;
  const symbols = Object.getOwnPropertySymbols(view.tui);
  for (let i = 0; i < 100; i++) {
    const handle = view.reference.showOverlay({ render: () => [], invalidate() {} });
    completeOverlay(view.reference, handle, () => view.reference.hideOverlay());
    assert.equal(view.tui.hideOverlay, original);
    assert.equal(Object.hasOwn(view.tui, "hideOverlay"), false);
    assert.deepEqual(Object.getOwnPropertySymbols(view.tui), symbols);
  }
  assert.equal(view.tui.hasOverlayEntries, false);
});

test("already-aborted and unavailable UI fail without reporting user cancellation", async () => {
  const view = ui();
  await assert.rejects(runQuestionnaire(view.ctx, core, AbortSignal.abort()), /abort/i);
  assert.equal(view.closes(), 0);
  const noUI = { mode: "tui", ui: { custom: async () => undefined } } as unknown as ExtensionContext;
  await assert.rejects(runQuestionnaire(noUI, core), /unavailable/);
});
