import type { QuestionnaireState } from "./state.ts";

export interface Answer {
  questionIndex: number;
  selected: string[];
  custom?: string;
  notes?: string;
}
export interface Result { cancelled: boolean; chat?: true; answers: Answer[]; globalNote?: string }

export function result(state: QuestionnaireState, cancelled = false, chat = false): Result {
  if (cancelled) return { cancelled: true, answers: [] };
  if (!chat && !state.complete()) throw new Error("Every question must be answered before submission.");
  return {
    cancelled: false,
    ...(chat ? { chat: true as const } : {}),
    ...(state.globalNote ? { globalNote: state.globalNote } : {}),
    answers: state.answers.flatMap((answer, index) => state.answered(index) ? [{
      questionIndex: index + 1,
      selected: state.questions[index].options.filter((_, i) => answer.selected.has(i)).map(option => option.label),
      ...(answer.notes ? { notes: answer.notes } : {}),
      ...(answer.customActive && answer.custom ? { custom: answer.custom } : {}),
    }] : []),
  };
}
