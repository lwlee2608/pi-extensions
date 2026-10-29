import { convertToLlm, type ContextWithSystemEvent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message, ToolCall } from "@earendil-works/pi-ai";
import type { Params } from "./schema.ts";
import type { ExplainUsage } from "./result.ts";

export type Request = ContextWithSystemEvent["messages"];
export type Explain = (questionIndex: number, signal: AbortSignal, onText: (text: string) => void) => Promise<{ text: string; usage: ExplainUsage }>;

export function explainPrompt(params: Params, index: number): string {
  const { question, options, multiSelect } = params.questions[index];
  const brief = { question, multiSelect, options: options.map(({ label, description }) => ({ label, description })) };
  return [
    `The user is answering your ask_user_question questionnaire and does not understand question ${index + 1}:`,
    JSON.stringify(brief),
    "Explain in plain language what this question decides and how the options differ, with your recommendation if you have one. Under 150 words, plain text without Markdown. Reply with text only: no tool calls, no questions back.",
  ].join("\n\n");
}

// The pending tool calls have no results yet; providers reject a transcript that ends in an unanswered call.
export function explainMessages(request: Message[], tail: Message[], prompt: string, now = Date.now()): Message[] {
  const answered = new Set(tail.flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []));
  const pending = tail.flatMap(message => message.role === "assistant"
    ? message.content.filter((part): part is ToolCall => part.type === "toolCall" && !answered.has(part.id))
    : []);
  return [
    ...request,
    ...tail,
    ...pending.map(call => ({ role: "toolResult" as const, toolCallId: call.id, toolName: call.name, content: [{ type: "text" as const, text: "Waiting: the questionnaire is still open." }], isError: false, timestamp: now })),
    { role: "user", content: prompt, timestamp: now },
  ];
}

export function explainer(ctx: ExtensionContext, params: Params, lastRequest: () => Request | undefined): Explain {
  return async (index, signal, onText) => {
    const model = ctx.model;
    if (!model) throw new Error("No model selected.");
    const transcript = convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
    const last = transcript.findLastIndex(message => message.role === "assistant");
    const cut = last >= 0 ? last : transcript.length;
    const captured = lastRequest();
    const request = captured ? convertToLlm(captured) : [{ role: "system" as const, content: ctx.getSystemPrompt(), timestamp: Date.now() }, ...transcript.slice(0, cut)];
    const messages = explainMessages(request, transcript.slice(cut), explainPrompt(params, index));
    const stream = ctx.modelRegistry.streamSimple(model, { messages }, { signal, sessionId: ctx.sessionManager.getSessionId(), reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel });
    let text = "";
    for await (const event of stream) if (event.type === "text_delta") onText(text += event.delta);
    const message = await stream.result();
    if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || `Explanation ${message.stopReason}.`);
    if (!text.trim()) throw new Error("The model returned no explanation.");
    const { input, cacheRead, cacheWrite, output, cost } = message.usage;
    return { text: text.trim(), usage: { input, cacheRead, cacheWrite, output, cost: cost.total } };
  };
}
