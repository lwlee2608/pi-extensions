import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, TuiMainScreen, Container, Editor, type Terminal } from "@earendil-works/pi-tui";
import { theme } from "./helpers.ts";
import extension from "../src/index.ts";
import { Questionnaire, runQuestionnaire } from "../src/questionnaire.ts";
import { description, parameters } from "../src/schema.ts";
import { core } from "./fixtures/demo.ts";

const { InteractiveMode } = await import(new URL("modes/interactive/interactive-mode.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
initTheme("dark", false);

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
  let component: Questionnaire | undefined;
  let closes = 0;
  const tui = new TuiMainScreen({ rows: 30, columns: 100, hideCursor() {}, write() {} } as unknown as Terminal);
  tui.requestRender = () => {};
  const identity = (text: string) => text;
  const main = new Editor(tui, { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } });
  const editorContainer = new Container();
  editorContainer.addChild(main);
  tui.addChild(editorContainer);
  tui.setFocus(main);
  const host = { editor: main, editorContainer, ui: tui, keybindings: new KeybindingsManager(TUI_KEYBINDINGS), disposeActiveSelector() {} };
  const ctx = {
    mode: "tui",
    ui: {
      custom: (factory: Function, options: unknown) => {
        assert.equal(options, undefined);
        return InteractiveMode.prototype.showExtensionCustom.call(host, (tui: TuiMainScreen, theme: Theme, keys: KeybindingsManager, done: (value: unknown) => void) => {
          component = factory(tui, theme, keys, (value: unknown) => {
            closes++; component = undefined; done(value);
          });
          return component;
        });
      },
    },
  } as unknown as ExtensionToolContext;
  const input = (data: string) => tui["handleTerminalInput"](data);
  return { ctx, tui, main, input, component: () => component, closes: () => closes };
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

test("result rendering pairs each answer with its question, like Claude Code", () => {
  const h = host();
  const details = { cancelled: false, answers: [{ questionIndex: 1, selected: ["SQLite"] }, { questionIndex: 2, selected: ["Search"], custom: "Offline", notes: "Soon" }], globalNote: "Ship" };
  const render = (args: unknown) => h.tool.renderResult!({ content: [], details }, { expanded: false, isPartial: false }, theme, { args } as never).render(200).map(line => line.trimEnd()).join("\n");
  assert.equal(render(core), "· Which storage should we use? → SQLite\n· Which features should we include? → Search; Offline\n  Note: Soon\nGlobal note: Ship");
  assert.match(render(undefined), /^· 1\. SQLite/);
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

test("inline questionnaire takes editor focus, ignores type-ahead, submits a single question on choice, and restores focus", async () => {
  const view = ui();
  const pending = runQuestionnaire(view.ctx, { questions: core.questions.slice(0, 1) });
  await Promise.resolve();
  assert.equal(view.tui.getFocusedComponent(), view.component());
  view.input("1");
  await new Promise(resolve => setTimeout(resolve, 450));
  view.input("2");
  assert.deepEqual(await pending, { cancelled: false, answers: [{ questionIndex: 1, selected: ["PostgreSQL"] }] });
  assert.equal(view.tui.getFocusedComponent(), view.main);
  assert.equal(view.closes(), 1);
});

test("existing overlays block mounting without losing ownership or leaving abort listeners", async () => {
  for (const mode of ["visible", "hidden", "responsive"] as const) {
    const view = ui(), controller = new AbortController();
    let received = 0;
    const other = { focused: false, render: () => ["other dialog"], invalidate() {}, handleInput() { received++; } };
    const overlay = view.tui.showOverlay(other, mode === "responsive" ? { visible: () => false } : undefined);
    if (mode === "hidden") overlay.setHidden(true);
    await assert.rejects(runQuestionnaire(view.ctx, core, controller.signal), /Close the existing dialog/);
    assert.equal(view.component(), undefined);
    assert.equal(view.tui.hasOverlayEntries, true);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(view.closes(), 0);
    if (mode === "visible") {
      view.input("\r");
      assert.equal(received, 1);
      assert.equal(overlay.isFocused(), true);
    }
    overlay.hide();
    const next = runQuestionnaire(view.ctx, core);
    await Promise.resolve(); view.input("\x1b");
    assert.deepEqual(await next, { cancelled: true, answers: [] });
    assert.equal(view.tui.getFocusedComponent(), view.main);
  }
});

test("shutdown removes the questionnaire and a new call starts cleanly", async () => {
  const h = host(), view = ui();
  const pending = h.tool.execute("id", core, undefined, undefined, view.ctx);
  await Promise.resolve(); view.input("1");
  h.handlers.get("session_shutdown")!({});
  await assert.rejects(pending, /aborted/);
  assert.equal(view.tui.getFocusedComponent(), view.main);
  const next = h.tool.execute("next", core, undefined, undefined, view.ctx);
  await Promise.resolve(); view.input("\x1b");
  assert.deepEqual((await next).details, { cancelled: true, answers: [] });
  assert.equal(view.closes(), 2);
});

test("already-aborted and unavailable UI fail without reporting user cancellation", async () => {
  const view = ui();
  await assert.rejects(runQuestionnaire(view.ctx, core, AbortSignal.abort()), /abort/i);
  assert.equal(view.closes(), 0);
  const noUI = { mode: "tui", ui: { custom: async () => undefined } } as unknown as ExtensionContext;
  await assert.rejects(runQuestionnaire(noUI, core), /unavailable/);
});

test("tool sends the captured request and reports the summed usage of every explain request", async () => {
  const h = host(), view = ui();
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const usage = (total: number) => ({ input: 300, output: 150, cacheRead: 6500, cacheWrite: 0, totalTokens: 6950, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
  const replies = [{ text: "First.", stopReason: "stop", cost: 0.25 }, { text: "", stopReason: "error", cost: 0.5 }];
  const requests: { role: string; content: unknown }[][] = [];
  Object.assign(view.ctx, {
    model: { id: "m" }, thinkingLevel: "off",
    sessionManager: { buildSessionProjection: () => ({ messages: [] }), getSessionId: () => "s" },
    modelRegistry: {
      streamSimple: (_model: unknown, context: { messages: { role: string; content: unknown }[] }) => {
        const reply = replies[requests.push(context.messages) - 1];
        return {
          async *[Symbol.asyncIterator]() { if (reply.text) yield { type: "text_delta", delta: reply.text }; },
          result: async () => ({ stopReason: reply.stopReason, errorMessage: "boom", usage: usage(reply.cost) }),
        };
      },
    },
  });
  h.handlers.get("context_with_system")!({ type: "context_with_system", messages: [{ role: "system", content: "captured", timestamp: 0 }] });
  const pending = h.tool.execute("id", { questions: core.questions.slice(0, 1) }, undefined, undefined, view.ctx);
  await new Promise(resolve => setTimeout(resolve, 450));
  view.input("4");
  await settle();
  view.input("4");
  await settle();
  view.input("1");
  const output = await pending;
  assert.equal(requests.length, 2);
  assert.deepEqual([requests[0][0].role, requests[0][0].content], ["system", "captured"]);
  assert.deepEqual(output.details, { cancelled: false, answers: [{ questionIndex: 1, selected: ["SQLite"], explanation: "First." }] });
  assert.deepEqual(output.usage, { input: 600, output: 300, cacheRead: 13000, cacheWrite: 0, totalTokens: 13900, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.75 } });
});

test("closing mid-explanation waits for the aborted request so its usage is still reported", async () => {
  const h = host(), view = ui();
  const usage = { input: 300, output: 0, cacheRead: 6500, cacheWrite: 0, totalTokens: 6800, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 } };
  Object.assign(view.ctx, {
    model: { id: "m" }, thinkingLevel: "off",
    sessionManager: { buildSessionProjection: () => ({ messages: [] }), getSessionId: () => "s" },
    modelRegistry: {
      streamSimple: (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
        const result = new Promise(resolve => options.signal.addEventListener("abort", () => setTimeout(() => resolve({ stopReason: "aborted", usage }), 10)));
        return { async *[Symbol.asyncIterator]() {}, result: () => result };
      },
    },
  });
  h.handlers.get("context_with_system")!({ type: "context_with_system", messages: [{ role: "system", content: "captured", timestamp: 0 }] });
  const pending = h.tool.execute("id", { questions: core.questions.slice(0, 1) }, undefined, undefined, view.ctx);
  await new Promise(resolve => setTimeout(resolve, 450));
  view.input("4");
  view.input("1");
  assert.deepEqual((await pending).usage, usage);
});
