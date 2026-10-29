import type { QuestionnaireState } from "./state.ts";

export interface Answer {
  questionIndex: number;
  selected: string[];
  custom?: string;
  notes?: string;
  explanation?: string;
  explanationUsage?: ExplainUsage;
}
export interface ExplainUsage { input: number; cacheRead: number; cacheWrite: number; output: number; cost: number }
export interface Result { cancelled: boolean; chat?: true; answers: Answer[]; globalNote?: string }

export function result(state: QuestionnaireState, cancelled = false, chat = false): Result {
  if (cancelled) return { cancelled: true, answers: [] };
  if (!chat && !state.complete()) throw new Error("Every question must be answered before submission.");
  return {
    cancelled: false,
    ...(chat ? { chat: true as const } : {}),
    ...(state.globalNote ? { globalNote: state.globalNote } : {}),
    answers: state.answers.flatMap((answer, index) => state.answered(index) || answer.notes || answer.explanation ? [{
      questionIndex: index + 1,
      selected: state.questions[index].options.filter((_, i) => answer.selected.has(i)).map(option => option.label),
      ...(answer.notes ? { notes: answer.notes } : {}),
      ...(answer.customActive && answer.custom ? { custom: answer.custom } : {}),
      ...(answer.explanation ? { explanation: answer.explanation } : {}),
      ...(answer.explanationUsage ? { explanationUsage: answer.explanationUsage } : {}),
    }] : []),
  };
}

export function modelText(value: Result): string {
  return JSON.stringify({ ...value, answers: value.answers.map(({ explanationUsage: _, ...answer }) => answer) });
}

const tokens = (count: number) => count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
export function usageLabel(usage: ExplainUsage): string {
  return [
    `in ${tokens(usage.input)}`, `cached ${tokens(usage.cacheRead)}`,
    ...(usage.cacheWrite ? [`write ${tokens(usage.cacheWrite)}`] : []),
    `out ${tokens(usage.output)}`,
    ...(usage.cost ? [`$${usage.cost.toFixed(4)}`] : []),
  ].join(" · ");
}
