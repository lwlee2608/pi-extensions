import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Board } from "./board.ts";
import { HEARTBEAT_MS, Registration, type Metadata } from "./registry.ts";
import { serveRenames } from "./rename.ts";
import { SessionState } from "./state.ts";

export default function (pi: ExtensionAPI): void {
  const root = join(getAgentDir(), "pi-session-board");
  let registration: Registration | undefined;
  let metadata: Metadata | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let warned = false;
  let boardOpen = false;
  let startingBoard = false;
  let state = new SessionState();
  let generation = 0;
  let closeBoard: (() => void) | undefined;
  let closeRenames: (() => Promise<void>) | undefined;

  function warn(ctx: ExtensionContext): void {
    if (!warned) ctx.ui.notify("Session Board cannot update its registry; retrying.", "warning");
    warned = true;
  }
  async function publish(ctx: ExtensionContext): Promise<void> {
    if (!registration || !metadata) return;
    const owner = registration;
    try { await owner.publish({ ...metadata, ...state.snapshot() }); if (owner === registration) warned = false; }
    catch { if (owner === registration) warn(ctx); }
  }
  async function stop(ctx: ExtensionContext): Promise<void> {
    generation++;
    closeBoard?.();
    clearInterval(timer);
    timer = undefined;
    const old = registration;
    registration = undefined;
    metadata = undefined;
    const close = closeRenames;
    closeRenames = undefined;
    try { await close?.(); } catch { warn(ctx); }
    try { await old?.close(); } catch { warn(ctx); }
  }

  pi.on("session_start", async (_event, ctx) => {
    const stopping = stop(ctx);
    const currentGeneration = generation;
    await stopping;
    if (ctx.mode !== "tui" || generation !== currentGeneration) return;
    registration = new Registration(root);
    state = new SessionState();
    if (!ctx.isIdle()) state.start();
    metadata = {
      sessionId: ctx.sessionManager.getSessionId(), name: ctx.sessionManager.getSessionName() ?? "",
      cwd: ctx.cwd, status: ctx.isIdle() ? "idle" : "working", statusSince: Date.now(),
    };
    const owner = registration;
    const sessionId = metadata.sessionId;
    try {
      const close = await serveRenames(root, owner.id, sessionId, name => {
        if (registration !== owner || generation !== currentGeneration || ctx.sessionManager.getSessionId() !== sessionId) throw new Error("Session changed");
        pi.setSessionName(name);
      });
      if (generation !== currentGeneration) { await close(); return; }
      closeRenames = close;
    } catch { ctx.ui.notify("Session Board remote rename unavailable; monitoring still works.", "warning"); }
    if (generation !== currentGeneration) return;
    await publish(ctx);
    if (generation === currentGeneration) timer = setInterval(() => void publish(ctx), HEARTBEAT_MS);
  });
  pi.on("session_shutdown", async (_event, ctx) => { await stop(ctx); });
  pi.on("session_info_changed", async (event, ctx) => {
    if (metadata) { metadata.name = event.name ?? ""; await publish(ctx); }
  });
  pi.on("agent_start", async (_event, ctx) => { state.start(); await publish(ctx); });
  pi.on("agent_before_settle", event => { state.beforeSettle(event.outcome); });
  pi.on("agent_settled", async (_event, ctx) => { state.settle(); await publish(ctx); });
  pi.on("tool_execution_start", async (event, ctx) => { state.toolStart(event.toolCallId, event.toolName); await publish(ctx); });
  pi.on("tool_execution_end", async (event, ctx) => { state.toolEnd(event.toolCallId); await publish(ctx); });
  pi.on("ui_prompt_start", async (event, ctx) => {
    state.promptStart(startingBoard && event.kind === "custom");
    startingBoard = false;
    await publish(ctx);
  });
  pi.on("ui_prompt_end", async (_event, ctx) => { state.promptEnd(); await publish(ctx); });
  pi.on("session_before_compact", async (_event, ctx) => { state.compactStart(); await publish(ctx); });
  pi.on("session_compact", async (_event, ctx) => { state.compactEnd("completed"); await publish(ctx); });
  pi.on("session_compact_failed", async (event, ctx) => { state.compactEnd(event.aborted ? "aborted" : "error"); await publish(ctx); });
  pi.registerCommand("sessions", {
    description: "Observe running Pi terminal sessions",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || boardOpen) return;
      boardOpen = true;
      try {
        startingBoard = true;
        const interaction = ctx.ui.custom<void>((tui, theme, _keys, done) => {
          closeBoard = () => done();
          const board: Board = new Board(root, registration?.id, theme,
            () => tui.requestRender(), () => tui.terminal.rows, () => done(),
            () => board.focused);
          return board;
        }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } });
        await interaction;
      } finally { boardOpen = false; startingBoard = false; closeBoard = undefined; }
    },
  });
}
