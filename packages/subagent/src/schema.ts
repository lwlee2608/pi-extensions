import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

const text = Type.String({ minLength: 1, maxLength: 100_000, pattern: "\\S" });
const id = Type.String({ pattern: "^[a-z][a-z0-9-]{1,80}$" });
const label = Type.Optional(Type.String({ minLength: 1, maxLength: 160, pattern: "\\S" }));
export const effortSchema = Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")]);
export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const actionSchema = Type.Union([
  object({ action: Type.Literal("start"), agent: Type.String({ pattern: "^[a-zA-Z0-9_-]+$" }), task: text, label,
    cwd: Type.Optional(text), model: Type.Optional(text), effort: Type.Optional(effortSchema),
    lifetime: Type.Optional(Type.Union([Type.Literal("once"), Type.Literal("retained")])),
    agentScope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")])), parentWorkerId: Type.Optional(id) }),
  object({ action: Type.Literal("message"), workerId: id, message: text, label,
    mode: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("steer")])) }),
  object({ action: Type.Literal("wait"), runIds: Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true }),
    mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("any")])),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })) }),
  object({ action: Type.Literal("status"), workerId: Type.Optional(id) }),
  object({ action: Type.Literal("stop"), workerId: id }),
  object({ action: Type.Literal("recover"), workerId: id }),
  object({ action: Type.Literal("reply"), questionId: id, message: text }),
  object({ action: Type.Literal("reply"), questionId: id, cancelled: Type.Literal(true) }),
]);
// Provider function schemas require an object at the root. Validate the stricter
// action-specific union locally before touching a worker.
export const parameters = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("message"), Type.Literal("wait"), Type.Literal("status"), Type.Literal("stop"), Type.Literal("reply"), Type.Literal("recover")]),
  agent: Type.Optional(Type.String({ ...text, description: "Profile for start; defaults to worker" })), task: Type.Optional(text), label, cwd: Type.Optional(text), model: Type.Optional(text),
  effort: Type.Optional(effortSchema), lifetime: Type.Optional(Type.Union([Type.Literal("once"), Type.Literal("retained")])),
  agentScope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")])),
  workerId: Type.Optional(id), parentWorkerId: Type.Optional(id), message: Type.Optional(text), questionId: Type.Optional(id), cancelled: Type.Optional(Type.Literal(true)),
  mode: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("steer"), Type.Literal("all"), Type.Literal("any")])),
  runIds: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
}, { additionalProperties: false });
export type Action = Static<typeof actionSchema>;
export type Start = Extract<Action, { action: "start" }>;
export function validateAction(value: unknown): asserts value is Action {
  const raw = value as { action?: unknown; agent?: unknown } | null;
  if (raw?.action === "start") raw.agent ??= "worker";
  if (!Check(actionSchema, value)) throw new Error("Invalid subagent action or arguments. Supported actions: start/message/wait/status/stop/reply/recover.");
  const action = value as Action;
  if (action.action === "message" && action.mode === "steer" && action.label !== undefined) throw new Error("Steering cannot relabel a run.");
}
export const description = "Start isolated Pi workers and fresh reviewers. Call subagent directly, never through codemode. start returns admission, not completion: wait on its runId. Only wait returns result text; other actions return compact worker state. If result.truncated, the preview is partial: read result.outputFile (else the worker sessionFile) before evaluating or relaying it. result.incomplete means the latest response failed; outputFile holds only the partial text. Default lifetime once retires automatically; retained workers accept new tasks only while idle; a working worker accepts only steer. Cancelling wait leaves workers running. stop closes a worker without deleting edits. Profiles are instructions, not an OS sandbox. Work beyond configured active/live limits queues. Any owned pending question interrupts wait with attention, even from workers not being waited on; answer with reply, or reply cancelled to interrupt the child. recover reopens a closed retained worker in its original parent, idle without replay; then send a new task. Recovery is refused if prerequisites are missing or changed, or ownership is uncertain. parentWorkerId on start nests the new worker under that top-level worker in the panel and /subagents; display only, the parent still owns both.";
