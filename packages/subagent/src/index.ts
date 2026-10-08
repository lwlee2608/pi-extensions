import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Manager } from "./manager.ts";
import { Inspector } from "./inspector.ts";
import { modelView, resultText } from "./result.ts";
import { attachPanel, display } from "./panel.ts";
import { Text } from "@earendil-works/pi-tui";
import { loadConfig, resolveLaunch } from "./profiles.ts";
import { parentExtensions } from "./extensions.ts";
import { description, parameters, validateAction, type Effort } from "./schema.ts";

export default function (pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_TOKEN) return;
  let manager: Manager | undefined;
  let detachPanel: (() => void) | undefined;
  let initialization: Promise<Manager> | undefined;
  let closed = false;
  let inspectorOpen = false;
  let closeInspector: (() => void) | undefined;
  const getManager = (ctx: ExtensionContext): Promise<Manager> => initialization ??= (async () => {
    if (closed) throw new Error("Subagent runtime is closed");
    const config = await loadConfig(getAgentDir());
    if (closed) throw new Error("Subagent runtime closed during initialization");
    manager = new Manager({ root: join(getAgentDir(), "pi-subagent"), parentId: ctx.sessionManager.getSessionId(), maxWorkers: config.maxWorkers, maxActive: config.maxActive,
      config: () => loadConfig(getAgentDir(), () => parentExtensions(pi, ctx, getAgentDir())) });
    if (ctx.mode === "tui") detachPanel = attachPanel(manager, ctx.ui);
    return manager;
  })().catch(error => { initialization = undefined; throw error; });
  pi.on("session_start", async (_event, ctx) => {
    if (existsSync(join(getAgentDir(), "pi-subagent", ctx.sessionManager.getSessionId()))) await getManager(ctx);
  });
  pi.on("session_shutdown", async () => {
    closed = true;
    closeInspector?.();
    detachPanel?.(); detachPanel = undefined;
    try { await initialization; } catch { /* Failed initialization owns no child. */ }
    await manager?.shutdown();
  });
  pi.registerCommand("subagents", {
    description: "Inspect live and saved workers; message, reply, stop or recover",
    async handler(_args, ctx) {
      if (ctx.mode !== "tui" || inspectorOpen) return;
      inspectorOpen = true;
      try {
        const active = await getManager(ctx);
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          closeInspector = () => done();
          return new Inspector(active, theme, () => tui.requestRender(), () => tui.terminal.rows, () => done());
        }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } });
      } finally { inspectorOpen = false; closeInspector = undefined; }
    },
  });
  pi.registerTool({
    name: "subagent", label: "Subagent", description, parameters, exposure: "model-only", executionMode: "parallel",
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `Subagent · ${display(args.action ?? "")}${args.label ? ` · ${display(args.label)}` : ""}`), 0, 0);
    },
    renderResult(result, options, theme, context) {
      return new Text(theme.fg(context.isError ? "error" : "muted", resultText(result, options.expanded, context.isError)), 0, 0);
    },
    async execute(_id, args, signal, _update, ctx) {
      validateAction(args);
      signal?.throwIfAborted();
      const active = await getManager(ctx);
      let result: unknown;
      switch (args.action) {
        case "start": {
          const config = await loadConfig(getAgentDir(), () => parentExtensions(pi, ctx, getAgentDir()));
          const skills = pi.getCommands().filter(command => command.source === "skill").flatMap(command => command.sourceInfo?.path ? [command.sourceInfo.path] : []);
          const launch = await resolveLaunch(args, { cwd: ctx.cwd, agentDir: getAgentDir(), model: ctx.model,
            effort: pi.getThinkingLevel() as Effort, models: ctx.modelRegistry.getAvailable(), skills,
            registeredProviders: ctx.modelRegistry.getRegisteredProviderIds(), tools: pi.getAllTools() }, config);
          signal?.throwIfAborted();
          result = active.start(launch, args.task, args.lifetime, args.label);
          break;
        }
        case "message": result = await active.message(args.workerId, args.message, args.mode, args.label); break;
        case "wait": result = await active.wait(args.runIds, args.mode, args.timeoutMs, signal); break;
        case "status": result = active.status(args.workerId); break;
        case "stop": result = await active.stop(args.workerId); break;
        case "recover": result = await active.recover(args.workerId); break;
        case "reply": result = await active.reply(args.questionId, "message" in args ? args.message : undefined, "cancelled" in args); break;
      }
      const usage = active.takeUsage();
      const warning = active.takeUsageWarning();
      return { content: [{ type: "text", text: JSON.stringify(modelView(args.action, result)) }, ...(warning ? [{ type: "text" as const, text: warning }] : [])], details: result, usage };
    },
  });
}
