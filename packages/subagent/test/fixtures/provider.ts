import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type TextContent, type ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { setTimeout as delay } from "node:timers/promises";

type Stream = ReturnType<typeof createAssistantMessageEventStream>;
function emit(stream: Stream, message: AssistantMessage, blocks: (TextContent | ToolCall)[]): "toolUse" | "stop" {
  for (const block of blocks) {
    const contentIndex = message.content.push(block) - 1;
    if (block.type === "text") {
      stream.push({ type: "text_start", contentIndex, partial: message });
      stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
    } else { stream.push({ type: "toolcall_start", contentIndex, partial: message }); stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message }); }
  }
  return blocks.some(b => b.type === "toolCall") ? "toolUse" : "stop";
}
const say = (text: string): TextContent => ({ type: "text", text });
const call = (name: string, args: object): ToolCall => ({ type: "toolCall", id: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.parse(JSON.stringify(args)) });
const bash = (text: string, seconds: number, output: string): [string, ToolCall] => [text, call("bash", { command: `sleep ${seconds}; echo '${output}'` })];
function script(text: string): { steps: [string, ToolCall][]; final: string } | undefined {
  if (text.includes("BUILD_PHASE")) return { steps: [
    bash("Reading the phase tasks in plans/auth.md", 2, "4 tasks, Verify: npm test"),
    ...text.includes("ASK") ? [["Two stores fit the plan; asking before I pick one", call("ask_parent", { question: "Store sessions in Redis or Postgres?" })] as [string, ToolCall]] : [],
    bash("Implementing the phase", text.includes("ASK") ? 4 : 7, "edited 3 files"),
    bash("Running checks", 4, "42 tests pass"),
  ], final: "Phase built and verified. PR opened against integrate/auth." };
  if (text.includes("REVIEW_PR")) return { steps: [bash("Reading the PR diff", 3, "+120 -14 across 3 files"), bash("Checking error paths and tests", 4, "done")],
    final: text.includes("CLEAN") ? "No findings. Ready to merge." : "1 finding. Medium, likely, worth fixing: expired sessions are accepted on refresh." };
  if (text.includes("FIX_FINDINGS")) return { steps: [bash("Applying the review fix", 3, "edited 1 file"), bash("Re-running checks", 3, "43 tests pass")], final: "Fixed the finding in a separate commit and pushed." };
}
const phases = [{ label: "Phase 1", task: "BUILD_PHASE 1: session store", start: "Phase 1 has no blockers. Starting its worker." },
  { label: "Phase 2", task: "BUILD_PHASE 2 ASK: login API", start: "Phase 1 merged. Phase 2 was blocked by it; starting its worker." }];
function orchestrate(messages: Message[]): (TextContent | ToolCall)[] {
  const turn = messages.slice(messages.findLastIndex(m => m.role === "user") + 1);
  const results = new Map(turn.flatMap(m => m.role === "toolResult" && !m.isError ? [[m.toolCallId, JSON.parse(m.content.find(c => c.type === "text")?.text ?? "null")]] : []));
  const calls = turn.flatMap(m => m.role === "assistant" ? m.content.flatMap(c => c.type === "toolCall" ? [{ args: c.arguments, result: results.get(c.id) }] : []) : []);
  const last = calls.at(-1), stops = calls.filter(c => c.args.action === "stop").length, phase = phases[stops];
  const current = calls.slice(calls.findLastIndex(c => c.args.action === "stop") + 1), worker = current.find(c => c.args.agent === "worker")?.result;
  const subagent = (args: object) => call("subagent", args);
  if (last && !last.result) return [say(`The ${last.args.action} call failed, so the build stops here.`)];
  switch (last?.args.action) {
    case "start": case "message": return [subagent({ action: "wait", runIds: [last.result.runId] })];
    case "reply": return [subagent(calls.findLast(c => c.args.action === "wait")!.args)];
    case "wait": if (last.result.reason === "attention") return [say(`${phase.label} asks which session store to use. The plan locks Redis.`),
      ...last.result.pendingQuestionIds.map((questionId: string) => subagent({ action: "reply", questionId, message: "Redis. The plan locks it under Decisions." }))];
  }
  if (!phase) return [say("Both phases merged into integrate/auth. Demo passed; the final PR to main is yours to merge.")];
  const review = (clean: boolean) => subagent({ action: "start", agent: "reviewer", lifetime: "once", parentWorkerId: worker.workerId, task: `REVIEW_PR${clean ? " CLEAN" : ""}: review the ${phase.label} PR` });
  switch (current.filter(c => c.args.action === "wait" && c.result.reason === "completed").length) {
    case 0: return [say(phase.start), subagent({ action: "start", agent: "worker", lifetime: "retained", label: phase.label, task: phase.task })];
    case 1: return [say(`${phase.label} PR is open. Review round 1.`), review(false)];
    case 2: return [say(`Relaying round 1 findings to the ${phase.label} worker.`),
      subagent({ action: "message", workerId: worker.workerId, mode: "task", label: `${phase.label} round 1`, message: "FIX_FINDINGS: expired sessions are accepted on refresh" })];
    case 3: return [say("Fix pushed. Review round 2."), review(true)];
    default: return [say(`Round 2 is clean. Merging ${phase.label} and retiring its worker.`), subagent({ action: "stop", workerId: worker.workerId })];
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("fixture-command", { description: "Must not run for literal tasks", handler: async () => { throw new Error("Slash command dispatched unexpectedly"); } });
  pi.on("input", async event => {
    if (event.text.includes("TIMEOUT_STEER")) await delay(22_000);
    else if (event.text.includes("LATE_STEER")) await delay(2200);
    return event.text.includes("HANDLE_INPUT") ? { action: "handled" } : undefined;
  });
  pi.on("session_before_compact", () => { throw new Error("OFFLINE_RECOVERY_FAILED"); });
  pi.registerTool({
    name: "fixture_hold", label: "Fixture hold", description: "Offline controlled tool", parameters: Type.Object({ milliseconds: Type.Number() }),
    async execute(_id, args, signal, update) {
      update?.({ content: [{ type: "text", text: "holding" }], details: undefined });
      await delay(args.milliseconds, undefined, { signal });
      return { content: [{ type: "text", text: "hold complete" }], details: undefined };
    },
  });
  pi.registerTool({
    name: "fixture_permission", label: "Permission fixture", description: "Unexpected RPC permission", parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, ctx) {
      const allowed = await ctx.ui.confirm("Unexpected permission", "Approve?", { signal });
      return { content: [{ type: "text", text: allowed ? "AUTO_APPROVED" : "refused" }], details: undefined };
    },
  });
  pi.registerTool({
    name: "fixture_nested", label: "Nested fixture", description: "Verify child question is not callable by tools", parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const result = await ctx.executeTool("ask_parent", { question: "Nested question must be denied" });
      if (!result.isError) throw new Error("Nested question unexpectedly succeeded");
      return { content: [{ type: "text", text: "NESTED_DENIED" }], details: undefined };
    },
  });
  pi.registerProvider("subagent-offline", {
    api: "subagent-offline", apiKey: process.env.PI_SUBAGENT_FIXTURE_KEY ? "$PI_SUBAGENT_FIXTURE_KEY" : "offline-not-a-credential",
    models: [{ id: "fixture", name: "Subagent offline fixture", api: "subagent-offline", baseUrl: "http://invalid.invalid", reasoning: false,
      input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: "pending", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(async () => {
        const users = context.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join(" "));
        const text = users.at(-1) ?? "";
        if (text.includes("SLOW_BILLABLE") && (!text.includes("WRITE_AND_HOLD") || context.messages.at(-1)?.role !== "user")) {
          stream.push({ type: "start", partial: message });
          message.content.push({ type: "text", text: "BILLABLE_RESPONSE" });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "BILLABLE_RESPONSE", partial: message });
          try { await delay(text.includes("WRITE_AND_HOLD") ? 30_000 : 1500, undefined, { signal: options?.signal }); } catch { /* Emit authoritative aborted usage below. */ }
          message.stopReason = options?.signal?.aborted ? "aborted" : "stop";
          if (message.stopReason === "aborted") {
            message.errorMessage = "Offline cancellation";
            if (text.includes("WRITE_AND_HOLD")) message.content.push({ type: "text", text: "FINAL_ABORT_TEXT" });
            stream.push({ type: "error", reason: "aborted", error: message });
          } else {
            stream.push({ type: "text_end", contentIndex: 0, content: "BILLABLE_RESPONSE", partial: message });
            stream.push({ type: "done", reason: "stop", message });
          }
        } else if (options?.signal?.aborted || text.includes("FAIL_PROVIDER")) {
          message.stopReason = options?.signal?.aborted ? "aborted" : "error";
          message.errorMessage = "Offline provider failure";
          stream.push({ type: "error", reason: message.stopReason, error: message });
        } else {
          stream.push({ type: "start", partial: message });
          if (text.includes("PARENT_UI")) {
            const results = context.messages.filter(m => m.role === "toolResult" && m.toolName === "subagent");
            const data = results.map(r => r.role === "toolResult" ? JSON.parse(r.content.filter(c => c.type === "text").map(c => c.text).join("")) : undefined);
            const args = results.length < 2 ? { action: "start", agent: "worker", lifetime: "retained", label: results.length ? "Question worker 界" : "Working worker 😀", task: results.length ? "ASK_PARENT DELAY_QUESTION" : "WRITE_AND_HOLD LONG_HOLD" }
              : results.length === 2 ? { action: "wait", runIds: data.slice(0, 2).map(r => r.runId), mode: "all" }
              : undefined;
            if (args) {
              const call: ToolCall = { type: "toolCall", id: `ui-${results.length}`, name: "subagent", arguments: JSON.parse(JSON.stringify(args)) };
              message.content.push(call); stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
              stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message }); message.stopReason = "toolUse";
            } else { message.content.push({ type: "text", text: "Open /subagents to inspect, message, reply, stop, or recover the retained workers." }); message.stopReason = "stop"; }
          } else if (text.includes("BUILD_UI")) {
            message.stopReason = emit(stream, message, orchestrate(context.messages));
          } else if (script(text) && context.messages.at(-1)?.role !== "assistant") {
            const { steps, final } = script(text)!, step = steps[context.messages.slice(context.messages.findLastIndex(m => m.role === "user") + 1).filter(m => m.role === "toolResult").length];
            message.stopReason = emit(stream, message, step ? [say(step[0]), step[1]] : [say(final)]);
          } else if (text.includes("PARENT_SMOKE")) {
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
          } else if (context.messages.at(-1)?.role === "user" && (text.includes("ASK_PARENT") || text.includes("UNEXPECTED_PERMISSION") || text.includes("NESTED_QUESTION"))) {
            const permission = text.includes("UNEXPECTED_PERMISSION"), nested = text.includes("NESTED_QUESTION");
            const call: ToolCall = { type: "toolCall", id: `question-${Date.now()}`, name: nested ? "fixture_nested" : permission ? "fixture_permission" : "ask_parent", arguments: permission || nested ? {} : { question: "Which disposable filename should I use?" } };
            if (text.includes("DELAY_QUESTION")) {
              const hold: ToolCall = { type: "toolCall", id: `before-question-${Date.now()}`, name: "fixture_hold", arguments: { milliseconds: 10_000 } };
              message.content.push(hold); stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
              stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: hold, partial: message });
            }
            const questionIndex = message.content.length;
            message.content.push(call);
            stream.push({ type: "toolcall_start", contentIndex: questionIndex, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: questionIndex, toolCall: call, partial: message });
            if (text.includes("THEN_WRITE")) {
              const write: ToolCall = { type: "toolCall", id: `after-question-${Date.now()}`, name: "write", arguments: { path: "after-question.txt", content: "only after reply" } };
              message.content.push(write);
              stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
              stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: write, partial: message });
            }
            message.stopReason = "toolUse";
          } else if (context.messages.at(-1)?.role === "user" && text.includes("WRITE_AND_HOLD")) {
            const calls: ToolCall[] = [
              { type: "toolCall" as const, id: `write-${Date.now()}`, name: "write", arguments: { path: "fixture-edit.txt", content: "keep this edit" } },
              { type: "toolCall" as const, id: `hold-${Date.now()}`, name: "fixture_hold", arguments: { milliseconds: text.includes("LONG_HOLD") ? 120_000 : 1500 } },
            ];
            calls.forEach((call, contentIndex) => { message.content.push(call); stream.push({ type: "toolcall_start", contentIndex, partial: message }); stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message }); });
            message.stopReason = "toolUse";
          } else {
            const last = context.messages.at(-1);
            const answer = last?.role === "toolResult" && last.toolName === "ask_parent" ? last.content.filter(c => c.type === "text").map(c => c.text).join(" ") : "";
            const reply = `Offline context: ${users.join(" | ")}${answer ? ` | Parent answer: ${answer}` : ""}`;
            message.content.push({ type: "text", text: reply });
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: message });
            message.stopReason = text.includes("TRUNCATE_RECOVERY") ? "length" : "stop";
          }
          stream.push({ type: "done", reason: message.stopReason, message });
        }
        stream.end();
      });
      return stream;
    },
  });
}
