import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { setTimeout as delay } from "node:timers/promises";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "board_fixture", label: "Offline board fixture", description: "Local verification only",
    parameters: Type.Object({ question: Type.Boolean() }),
    async execute(_id, args, signal, _update, ctx) {
      await delay(8000, undefined, { signal });
      if (args.question) await ctx.ui.confirm("Offline fixture question", "Continue?", { signal });
      return { content: [{ type: "text", text: "PRIVATE_TOOL_OUTPUT" }], details: undefined };
    },
  });
  pi.registerProvider("board-offline", {
    api: "board-offline", apiKey: "offline-not-a-credential",
    models: [{ id: "fixture", name: "Offline fixture", api: "board-offline", baseUrl: "http://invalid.invalid", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: "pending",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => {
        const last = context.messages.at(-1);
        const text = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.filter(c => c.type === "text").map(c => c.text).join(" ")) : "";
        if (options?.signal?.aborted || text.includes("fail")) {
          message.stopReason = options?.signal?.aborted ? "aborted" : "error";
          message.errorMessage = "PRIVATE_PROVIDER_ERROR";
          stream.push({ type: "error", reason: message.stopReason, error: message });
        } else {
          stream.push({ type: "start", partial: message });
          if (last?.role === "user") {
            const call = { type: "toolCall" as const, id: `fixture-${Date.now()}`, name: "board_fixture", arguments: { question: text.includes("question") } };
            message.content.push(call);
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
            message.stopReason = "toolUse";
          } else { message.stopReason = "stop"; }
          stream.push({ type: "done", reason: message.stopReason, message });
        }
        stream.end();
      });
      return stream;
    },
  });
}
