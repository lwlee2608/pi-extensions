import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import { loadConfig, loadDraft, readRaw, type Config } from "./config.ts";
import { sendCommand, sendTelegram } from "./connectors.ts";
import { formatMessage, type Kind } from "./message.ts";
import { SWITCH_TAB, type MenuRow, type MenuSection, type RowId } from "./setup-menu.ts";
import { ADD, dialogs, PROMPT_EXAMPLE, saveSetup, setupChoice, setupSections, toggleRow, VALUE_COLUMN, type SetupResult } from "./setup.ts";
import { NotifyState } from "./state.ts";

const LABELS = { once: "next reply", on: "every reply" };
const MAX_REASON = 120;
const TIP = 'To get notified when something specific happens, choose "Specific condition" in /notify or say "notify me when <something>" in your prompt.';
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, MAX_REASON);
const short = (text: string) => text.length > 24 ? `${text.slice(0, 23)}…` : text;
const instruction = (condition: string) => `The user set a phone notification in /notify for when this happens: "${condition}". ` +
  "As soon as you notice it has happened, call notify_me with a short reason. Call it once per occurrence.";

export default function (pi: ExtensionAPI, onDialog: (dialog: Promise<void>) => void = () => {}): void {
  const path = join(getAgentDir(), "pi-notify", "config.json");
  const state = new NotifyState();
  let generation = 0;
  let command = 0;
  let activeRun = false;
  let nerdFont = false;
  let controller = new AbortController();
  let openPanel: AbortController | undefined;
  let injected: string | undefined;

  function status(ctx: ExtensionContext): void {
    const when = state.condition ? ` · when ${short(state.condition)}` : "";
    ctx.ui.setStatus("notify", state.armed === "off" ? undefined : `${nerdFont ? "\uf0f3" : "🔔"} ${LABELS[state.armed]}${when}`);
  }
  function reset(ctx: ExtensionContext): void {
    generation++;
    command++;
    controller.abort();
    controller = new AbortController();
    state.reset();
    injected = undefined;
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
  pi.on("before_agent_start", (event, ctx) => {
    excludeOutsideTerminal(event, ctx);
    injected = ctx.mode === "tui" && state.armed !== "off" ? state.condition : undefined;
    if (injected) return { systemPrompt: `${event.systemPrompt}\n\n${instruction(injected)}` };
  });
  pi.on("session_shutdown", (_event, ctx) => reset(ctx));
  pi.on("agent_start", (_event, ctx) => { if (ctx.mode === "tui") { activeRun = true; state.start(); } });
  pi.on("ui_prompt_start", (_event, ctx) => {
    if (ctx.mode === "tui" && activeRun && state.armed !== "off" && openPanel !== controller) {
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
  async function panel(ctx: ExtensionContext, tab: number): Promise<void> {
    if (openPanel === controller) {
      ctx.ui.notify("Notify settings are already open. If you cannot see them, run /reload.", "warning");
      return;
    }
    if (tab === 1 && activeRun) {
      ctx.ui.notify("Notify setup cannot open while Pi is working. Try again when it finishes.", "warning");
      return;
    }
    const current = openPanel = controller;
    const { signal } = current;
    const ui = dialogs(ctx.ui, signal);
    try {
      const opened = await readRaw(path);
      const draft = await loadDraft(path).catch((error: Error) => error);
      const config = draft instanceof Error ? undefined : draft;
      const original = JSON.stringify(config);
      const connectors = JSON.stringify(config?.connectors);
      const loaded = await loadConfig(path).catch((error: Error) => error);
      if (loaded instanceof Error && !activeRun) tab = 1;
      if (tab === 1 && !config) {
        ui.warn((draft as Error).message);
        return;
      }
      const start = { armed: state.armed, condition: state.condition };
      const arm = { ...start };
      let touched = false;
      const differs = (from: { armed: string; condition?: string }) => arm.armed !== from.armed || arm.condition !== from.condition;
      const armChanged = () => differs(start);
      const configChanged = () => JSON.stringify(config) !== original;
      const setupMode = tab === 1;
      const row = (id: RowId, label: string, on = arm.armed === id): MenuRow => ({ id, label: label.padEnd(VALUE_COLUMN), note: on ? " ✓" : "" });
      const notifyTab = (): MenuSection[] => [
        { header: "When Pi finishes and waits for you", description: "Sent once Pi is done and it is your turn to reply.",
          rows: [row("on", "After every reply"), row("once", "After the next reply only"), row("off", "Off")] },
        { header: "Also when something specific happens", description: "The agent judges when it happens. You can also say it in your prompt.",
          rows: [row("nocondition", "No condition", !arm.condition), { ...row("condition", "Specific condition"), note: arm.condition ? ` ✓ "${arm.condition}"` : "",
            edit: { value: arm.condition ?? "", placeholder: "e.g. the tests pass", set: value => {
              touched = true;
              arm.condition = clean(value) || undefined;
              if (arm.condition && arm.armed === "off") arm.armed = "once";
            } } }] },
        ...config ? [{ header: "Also, while notifications are on (saved for all sessions)", description: PROMPT_EXAMPLE,
          rows: [toggleRow(config, "onPrompt", "Notify on mid-task questions")] }] : [],
      ];
      const setupTab = (): MenuSection[] => activeRun ? [{ header: "Pi is working. Setup opens when it finishes.", rows: [] }]
        : !config ? [{ header: (draft as Error).message, rows: [] }]
        : [...setupSections(config), { rows: [{ id: "test", label: "Send a test" }] }];
      const save = async (): Promise<boolean> => {
        let result: SetupResult | undefined;
        if (config && (configChanged() || setupMode)) {
          result = await saveSetup(ui, path, config, opened, signal);
          if (!result) return false;
          nerdFont = config.nerdFont === true;
        }
        if (signal.aborted) return true;
        if (armChanged() || (touched && differs(state))) {
          if (arm.armed !== "off") state.condition = arm.condition;
          await act(arm.armed, ctx);
        } else {
          status(ctx);
        }
        if (!result || !(setupMode || JSON.stringify(config?.connectors) !== connectors)) return true;
        ctx.ui.notify(result.valid ? `Settings saved.${state.armed === "off" ? " Run /notify to choose when to get a notification." : ""}` : "Saved. Notifications stay off until the problems are fixed.", result.valid ? "info" : "warning");
        if (result.valid && await ui.confirm("Send a test notification?", "Sends a test message to every destination now, including custom commands.")) void send(ctx, "test");
        return true;
      };
      let initial: RowId | undefined = tab === 1 ? undefined : arm.armed === "off" ? "once" : arm.armed;
      for (;;) {
        const unsaved = armChanged() || configChanged();
        const footer: MenuSection = { rows: [{ id: "save", label: "Save and close" }, { id: "discard", label: "Discard and close" }] };
        const all = [notifyTab(), setupTab()].map(sections => [...sections, footer]);
        const choice = await ui.menu({
          title: `${tab === 0 ? "Notify me" : "Notify setup"}${unsaved ? " (unsaved changes)" : ""}`, tabs: { labels: ["Notify", "Setup"], active: tab, all },
          hint: "↑↓ move   enter choose   tab switch   esc discard", initial, sections: all[tab],
        });
        if (choice === undefined || choice === "discard" || signal.aborted) return;
        initial = choice;
        if (choice === SWITCH_TAB) { tab = 1 - tab; initial = undefined; }
        else if (choice === "save") { if (await save()) return; }
        else if (choice === "test") {
          if (configChanged()) ui.warn("Save first, then send a test.");
          else void send(ctx, "test");
        }
        else if (choice === "nocondition") { touched = true; arm.condition = undefined; }
        else if (choice === "off") { touched = true; arm.armed = "off"; arm.condition = undefined; }
        else if (choice === "on" || choice === "once") { touched = true; arm.armed = choice; }
        else if (config && (typeof choice === "number" || choice === ADD)) await setupChoice(ui, config, choice);
      }
    } finally {
      if (openPanel === current) openPanel = undefined;
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
    const every = state.armed === "on";
    const { condition } = state;
    return [
      every ? "You get a notification after every reply, when Pi finishes and waits for you (done or error), until /notify off."
        : "You get one notification after the next reply, when Pi finishes and waits for you (done or error).",
      condition && (every ? `You also get one each time "${condition}" happens, as judged by the agent.`
        : `If "${condition}" happens first, as judged by the agent, you get it then instead.`),
      onPrompt && "You also get one when Pi asks you mid-task to pick an option or approve an action.",
      !every && "Then notifications turn off.",
      condition && activeRun && injected !== condition && "The condition applies from your next prompt.",
    ].filter(Boolean).join(" ");
  }
  async function act(args: string, ctx: ExtensionContext, tool = false): Promise<void> {
    if (ctx.mode !== "tui") {
      if (tool) throw new Error("notify_me is only available in TUI mode.");
      return;
    }
    const action = args.trim();
    if (action === "" || action === "setup") return detach(ctx, action || "menu", ctx => panel(ctx, action === "setup" ? 1 : 0));
    const current = generation;
    const request = ++command;
    const stale = () => {
      if (current === generation && request === command) return false;
      if (tool) throw new Error("Notification arming was superseded by a session change or another command.");
      return true;
    };
    const pending = loadConfig(path);
    if (action === "off") { state.disarm(); status(ctx); }
    let config: Config;
    try { config = await pending; nerdFont = config.nerdFont; }
    catch (error) {
      if (stale()) return;
      state.disarm();
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
  async function alert(ctx: ExtensionContext, reason: string): Promise<string> {
    if (ctx.mode !== "tui") throw new Error("notify_me is only available in TUI mode.");
    if (injected && state.condition !== injected) return "Not sent: the /notify condition already sent its notification, or the user changed it.";
    const request = command;
    if (!await send(ctx, { reason })) throw new Error("The notification was not sent; Pi shows the user why.");
    if (request === command) state.fired();
    status(ctx);
    return "Notification sent.";
  }
  pi.registerCommand("notify", {
    description: "Phone notifications when Pi finishes: menu (no args), once, on, off, test, or setup",
    getArgumentCompletions: prefix => {
      const items = [
        { value: "on", label: "on", description: "Notify after every reply" },
        { value: "once", label: "once", description: "Notify after the next reply only" },
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
      "so the user still hears when the run ends if it never happens; then call it with a short reason (e.g. \"tests pass\") as soon as it happens. " +
      "Also call it with a reason when a condition the user set in /notify happens.",
    parameters: Type.Object({ reason: Type.Optional(Type.String({ description: `What happened, a few words (max ${MAX_REASON} characters)` })) }),
    exposure: "model-only", executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      const reason = clean(params.reason ?? "");
      if (reason) {
        return { content: [{ type: "text", text: await alert(ctx, reason) }], details: undefined };
      }
      await act("once", ctx, true);
      return { content: [{ type: "text", text: "Notification armed for the next completed or errored run." }], details: undefined };
    },
  });
}
