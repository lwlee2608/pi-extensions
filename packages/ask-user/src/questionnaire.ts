import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { result, type Result } from "./result.ts";
import { validate, type Params } from "./schema.ts";
import { QuestionnaireState } from "./state.ts";

export class Questionnaire implements Component, Focusable {
  readonly state: QuestionnaireState;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: (value: Result) => void;
  private readonly editor: Editor;
  private editing = false;
  private confirming = false;
  private discard = false;
  private hasFocus = false;
  private scroll = 0;

  constructor(params: Params, tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: Result) => void) {
    this.state = new QuestionnaireState(params.questions);
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.editor = new Editor(tui, {
      borderColor: text => theme.fg("accent", text),
      selectList: {
        selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text),
        description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("dim", text),
        noMatch: text => theme.fg("warning", text),
      },
    });
    this.editor.onChange = () => {
      if (this.editing) this.state.answers[this.state.tab].draft = this.editor.getExpandedText();
    };
    this.editor.onSubmit = text => {
      this.state.saveCustom(this.state.tab, text);
      this.editing = false;
      this.editor.focused = false;
      if (this.state.answered(this.state.tab)) this.state.advance();
      this.scroll = 0;
      this.tui.requestRender();
    };
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.editor.focused = value && this.editing; }
  invalidate(): void { this.editor.invalidate(); }

  handleInput(data: string): void {
    const cancel = this.keys.matches(data, "tui.select.cancel");
    const confirm = this.keys.matches(data, "tui.select.confirm");
    const up = this.keys.matches(data, "tui.select.up");
    const down = this.keys.matches(data, "tui.select.down");
    if (this.editing) {
      if (cancel) { this.editing = false; this.editor.focused = false; }
      else this.editor.handleInput(data);
    } else if (this.confirming) {
      if (cancel) this.confirming = false;
      else if (up || down || matchesKey(data, Key.tab)) this.discard = !this.discard;
      else if (confirm) {
        if (this.discard) this.done(result(this.state, true));
        else this.confirming = false;
      }
    } else if (cancel) {
      if (!this.state.hasWork()) this.done(result(this.state, true));
      else { this.confirming = true; this.discard = false; }
    } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      const delta = matchesKey(data, Key.tab) ? 1 : -1;
      this.state.tab = (this.state.tab + delta + this.state.questions.length + 1) % (this.state.questions.length + 1);
      this.scroll = 0;
    } else if (this.state.tab === this.state.questions.length) {
      if (confirm && this.state.complete()) this.done(result(this.state));
      else if (up || down) this.scroll = Math.max(0, this.scroll + (up ? -1 : 1));
    } else {
      const question = this.state.questions[this.state.tab];
      const answer = this.state.answers[this.state.tab];
      if (up || down) answer.cursor = Math.max(0, Math.min(question.options.length, answer.cursor + (up ? -1 : 1)));
      else if (matchesKey(data, Key.space) && question.multiSelect && answer.cursor < question.options.length) {
        this.state.select(this.state.tab, answer.cursor);
      } else if (confirm) {
        if (answer.cursor === question.options.length) {
          this.editor.setText(answer.draft);
          this.editing = true;
          this.editor.focused = this.focused;
        } else {
          if (!question.multiSelect) this.state.select(this.state.tab, answer.cursor);
          if (this.state.answered(this.state.tab)) { this.state.advance(); this.scroll = 0; }
        }
      }
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const height = Math.max(1, this.tui.terminal.rows - 2);
    const { state, theme } = this;
    const header = state.tab === state.questions.length ? "Review" : state.questions[state.tab].header || `Q${state.tab + 1}`;
    const title = theme.fg("accent", `${state.tab + 1}/${state.questions.length + 1} ${header} · Tab/Shift+Tab switch`);
    const body: string[] = [];
    const add = (text: string) => body.push(...wrapTextWithAnsi(text, width));
    let focusLine = 0;
    let hint = `${this.keys.getKeys("tui.select.up").join("/")}/${this.keys.getKeys("tui.select.down").join("/")} move · ${this.keys.getKeys("tui.select.confirm").join("/")} confirm · ${this.keys.getKeys("tui.select.cancel").join("/")} cancel`;
    if (this.confirming) {
      add("Discard all answers and drafts?");
      add(`${this.discard ? "  " : "> "}Keep editing`);
      focusLine = body.length;
      add(`${this.discard ? "> " : "  "}Discard answers`);
      if (!this.discard) focusLine = 1;
    } else if (this.editing) {
      add(state.questions[state.tab].question);
      const editorLines = this.editor.render(width);
      const cursor = editorLines.findIndex(line => line.includes(CURSOR_MARKER));
      focusLine = body.length + Math.max(0, cursor);
      body.push(...editorLines);
      hint = "Enter apply · Shift+Enter newline · Esc return";
    } else if (state.tab === state.questions.length) {
      state.questions.forEach((question, i) => {
        const answer = state.answers[i];
        const labels = question.options.filter((_, index) => answer.selected.has(index)).map(option => option.label);
        if (answer.customActive) labels.push(answer.custom);
        add(`${i + 1}. ${question.question}`);
        add(state.answered(i) ? labels.join("; ") : theme.fg("warning", "Unanswered"));
      });
      add(state.complete() ? "Ready to submit" : "Answer every question before submitting");
      hint = `↑/↓ scroll · ${hint}`;
    } else {
      const question = state.questions[state.tab];
      const answer = state.answers[state.tab];
      add(question.question);
      question.options.forEach((option, i) => {
        if (i === answer.cursor) focusLine = body.length;
        add(`${i === answer.cursor ? ">" : " "} [${answer.selected.has(i) ? "x" : " "}] ${option.label}`);
        if (option.description) add(theme.fg("muted", `  ${option.description}`));
      });
      if (answer.cursor === question.options.length) focusLine = body.length;
      add(`${answer.cursor === question.options.length ? ">" : " "} [${answer.customActive ? "x" : " "}] Type an answer…`);
      if (question.multiSelect) hint = `Space toggle · ${hint}`;
    }
    const room = Math.max(1, height - 2);
    if (this.confirming || this.editing || state.tab < state.questions.length) {
      if (focusLine < this.scroll) this.scroll = focusLine;
      if (focusLine >= this.scroll + room) this.scroll = focusLine - room + 1;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, body.length - room));
    const viewport = body.slice(this.scroll, this.scroll + room);
    const lines = height < 3 ? viewport : [title, ...viewport, theme.fg("dim", hint)];
    return lines.slice(0, height).map(line => truncateToWidth(line, width));
  }
}

export async function runQuestionnaire(ctx: ExtensionContext, params: Params, signal?: AbortSignal): Promise<Result> {
  if (ctx.mode !== "tui") throw new Error("Questionnaires require terminal mode.");
  validate(params);
  signal?.throwIfAborted();
  let abort: (() => void) | undefined;
  let mounted = false;
  let aborted = false;
  try {
    const outcome = await ctx.ui.custom<Result | Error>((tui, theme, keys, done) => {
      let settled = false;
      const finish = (value: Result | Error) => {
        if (settled) return;
        settled = true;
        done(value);
      };
      abort = () => {
        aborted = true;
        if (mounted) finish(new Error("Questionnaire aborted."));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      return new Questionnaire(params, tui, theme, keys, finish);
    }, {
      overlay: true,
      overlayOptions: { width: "95%", maxHeight: "100%", margin: 1 },
      onHandle: () => { mounted = true; if (aborted) abort?.(); },
    });
    if (outcome instanceof Error) throw outcome;
    if (!outcome) throw new Error("Questionnaire UI unavailable.");
    return outcome;
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
