import type { Question } from "./schema.ts";

export interface AnswerState {
  selected: Set<number>;
  customActive: boolean;
  custom: string;
  draft: string;
  cursor: number;
  notes: string;
  noteDraft: string;
}

export class QuestionnaireState {
  readonly questions: Question[];
  readonly answers: AnswerState[];
  tab = 0;
  globalNote = "";
  globalNoteDraft = "";

  constructor(questions: Question[]) {
    this.questions = questions;
    this.answers = questions.map(() => ({ selected: new Set(), customActive: false, custom: "", draft: "", cursor: 0, notes: "", noteDraft: "" }));
  }

  select(index: number, option: number): void {
    const answer = this.answers[index];
    if (this.questions[index].multiSelect) {
      if (answer.selected.has(option)) answer.selected.delete(option);
      else answer.selected.add(option);
    } else {
      answer.selected = new Set([option]);
      answer.customActive = false;
    }
  }

  saveCustom(index: number, text: string): void {
    const answer = this.answers[index];
    answer.draft = text;
    answer.custom = text.trim();
    answer.customActive = answer.custom.length > 0;
    if (!this.questions[index].multiSelect && answer.customActive) answer.selected.clear();
  }

  answered(index: number): boolean {
    const answer = this.answers[index];
    return answer.selected.size > 0 || (answer.customActive && answer.custom.length > 0);
  }

  complete(): boolean { return this.questions.every((_, index) => this.answered(index)); }
  hasWork(): boolean {
    return this.globalNote.length > 0 || this.globalNoteDraft.length > 0 || this.answers.some(answer =>
      answer.selected.size > 0 || answer.custom.length > 0 || answer.draft.length > 0 || answer.notes.length > 0 || answer.noteDraft.length > 0);
  }
  saveNote(index: number, text: string): void {
    if (index === this.questions.length) { this.globalNote = text.trim(); this.globalNoteDraft = text; }
    else { this.answers[index].notes = text.trim(); this.answers[index].noteDraft = text; }
  }
  advance(): void { this.tab = Math.min(this.questions.length, this.tab + 1); }
}
