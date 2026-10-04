import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { display, editorDisplay } from "./display.ts";
import { result, type Result } from "./result.ts";
import { validate, type Params } from "./schema.ts";
import { QuestionnaireState } from "./state.ts";
import { actionKeys, actionMatches } from "./keys.ts";
import { Preview, columns } from "./preview.ts";

export class Questionnaire implements Component, Focusable {
  readonly state: QuestionnaireState;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: (value: Result) => void;
  private editor: Editor;
  private editing: "custom" | "note" | undefined;
  private readonly preview = new Preview();
  private confirming = false;
  private discard = false;
  private hasFocus = false;
  private scroll = 0;
  private followFocus = false;

  constructor(params: Params, tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: Result) => void) {
    this.state = new QuestionnaireState(params.questions);
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.editor = this.createEditor();
  }

  private createEditor(): Editor {
    const { tui, theme } = this;
    const editor = new Editor(tui, {
      borderColor: text => theme.fg("accent", text),
      selectList: {
        selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text),
        description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("dim", text),
        noMatch: text => theme.fg("warning", text),
      },
    });
    editor.onChange = () => {
      const text = this.editor.getExpandedText();
      if (this.editing === "custom") this.state.answers[this.state.tab].draft = text;
      else if (this.editing === "note") {
        if (this.state.tab === this.state.questions.length) this.state.globalNoteDraft = text;
        else this.state.answers[this.state.tab].noteDraft = text;
      }
    };
    editor.onSubmit = text => {
      if (this.editing === "note") this.state.saveNote(this.state.tab, text);
      else {
        this.state.saveCustom(this.state.tab, text);
        if (this.state.answered(this.state.tab)) this.state.advance();
      }
      this.editing = undefined;
      this.editor.focused = false;
      this.scroll = 0;
      this.followFocus = false;
      this.tui.requestRender();
    };
    return editor;
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.editor.focused = value && !!this.editing; }
  invalidate(): void { this.editor.invalidate(); this.preview.invalidate(); }

  private openEditor(kind: "custom" | "note"): void {
    const answer = this.state.answers[this.state.tab];
    this.editor = this.createEditor();
    this.editor.setText(kind === "custom" ? answer.draft : answer ? answer.noteDraft : this.state.globalNoteDraft);
    this.editing = kind;
    this.editor.focused = this.focused;
  }

  private previewText(): string {
    const question = this.state.questions[this.state.tab];
    return question?.options[this.state.answers[this.state.tab]?.cursor]?.preview ?? "";
  }

  handleInput(data: string): void {
    if (!this.editing && !this.confirming && (matchesKey(data, Key.ctrl("up")) || matchesKey(data, Key.ctrl("down")))) {
      this.scroll = Math.max(0, this.scroll + (matchesKey(data, Key.ctrl("up")) ? -1 : 1));
      this.followFocus = false;
      this.tui.requestRender();
      return;
    }
    const cancel = this.keys.matches(data, "tui.select.cancel");
    const confirm = this.keys.matches(data, "tui.select.confirm");
    const up = this.keys.matches(data, "tui.select.up");
    const down = this.keys.matches(data, "tui.select.down");
    if (this.editing) {
      if (cancel) { this.editing = undefined; this.editor.focused = false; }
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
      this.followFocus = false;
    } else if (actionMatches(this.keys, "pi-ask-user.note", data)) {
      this.openEditor("note");
    } else if (this.previewText() && (actionMatches(this.keys, "pi-ask-user.previewUp", data) || actionMatches(this.keys, "pi-ask-user.previewDown", data))) {
      this.preview.setText(this.previewText());
      this.preview.scroll(actionMatches(this.keys, "pi-ask-user.previewUp", data) ? -1 : 1);
    } else if (this.state.tab === this.state.questions.length) {
      if (confirm && this.state.complete()) this.done(result(this.state));
      else if (up || down) this.scroll = Math.max(0, this.scroll + (up ? -1 : 1));
    } else {
      const question = this.state.questions[this.state.tab];
      const answer = this.state.answers[this.state.tab];
      if (up || down) {
        answer.cursor = Math.max(0, Math.min(question.options.length, answer.cursor + (up ? -1 : 1)));
        this.followFocus = true;
      }
      else if (matchesKey(data, Key.space) && question.multiSelect && answer.cursor < question.options.length) {
        this.state.select(this.state.tab, answer.cursor);
      } else if (confirm) {
        if (answer.cursor === question.options.length) {
          this.openEditor("custom");
        } else {
          if (!question.multiSelect) this.state.select(this.state.tab, answer.cursor);
          if (this.state.answered(this.state.tab)) { this.state.advance(); this.scroll = 0; this.followFocus = false; }
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
    const title = theme.fg("accent", `${state.tab + 1}/${state.questions.length + 1} ${display(header).replace(/[\n\t]/g, " ")} · Tab/Shift+Tab switch`);
    const previewText = !this.editing && !this.confirming ? this.previewText() : "";
    const hasPreview = !!previewText && height >= 8;
    const wide = hasPreview && width >= 100;
    const bodyWidth = wide ? Math.floor((width - 3) / 2) : width;
    const body: string[] = [];
    const add = (text: string) => body.push(...wrapTextWithAnsi(text, bodyWidth));
    let focusLine = 0;
    let hint = `Ctrl+↑/↓ scroll text · ${this.keys.getKeys("tui.select.up").join("/")}/${this.keys.getKeys("tui.select.down").join("/")} move · ${this.keys.getKeys("tui.select.confirm").join("/")} confirm · ${this.keys.getKeys("tui.select.cancel").join("/")} cancel`;
    const noteKeys = actionKeys(this.keys, "pi-ask-user.note");
    if (noteKeys.length) hint = `${noteKeys.join("/")} note · ${hint}`;
    if (hasPreview) hint = `${actionKeys(this.keys, "pi-ask-user.previewUp").join("/")}/${actionKeys(this.keys, "pi-ask-user.previewDown").join("/")} preview · ${hint}`;
    if (this.confirming) {
      add("Discard all answers and drafts?");
      add(`${this.discard ? "  " : "> "}Keep editing`);
      focusLine = body.length;
      add(`${this.discard ? "> " : "  "}Discard answers`);
      if (!this.discard) focusLine = 1;
    } else if (this.editing) {
      add(this.editing === "note" ? (state.tab === state.questions.length ? "Global note" : "Question note") : display(state.questions[state.tab].question));
      // Preserve SGR styling and cursor positioning, but remove executable terminal controls.
      const editorLines = this.editor.render(width).map(editorDisplay);
      const cursor = editorLines.findIndex(line => line.includes(CURSOR_MARKER));
      focusLine = body.length + Math.max(0, cursor);
      body.push(...editorLines);
      hint = "Enter apply · Shift+Enter newline · Esc return";
    } else if (state.tab === state.questions.length) {
      state.questions.forEach((question, i) => {
        const answer = state.answers[i];
        const labels = question.options.filter((_, index) => answer.selected.has(index)).map(option => option.label);
        if (answer.customActive) labels.push(answer.custom);
        add(`${i + 1}. ${display(question.question)}`);
        add(state.answered(i) ? display(labels.join("; ")) : theme.fg("warning", "Unanswered"));
        if (answer.notes) add(`Note: ${display(answer.notes)}`);
      });
      if (state.globalNote) add(`Global note: ${display(state.globalNote)}`);
      add(state.complete() ? "Ready to submit" : "Answer every question before submitting");
      hint = `↑/↓ scroll · ${hint}`;
    } else {
      const question = state.questions[state.tab];
      const answer = state.answers[state.tab];
      add(display(question.question));
      question.options.forEach((option, i) => {
        if (i === answer.cursor) focusLine = body.length;
        add(`${i === answer.cursor ? ">" : " "} [${answer.selected.has(i) ? "x" : " "}] ${display(option.label)}`);
        if (option.description) add(theme.fg("muted", `  ${display(option.description)}`));
      });
      if (answer.cursor === question.options.length) focusLine = body.length;
      add(`${answer.cursor === question.options.length ? ">" : " "} [${answer.customActive ? "x" : " "}] Type an answer…`);
      if (answer.notes) add(`Note: ${display(answer.notes)}`);
      if (question.multiSelect) hint = `Space toggle · ${hint}`;
    }
    const available = Math.max(1, height - 2);
    const room = hasPreview && !wide ? Math.max(2, Math.floor(available / 2)) : available;
    if (this.confirming || this.editing || (this.followFocus && state.tab < state.questions.length)) {
      if (focusLine < this.scroll) this.scroll = focusLine;
      if (focusLine >= this.scroll + room) this.scroll = focusLine - room + 1;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, body.length - room));
    let viewport = body.slice(this.scroll, this.scroll + room);
    if (hasPreview) {
      this.preview.setText(previewText);
      const right = this.preview.render(wide ? width - bodyWidth - 3 : width, wide ? available : available - room);
      viewport = wide ? columns(viewport, right, bodyWidth, width) : [...viewport, ...right];
    }
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
