import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Child-only: the IPC descriptor exists only on a process started by our parent.
export default function (pi: ExtensionAPI): void {
  const token = process.env.PI_SUBAGENT_TOKEN;
  if (!token || !process.send) throw new Error("Subagent bootstrap requires its owning parent's IPC channel");
  const tools = JSON.parse(process.env.PI_SUBAGENT_TOOLS ?? "[]") as string[];
  pi.on("session_start", async (_event, ctx) => {
    try {
      const provider = ctx.model?.provider;
      if (!provider) throw new Error("Child has no selected provider");
      const refreshed = await ctx.modelRegistry.refresh({ providers: [provider], allowNetwork: false, signal: AbortSignal.timeout(10_000) });
      if (refreshed.aborted || refreshed.errors.size) throw new Error(`Child provider initialization failed: ${[...refreshed.errors.values()].map(error => error.message).join("; ") || "timed out"}`);
    } catch (error) {
      process.send?.({ type: "subagent_ready", token, error: String(error) });
      return;
    }
    const available = new Set(pi.getAllTools().map(t => t.name));
    const missing = tools.filter(t => !available.has(t));
    const nested = pi.getAllTools().filter(t => /subagent|delegate/i.test(t.name));
    if (missing.length || nested.length) {
      process.send?.({ type: "subagent_ready", token, error: `Child tool setup failed: missing [${missing}], nested [${nested.map(t => t.name)}]` });
      return;
    }
    pi.setActiveTools(tools);
    process.send?.({ type: "subagent_ready", token, tools: pi.getActiveTools(), sessionId: ctx.sessionManager.getSessionId(),
      registeredProviders: ctx.modelRegistry.getRegisteredProviderIds() });
  });
  pi.on("before_agent_start", () => { pi.setActiveTools(tools); });
  pi.on("tool_call", event => {
    if (!tools.includes(event.toolName)) return { block: true, reason: "Tool is outside the child launch contract" };
  });
  pi.on("cache_warming_decision", () => ({ action: "stop" }));
  process.once("disconnect", () => { process.kill(process.pid, "SIGTERM"); });
}
