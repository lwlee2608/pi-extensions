import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const parameters = Type.Object({
  questions: Type.Array(Type.Object({
    question: Type.String({ pattern: "\\S" }),
    header: Type.Optional(Type.String()),
    options: Type.Array(Type.Object({
      label: Type.String({ pattern: "\\S" }),
      description: Type.Optional(Type.String()),
      preview: Type.Optional(Type.String()),
    }), { minItems: 2, maxItems: 8 }),
    multiSelect: Type.Optional(Type.Boolean({ default: false, description: "true shows checkboxes so the user can pick several options; use for \"select all that apply\" or choices that are not mutually exclusive. false picks exactly one." })),
  }), { minItems: 1, maxItems: 8 }),
});

export type Params = Static<typeof parameters>;
export type Question = Params["questions"][number];
export const description = "Ask for blocking user decisions. Batch related questions; put recommended choices first. Custom answers are always available, including alongside multi-select choices. On cancellation, do not repeat the questions or assume answers; explain any blocking decision and wait.";

export function validate(params: unknown): asserts params is Params {
  if (!Check(parameters, params)) throw new Error("Invalid questionnaire: expected 1–8 questions with 2–8 nonblank options each.");
  for (const question of params.questions) {
    const labels = question.options.map(option => option.label.trim());
    if (new Set(labels).size !== labels.length) throw new Error("Duplicate option labels within a question.");
  }
}
