import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Manager } from "./manager.ts";
import { attachPanel } from "./panel.ts";
import { loadConfig, resolveLaunch } from "./profiles.ts";
import { description, parameters, validateAction, type Effort } from "./schema.ts";

export default function (pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_TOKEN) throw new Error("Nested subagent delegation is disabled; remove the parent extension from the child allowlist");
  let manager: Manager | undefined;
  let detachPanel: (() => void) | undefined;
  let initialization: Promise<Manager> | undefined;
  let closed = false;
  const getManager = (ctx: ExtensionContext): Promise<Manager> => initialization ??= (async () => {
    if (closed) throw new Error("Subagent runtime is closed");
    const config = await loadConfig(getAgentDir());
    if (closed) throw new Error("Subagent runtime closed during initialization");
    manager = new Manager({ root: join(getAgentDir(), "pi-subagent"), parentId: ctx.sessionManager.getSessionId(), maxWorkers: config.maxWorkers });
    if (ctx.mode === "tui") detachPanel = attachPanel(manager, ctx.ui);
    return manager;
  })().catch(error => { initialization = undefined; throw error; });
  pi.on("session_shutdown", async () => {
    closed = true;
    detachPanel?.(); detachPanel = undefined;
    try { await initialization; } catch { /* Failed initialization owns no child. */ }
    await manager?.shutdown();
  });
  pi.registerTool({
    name: "subagent", label: "Subagent", description, parameters, exposure: "model-only", executionMode: "parallel",
    async execute(_id, args, signal, _update, ctx) {
      validateAction(args);
      signal?.throwIfAborted();
      const active = await getManager(ctx);
      let result: unknown;
      switch (args.action) {
        case "start": {
          const config = await loadConfig(getAgentDir());
          const skills = pi.getCommands().filter(command => command.source === "skill").flatMap(command => command.sourceInfo?.path ? [command.sourceInfo.path] : []);
          const launch = await resolveLaunch(args, { cwd: ctx.cwd, agentDir: getAgentDir(), model: ctx.model,
            effort: pi.getThinkingLevel() as Effort, models: ctx.modelRegistry.getAvailable(), skills,
            registeredProviders: ctx.modelRegistry.getRegisteredProviderIds() }, config);
          signal?.throwIfAborted();
          result = active.start(launch, args.task, args.lifetime, args.label);
          break;
        }
        case "message": result = await active.message(args.workerId, args.message, args.mode, args.label); break;
        case "wait": result = await active.wait(args.runIds, args.mode, args.timeoutMs, signal); break;
        case "status": result = active.status(args.workerId); break;
        case "stop": result = await active.stop(args.workerId); break;
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, usage: active.takeUsage() };
    },
  });
}
