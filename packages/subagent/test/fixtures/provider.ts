import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { setTimeout as delay } from "node:timers/promises";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("fixture-command", { description: "Must not run for literal tasks", handler: async () => { throw new Error("Slash command dispatched unexpectedly"); } });
  pi.on("input", event => event.text.includes("HANDLE_INPUT") ? { action: "handled" } : undefined);
  pi.registerTool({
    name: "fixture_hold", label: "Fixture hold", description: "Offline controlled tool", parameters: Type.Object({ milliseconds: Type.Number() }),
    async execute(_id, args, signal, update) {
      update?.({ content: [{ type: "text", text: "holding" }], details: undefined });
      await delay(args.milliseconds, undefined, { signal });
      return { content: [{ type: "text", text: "hold complete" }], details: undefined };
    },
  });
  pi.registerProvider("subagent-offline", {
    api: "subagent-offline", apiKey: "offline-not-a-credential",
    models: [{ id: "fixture", name: "Subagent offline fixture", api: "subagent-offline", baseUrl: "http://invalid.invalid", reasoning: false,
      input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: "pending", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        const users = context.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join(" "));
        const text = users.at(-1) ?? "";
        if (options?.signal?.aborted || text.includes("FAIL_PROVIDER")) {
          message.stopReason = options?.signal?.aborted ? "aborted" : "error";
          message.errorMessage = "Offline provider failure";
          stream.push({ type: "error", reason: message.stopReason, error: message });
        } else {
          stream.push({ type: "start", partial: message });
          if (text.includes("PARENT_SMOKE")) {
            const results = context.messages.filter(m => m.role === "toolResult" && m.toolName === "subagent");
            const first = results[0];
            const data = first?.role === "toolResult" ? JSON.parse(first.content.filter(c => c.type === "text").map(c => c.text).join("")) : undefined;
            const args = results.length === 0 ? { action: "start", agent: "worker", task: "CHILD_SMOKE", lifetime: "retained" }
              : results.length === 1 ? { action: "wait", runIds: [data.runId] }
              : results.length === 2 ? { action: "stop", workerId: data.workerId } : undefined;
            if (args) {
              const call: ToolCall = { type: "toolCall", id: `parent-${results.length}`, name: "subagent", arguments: JSON.parse(JSON.stringify(args)) };
              message.content.push(call);
              stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
              stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
              message.stopReason = "toolUse";
            } else { message.content.push({ type: "text", text: "parent smoke complete" }); message.stopReason = "stop"; }
          } else if (context.messages.at(-1)?.role === "user" && text.includes("WRITE_AND_HOLD")) {
            const calls: ToolCall[] = [
              { type: "toolCall" as const, id: `write-${Date.now()}`, name: "write", arguments: { path: "fixture-edit.txt", content: "keep this edit" } },
              { type: "toolCall" as const, id: `hold-${Date.now()}`, name: "fixture_hold", arguments: { milliseconds: 1500 } },
            ];
            calls.forEach((call, contentIndex) => { message.content.push(call); stream.push({ type: "toolcall_start", contentIndex, partial: message }); stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message }); });
            message.stopReason = "toolUse";
          } else {
            const reply = `Offline context: ${users.join(" | ")}`;
            message.content.push({ type: "text", text: reply });
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: message });
            message.stopReason = "stop";
          }
          stream.push({ type: "done", reason: message.stopReason, message });
        }
        stream.end();
      });
      return stream;
    },
  });
}
