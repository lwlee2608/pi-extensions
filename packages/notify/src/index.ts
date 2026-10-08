import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { sendCommand, sendTelegram } from "./connectors.ts";
import { formatMessage } from "./message.ts";
import { NotifyState } from "./state.ts";

export default function (pi: ExtensionAPI): void {
  const path = join(getAgentDir(), "pi-notify", "config.json");
  const state = new NotifyState();
  let generation = 0;
  let command = 0;
  let activeRun = false;
  let nerdFont = false;
  let controller = new AbortController();

  function status(ctx: ExtensionContext): void {
    ctx.ui.setStatus("notify", state.armed === "off" ? undefined : `${nerdFont ? "\uf0f3" : "🔔"} ${state.armed}`);
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
  async function send(ctx: ExtensionContext, text: string, prompt = false): Promise<void> {
    const current = generation;
    const signal = controller.signal;
    try {
      const config = await loadConfig(path);
      if (current !== generation || (prompt && (!config.onPrompt || !activeRun || state.armed === "off"))) return;
      await Promise.all(config.connectors.map(async (connector, index) => {
        try {
          if (connector.type === "telegram") await sendTelegram(connector, text, signal);
          else await sendCommand(connector, text, signal, ctx.cwd);
        }
        catch {
          if (current === generation) ctx.ui.notify(`Notify: ${connector.type} connector ${index + 1} failed (send error or timeout).`, "warning");
        }
      }));
    } catch (error) {
      if (current === generation) ctx.ui.notify((error as Error).message, "warning");
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
    if (ctx.mode === "tui" && activeRun && state.armed !== "off") {
      void send(ctx, formatMessage(ctx.sessionManager.getSessionName(), ctx.cwd, "waiting for input"), true);
    }
  });
  pi.on("agent_before_settle", (event, ctx) => { if (ctx.mode === "tui") state.beforeSettle(event.outcome); });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeRun = false;
    const outcome = state.settle();
    status(ctx);
    if (outcome) void send(ctx, formatMessage(ctx.sessionManager.getSessionName(), ctx.cwd, outcome));
  });
  async function act(args: string, ctx: ExtensionContext, tool = false): Promise<void> {
    if (ctx.mode !== "tui") {
      if (tool) throw new Error("notify_me is only available in TUI mode.");
      return;
    }
    const action = args.trim();
    const current = generation;
    const request = ++command;
    const stale = () => {
      if (current === generation && request === command) return false;
      if (tool) throw new Error("Notification arming was superseded by a session change or another command.");
      return true;
    };
    const config = loadConfig(path);
    if (action === "off") { state.armed = "off"; status(ctx); }
    try { nerdFont = (await config).nerdFont; }
    catch (error) {
      if (stale()) return;
      state.armed = "off";
      status(ctx);
      if (tool) throw error;
      ctx.ui.notify((error as Error).message, "warning");
      return;
    }
    if (stale()) return;
    if (action === "off") return;
    if (action === "test") {
      void send(ctx, formatMessage(ctx.sessionManager.getSessionName(), ctx.cwd, "test"));
    } else if (action === "" || action === "on") {
      state.armed = action === "on" ? "on" : "once";
      status(ctx);
    } else {
      ctx.ui.notify("Usage: /notify [on|off|test]", "warning");
    }
  }
  pi.registerCommand("notify", {
    description: "Arm phone notifications: next run (no args), on, off, or test",
    handler: (args, ctx) => act(args, ctx),
  });
  pi.registerTool({
    name: "notify_me", label: "Notify me",
    description: "Arm a one-shot notification when this run finishes. Use only when the user explicitly asks to be notified; never arm proactively. A settle to ask a question also consumes the notification.",
    parameters: Type.Object({}), exposure: "model-only", executionMode: "sequential",
    async execute(_id, _params, _signal, _update, ctx) {
      await act("", ctx, true);
      return { content: [{ type: "text", text: "Notification armed for the next completed or errored run." }], details: undefined };
    },
  });
}
