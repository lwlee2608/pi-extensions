import type { QuestionnaireState } from "./state.ts";

export interface Answer {
  questionIndex: number;
  selected: string[];
  custom?: string;
  notes?: string;
}
export interface Result { cancelled: boolean; answers: Answer[]; globalNote?: string }

export function result(state: QuestionnaireState, cancelled = false): Result {
  if (cancelled) return { cancelled: true, answers: [] };
  if (!state.complete()) throw new Error("Every question must be answered before submission.");
  return {
    cancelled: false,
    ...(state.globalNote ? { globalNote: state.globalNote } : {}),
    answers: state.answers.map((answer, index) => ({
      questionIndex: index + 1,
      selected: state.questions[index].options.filter((_, i) => answer.selected.has(i)).map(option => option.label),
      ...(answer.notes ? { notes: answer.notes } : {}),
      ...(answer.customActive && answer.custom ? { custom: answer.custom } : {}),
    })),
  };
}
