import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { sendTelegram } from "./connectors.ts";
import { formatMessage } from "./message.ts";
import { NotifyState } from "./state.ts";

export default function (pi: ExtensionAPI): void {
  const path = join(getAgentDir(), "pi-notify", "config.json");
  const state = new NotifyState();
  let generation = 0;
  let command = 0;
  let controller = new AbortController();

  function status(ctx: ExtensionContext): void {
    ctx.ui.setStatus("notify", state.armed === "off" ? undefined : `🔔 ${state.armed}`);
  }
  function reset(ctx: ExtensionContext): void {
    generation++;
    command++;
    controller.abort();
    controller = new AbortController();
    state.reset();
    if (ctx.mode === "tui") status(ctx);
  }
  async function send(ctx: ExtensionContext, text: string): Promise<void> {
    const current = generation;
    const signal = controller.signal;
    try {
      const config = await loadConfig(path);
      if (current !== generation) return;
      await Promise.all(config.connectors.map(async (connector, index) => {
        try { await sendTelegram(connector, text, signal); }
        catch {
          if (current === generation) ctx.ui.notify(`Notify: telegram connector ${index + 1} failed (request rejected, network error, or timeout).`, "warning");
        }
      }));
    } catch (error) {
      if (current === generation) ctx.ui.notify((error as Error).message, "warning");
    }
  }

  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => reset(ctx));
  pi.on("agent_start", (_event, ctx) => { if (ctx.mode === "tui") state.start(); });
  pi.on("agent_before_settle", (event, ctx) => { if (ctx.mode === "tui") state.beforeSettle(event.outcome); });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const outcome = state.settle();
    status(ctx);
    if (outcome) void send(ctx, formatMessage(ctx.sessionManager.getSessionName(), ctx.cwd, outcome));
  });
  pi.registerCommand("notify", {
    description: "Arm phone notifications: next run (no args), on, off, or test",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const action = args.trim();
      const current = generation;
      const request = ++command;
      const config = loadConfig(path);
      if (action === "off") { state.armed = "off"; status(ctx); }
      try { await config; }
      catch (error) {
        if (current !== generation || request !== command) return;
        state.armed = "off";
        status(ctx);
        ctx.ui.notify((error as Error).message, "warning");
        return;
      }
      if (current !== generation || request !== command) return;
      if (action === "off") return;
      if (action === "test") {
        void send(ctx, formatMessage(ctx.sessionManager.getSessionName(), ctx.cwd, "test"));
      } else if (action === "" || action === "on") {
        state.armed = action === "on" ? "on" : "once";
        status(ctx);
      } else {
        ctx.ui.notify("Usage: /notify [on|off|test]", "warning");
      }
    },
  });
}
