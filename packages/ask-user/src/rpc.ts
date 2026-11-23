import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { validate, type Params } from "./schema.ts";
import type { Result } from "./result.ts";

export const RPC_TITLE = "pi-ask-user:questionnaire:v1";
export const RPC_TIMEOUT_MS = 10 * 60 * 1000;
const protocol = "pi-ask-user";
const answerSchema = Type.Object({
  questionIndex: Type.Integer({ minimum: 1, maximum: 8 }),
  selected: Type.Array(Type.String(), { maxItems: 8, uniqueItems: true }),
  custom: Type.Optional(Type.String({ pattern: "\\S" })),
  notes: Type.Optional(Type.String()),
}, { additionalProperties: false });
const responseSchema = Type.Object({
  protocol: Type.Literal(protocol), version: Type.Literal(1),
  answers: Type.Array(answerSchema, { maxItems: 8 }),
  chat: Type.Optional(Type.Literal(true)),
  globalNote: Type.Optional(Type.String()),
}, { additionalProperties: false });

function keys(value: object, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Invalid questionnaire: unknown field.");
}

export function snapshot(params: unknown): Params {
  validate(params);
  keys(params, ["questions"]);
  for (const question of params.questions) {
    keys(question, ["question", "header", "options", "multiSelect"]);
    for (const option of question.options) keys(option, ["label", "description", "preview"]);
  }
  return structuredClone(params);
}

export function decodeResponse(text: string, params: Params): Result {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid questionnaire response: expected JSON."); }
  if (!Check(responseSchema, value)) throw new Error("Invalid questionnaire response envelope.");
  const seen = new Set<number>();
  const answers = value.answers.map(answer => {
    const question = params.questions[answer.questionIndex - 1];
    if (!question || seen.has(answer.questionIndex)) throw new Error("Invalid questionnaire response: unknown or duplicate question.");
    seen.add(answer.questionIndex);
    if (answer.selected.some(label => !question.options.some(option => option.label === label))) throw new Error("Invalid questionnaire response: unknown option.");
    const count = answer.selected.length + (answer.custom ? 1 : 0);
    if ((!question.multiSelect && count > 1) || (!value.chat && count === 0)) throw new Error("Invalid questionnaire response: invalid selection count.");
    return { ...answer, selected: question.options.filter(option => answer.selected.includes(option.label)).map(option => option.label) };
  }).sort((a, b) => a.questionIndex - b.questionIndex);
  if (!value.chat && seen.size !== params.questions.length) throw new Error("Invalid questionnaire response: answer every question.");
  return { cancelled: false, answers, ...(value.chat ? { chat: true } : {}), ...(value.globalNote !== undefined ? { globalNote: value.globalNote } : {}) };
}

export async function runRpcQuestionnaire(ctx: Pick<ExtensionContext, "mode" | "ui">, params: Params, signal?: AbortSignal, timeout = RPC_TIMEOUT_MS): Promise<Result> {
  if (ctx.mode !== "rpc") throw new Error("RPC questionnaires require RPC mode.");
  const questions = snapshot(params);
  signal?.throwIfAborted();
  const prefill = JSON.stringify({ protocol, version: 1, timeoutMs: timeout, questions: questions.questions });
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    const finish = (value: Result | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const abort = () => finish(new Error("Questionnaire aborted."));
    const timer = setTimeout(() => finish(new Error("Questionnaire timed out; no answers were submitted.")), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    // editor has no signal/timeout options. Settle locally and ignore any late reply.
    try {
      ctx.ui.editor(RPC_TITLE, prefill).then(text => {
        if (settled) return;
        try { finish(text === undefined ? { cancelled: true, answers: [] } : decodeResponse(text, questions)); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      }, error => finish(error instanceof Error ? error : new Error(String(error))));
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
