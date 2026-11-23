import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import { loadConfig, loadDraft, saveDraft, type Config } from "./config.ts";
import { sendCommand, sendTelegram } from "./connectors.ts";
import { formatMessage, type Kind } from "./message.ts";
import { SetupMenu, type RowId } from "./setup-menu.ts";
import { runSetup } from "./setup.ts";
import { NotifyState } from "./state.ts";

const LABELS = { once: "next finish", on: "every finish" };
const MAX_REASON = 120;
const TIP = 'To get notified when something happens, say "notify me when <something>" in your prompt.';

export default function (pi: ExtensionAPI, onDialog: (dialog: Promise<void>) => void = () => {}): void {
  const path = join(getAgentDir(), "pi-notify", "config.json");
  const state = new NotifyState();
  let generation = 0;
  let command = 0;
  let activeRun = false;
  let nerdFont = false;
  let controller = new AbortController();
  let openSetup: AbortController | undefined;
  let menuOpen = false;

  function status(ctx: ExtensionContext): void {
    ctx.ui.setStatus("notify", state.armed === "off" ? undefined : `${nerdFont ? "\uf0f3" : "🔔"} ${LABELS[state.armed]}`);
  }
  function reset(ctx: ExtensionContext): void {
    generation++;
    command++;
    controller.abort();
    controller = new AbortController();
    state.reset();
    activeRun = false;
    if (ctx.mode === "tui") status(ctx);
  }
  async function send(ctx: ExtensionContext, kind: Kind): Promise<boolean> {
    const current = generation;
    const prompt = kind === "waiting for input";
    const text = formatMessage(ctx.sessionManager.getSessionName(), ctx.cwd, kind);
    const signal = controller.signal;
    try {
      const config = await loadConfig(path);
      if (current !== generation || (prompt && (!config.onPrompt || !activeRun || state.armed === "off"))) return false;
      const results = await Promise.all(config.connectors.map(async (connector, index) => {
        try {
          if (connector.type === "telegram") await sendTelegram(connector, text, signal);
          else await sendCommand(connector, text, signal, ctx.cwd);
          return true;
        }
        catch {
          const [name, hint] = connector.type === "telegram" ? ["Telegram", "Check your internet connection and /notify setup."] : ["the custom command", "Check it in /notify setup."];
          if (current === generation) ctx.ui.notify(`Could not send to ${name} (destination ${index + 1}). ${hint}`, "warning");
          return false;
        }
      }));
      const ok = current === generation && results.every(Boolean);
      if (ok && kind === "test") ctx.ui.notify("Test notification sent.", "info");
      return ok;
    } catch (error) {
      if (current === generation) ctx.ui.notify((error as Error).message, "warning");
      return false;
    }
  }

  const excludeOutsideTerminal = (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      const active = pi.getActiveTools();
      if (active.includes("notify_me")) pi.setActiveTools(active.filter(name => name !== "notify_me"));
    }
  };
  pi.on("session_start", (event, ctx) => { reset(ctx); excludeOutsideTerminal(event, ctx); });
  pi.on("before_agent_start", excludeOutsideTerminal);
  pi.on("session_shutdown", (_event, ctx) => reset(ctx));
  pi.on("agent_start", (_event, ctx) => { if (ctx.mode === "tui") { activeRun = true; state.start(); } });
  pi.on("ui_prompt_start", (_event, ctx) => {
    if (ctx.mode === "tui" && activeRun && state.armed !== "off" && !menuOpen) {
      void send(ctx, "waiting for input");
    }
  });
  pi.on("agent_before_settle", (event, ctx) => { if (ctx.mode === "tui") state.beforeSettle(event.outcome); });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeRun = false;
    const outcome = state.settle();
    status(ctx);
    if (outcome) void send(ctx, outcome);
  });
  async function setup(ctx: ExtensionContext): Promise<void> {
    if (openSetup === controller) {
      ctx.ui.notify("Notify setup is already open. If you cannot see it, run /reload.", "warning");
      return;
    }
    if (activeRun) {
      ctx.ui.notify("Notify setup cannot open while Pi is working. Try again when it finishes.", "warning");
      return;
    }
    const current = openSetup = controller;
    try {
      const { signal } = current;
      const result = await runSetup(ctx.ui, path, signal);
      if (!result || signal.aborted) return;
      nerdFont = result.draft.nerdFont === true;
      status(ctx);
      ctx.ui.notify(result.valid ? `Notifications are set up. Run /notify to choose when to get one. ${TIP}` : "Saved. Notifications stay off until the problems are fixed.", result.valid ? "info" : "warning");
      if (result.valid && await ctx.ui.confirm("Send a test notification?", "Sends a test message to every destination now, including custom commands.", { signal })) {
        void send(ctx, "test");
      }
    } finally {
      if (openSetup === current) openSetup = undefined;
    }
  }
  async function menu(ctx: ExtensionContext): Promise<void> {
    if (menuOpen) {
      ctx.ui.notify("The notify menu is already open. If you cannot see it, run /reload.", "warning");
      return;
    }
    menuOpen = true;
    const { signal } = controller;
    try {
      let initial: RowId | undefined;
      for (;;) {
        const loaded = await loadConfig(path).catch((error: Error) => error);
        const config = loaded instanceof Error ? undefined : loaded;
        initial ??= !config ? "setup" : state.armed === "off" ? "once" : state.armed;
        const row = (id: RowId, label: string, note = state.armed === id ? " ✓" : "") => ({ id, label: label.padEnd(32), note });
        const choice = signal.aborted ? undefined : await ctx.ui.custom<RowId | undefined>((tui, theme, keys, done) => new SetupMenu({
          title: loaded instanceof Error ? `Notify me (${loaded.message})` : "Notify me",
          hint: `Tip: say "notify me when <something>" in your prompt.\n↑↓ move   enter choose   esc close`,
          initial, signal, rows: () => tui.terminal.rows,
          sections: [
            { header: "When Pi finishes", rows: [row("on", "Every time"), row("once", "Next time only"), row("off", "Off")] },
            ...config ? [{ header: "Saved setting, used while notifications are on", rows: [row("prompt", "Notify when Pi needs an answer", config.onPrompt ? " on" : " off")] }] : [],
            { rows: [{ id: "test", label: "Send a test" }, { id: "setup", label: "Setup" }] },
          ],
        }, theme, keys, done));
        if (choice === undefined || signal.aborted) return;
        if (choice !== "prompt") return await act(String(choice), ctx);
        const draft = await loadDraft(path);
        draft.onPrompt = draft.onPrompt !== true;
        await saveDraft(path, draft);
        initial = choice;
      }
    } finally {
      menuOpen = false;
    }
  }
  function detach(ctx: ExtensionContext, name: string, dialog: (ctx: ExtensionContext) => Promise<void>): void {
    const { signal } = controller;
    // Pi's input loop awaits the command handler, so holding it open behind a replaced dialog would swallow every later input.
    onDialog(dialog(ctx).catch(error => {
      if (!signal.aborted) ctx.ui.notify(`Notify ${name} failed: ${(error as Error).message}`, "warning");
    }));
  }
  function armed(onPrompt: boolean): string {
    const when = state.armed === "on" ? "You get a notification each time Pi finishes (done or error), until /notify off." : "You get one notification when Pi next finishes (done or error). Then notifications turn off.";
    return onPrompt ? `${when} You also get one when Pi needs your answer.` : when;
  }
  async function act(args: string, ctx: ExtensionContext, tool = false): Promise<void> {
    if (ctx.mode !== "tui") {
      if (tool) throw new Error("notify_me is only available in TUI mode.");
      return;
    }
    const action = args.trim();
    if (action === "") return detach(ctx, "menu", menu);
    if (action === "setup") return detach(ctx, "setup", setup);
    const current = generation;
    const request = ++command;
    const stale = () => {
      if (current === generation && request === command) return false;
      if (tool) throw new Error("Notification arming was superseded by a session change or another command.");
      return true;
    };
    const pending = loadConfig(path);
    if (action === "off") { state.armed = "off"; status(ctx); }
    let config: Config;
    try { config = await pending; nerdFont = config.nerdFont; }
    catch (error) {
      if (stale()) return;
      state.armed = "off";
      status(ctx);
      if (tool) throw error;
      ctx.ui.notify((error as Error).message, "warning");
      return;
    }
    if (stale()) return;
    if (action === "off") {
      ctx.ui.notify("Notifications are off.", "info");
    } else if (action === "test") {
      void send(ctx, "test");
    } else if (action === "once" || action === "on") {
      state.armed = action === "on" || (tool && state.armed === "on") ? "on" : "once";
      status(ctx);
      if (!tool) ctx.ui.notify(armed(config.onPrompt), "info");
    } else {
      ctx.ui.notify(`Usage: /notify [once|on|off|test|setup]. ${TIP}`, "warning");
    }
  }
  async function alert(ctx: ExtensionContext, reason: string): Promise<void> {
    if (ctx.mode !== "tui") throw new Error("notify_me is only available in TUI mode.");
    if (!await send(ctx, { reason })) throw new Error("The notification was not sent; Pi shows the user why.");
    if (state.armed === "once") { state.armed = "off"; status(ctx); }
  }
  pi.registerCommand("notify", {
    description: "Phone notifications when Pi finishes: menu (no args), once, on, off, test, or setup",
    getArgumentCompletions: prefix => {
      const items = [
        { value: "on", label: "on", description: "Notify each time Pi finishes" },
        { value: "once", label: "once", description: "Notify when Pi next finishes" },
        { value: "off", label: "off", description: "Turn notifications off" },
        { value: "test", label: "test", description: "Send a test notification now" },
        { value: "setup", label: "setup", description: "Choose where notifications go" },
      ].filter(item => item.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: (args, ctx) => act(args, ctx),
  });
  pi.registerTool({
    name: "notify_me", label: "Notify me",
    description: "Notify the user's phone. Use only when the user explicitly asks to be notified; never notify proactively. " +
      "Without a reason: arms one notification for when this run finishes (done or error); a stop to ask a question also counts as finished. " +
      "With a reason: sends now with that reason. When the user asks to be notified when something happens, call it first without a reason, " +
      "so the user still hears when the run ends if it never happens; then call it with a short reason (e.g. \"tests pass\") as soon as it happens.",
    parameters: Type.Object({ reason: Type.Optional(Type.String({ description: `What happened, a few words (max ${MAX_REASON} characters)` })) }),
    exposure: "model-only", executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const reason = params.reason?.trim().slice(0, MAX_REASON);
      if (reason) {
        await alert(ctx, reason);
        return { content: [{ type: "text", text: "Notification sent." }], details: undefined };
      }
      await act("once", ctx, true);
      return { content: [{ type: "text", text: "Notification armed for the next completed or errored run." }], details: undefined };
    },
  });
}
