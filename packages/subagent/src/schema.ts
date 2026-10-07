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
    agentScope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")])) }),
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
  agent: Type.Optional(text), task: Type.Optional(text), label, cwd: Type.Optional(text), model: Type.Optional(text),
  effort: Type.Optional(effortSchema), lifetime: Type.Optional(Type.Union([Type.Literal("once"), Type.Literal("retained")])),
  agentScope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")])),
  workerId: Type.Optional(id), message: Type.Optional(text), questionId: Type.Optional(id), cancelled: Type.Optional(Type.Literal(true)),
  mode: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("steer"), Type.Literal("all"), Type.Literal("any")])),
  runIds: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
}, { additionalProperties: false });
export type Action = Static<typeof actionSchema>;
export type Start = Extract<Action, { action: "start" }>;
export function validateAction(value: unknown): asserts value is Action {
  if (!Check(actionSchema, value)) throw new Error("Invalid subagent action or arguments. Supported actions: start/message/wait/status/stop/reply/recover.");
  const action = value as Action;
  if (action.action === "message" && action.mode === "steer" && action.label !== undefined) throw new Error("Steering cannot relabel a run.");
}
export const description = "Start isolated Pi workers and fresh reviewers. start returns admission, not completion: wait on its runId. Default lifetime once retires automatically; retained workers accept new task messages only while idle. A working worker accepts steer, not another task. Cancelling wait leaves workers running. stop closes a worker without deleting edits. Profiles are instruction-based capabilities, not an OS sandbox. Tasks run within configured active/live limits; excess admitted work queues. Any owned pending question interrupts wait with attention, even for other selected runs. Answer with reply or explicitly cancel; cancellation interrupts the child. recover explicitly reopens a closed retained conversation in the original parent, idle without replay; follow it with a new task. Missing/changed prerequisites or uncertain ownership refuse recovery.";
