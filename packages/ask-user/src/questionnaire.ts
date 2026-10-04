import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, Input, Key, matchesKey, parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { display, editorDisplay } from "./display.ts";
import { result, type Result } from "./result.ts";
import { validate, type Params } from "./schema.ts";
import { QuestionnaireState } from "./state.ts";
import { actionKeys, actionMatches } from "./keys.ts";
import { Preview, columns } from "./preview.ts";

const RESERVED_ROWS = 4;
const PREVIEW_ROWS = 12;
const TYPE_AHEAD_MS = 400;
const keyNames: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→", escape: "Esc", enter: "Enter", tab: "Tab", space: "Space", pageUp: "PgUp", pageDown: "PgDn" };
const keyLabel = (keys: string[]) => keys[0]?.split("+").map(part => keyNames[part] ?? (part.length > 1 ? part[0].toUpperCase() + part.slice(1) : part)).join("+");
const fit = (text: string, width: number) => visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…").replaceAll("\x1b[0m", "");

export class Questionnaire implements Component, Focusable {
  readonly state: QuestionnaireState;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: (value: Result) => void;
  private editor: Editor;
  private editing = false;
  private field?: { tab: number; input: Input };
  private readonly preview = new Preview();
  private confirming = false;
  private discard = false;
  private reviewCursor = 0;
  private hasFocus = false;
  private scroll = 0;
  private followFocus = false;
  private readonly now: () => number;
  private quietUntil: number;

  constructor(params: Params, tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: Result) => void, now = Date.now) {
    this.state = new QuestionnaireState(params.questions);
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.now = now;
    this.quietUntil = now() + TYPE_AHEAD_MS;
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
      if (this.reviewing) this.state.globalNoteDraft = text;
      else this.state.answers[this.state.tab].noteDraft = text;
    };
    editor.onSubmit = text => {
      this.editing = false;
      this.editor.focused = false;
      this.resetScroll();
      this.state.saveNote(this.state.tab, text);
      this.tui.requestRender();
    };
    return editor;
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.editor.focused = value && this.editing; }
  invalidate(): void { this.editor.invalidate(); this.preview.invalidate(); }

  private get single(): boolean { return this.state.questions.length === 1; }
  private get reviewing(): boolean { return this.state.tab === this.state.questions.length; }
  private get typing(): boolean {
    const question = this.state.questions[this.state.tab];
    return !!question && !this.editing && !this.confirming && this.state.answers[this.state.tab].cursor === question.options.length;
  }

  private resetScroll(): void { this.scroll = 0; this.followFocus = false; }

  private confirmAnswer(): void {
    if (!this.state.answered(this.state.tab)) return;
    if (this.single) this.done(result(this.state));
    else { this.state.advance(); this.resetScroll(); }
  }

  private requestCancel(): void {
    if (!this.state.hasWork()) this.done(result(this.state, true));
    else { this.confirming = true; this.discard = false; }
  }

  private openNote(): void {
    this.editor = this.createEditor();
    this.editor.setText(this.state.answers[this.state.tab]?.noteDraft ?? this.state.globalNoteDraft);
    this.editing = true;
    this.editor.focused = this.focused;
  }

  private customInput(): Input {
    if (this.field?.tab === this.state.tab) return this.field.input;
    const input = new Input({ prompt: "", placeholder: "Type something.", placeholderStyle: text => this.theme.fg("muted", text) });
    input.setValue(this.state.answers[this.state.tab].draft);
    this.field = { tab: this.state.tab, input };
    return input;
  }

  private type(data: string): void {
    const input = this.customInput();
    input.handleInput(data);
    const answer = this.state.answers[this.state.tab];
    if (this.state.questions[this.state.tab].multiSelect || answer.customActive) this.state.saveCustom(this.state.tab, input.getValue());
    else answer.draft = input.getValue();
  }

  private submitCustom(): void {
    const answer = this.state.answers[this.state.tab];
    if (this.state.questions[this.state.tab].multiSelect) { answer.cursor++; this.followFocus = true; return; }
    if (!answer.draft.trim()) return;
    this.state.saveCustom(this.state.tab, answer.draft);
    this.confirmAnswer();
  }

  private previewText(): string {
    const question = this.state.questions[this.state.tab];
    return question?.options[this.state.answers[this.state.tab]?.cursor]?.preview ?? "";
  }

  // Pi focuses the questionnaire mid-keystroke, so text typed for the main editor must not answer it.
  // Answering keys wait until input pauses once; Esc and navigation work immediately.
  private typedAhead(data: string, digit: number): boolean {
    const time = this.now();
    if (time >= this.quietUntil) return false;
    this.quietUntil = time + TYPE_AHEAD_MS;
    return this.keys.matches(data, "tui.select.confirm") || digit >= 0 || matchesKey(data, Key.space) || actionMatches(this.keys, "pi-ask-user.note", data);
  }

  handleInput(data: string): void {
    const key = parseKey(data);
    const digit = key && /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
    if (this.typedAhead(data, digit)) return;
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
    const arrows = !this.typing;
    const next = matchesKey(data, Key.tab) || (arrows && matchesKey(data, Key.right));
    const previous = matchesKey(data, Key.shift("tab")) || (arrows && matchesKey(data, Key.left));
    if (this.editing) {
      if (cancel) { this.editing = false; this.editor.focused = false; }
      else this.editor.handleInput(data);
    } else if (this.confirming) {
      if (cancel) this.confirming = false;
      else if (up || down || next || previous) this.discard = !this.discard;
      else if (confirm || digit === 0 || digit === 1) {
        if (digit >= 0) this.discard = digit === 1;
        if (this.discard) this.done(result(this.state, true));
        else this.confirming = false;
      }
    } else if (cancel) {
      this.requestCancel();
    } else if (!this.single && (next || previous)) {
      const count = this.state.questions.length + 1;
      this.state.tab = (this.state.tab + (next ? 1 : -1) + count) % count;
      this.resetScroll();
    } else if (this.typing && !up && !down) {
      if (confirm) this.submitCustom();
      else this.type(data);
    } else if (actionMatches(this.keys, "pi-ask-user.note", data)) {
      this.openNote();
    } else if (this.previewText() && (actionMatches(this.keys, "pi-ask-user.previewUp", data) || actionMatches(this.keys, "pi-ask-user.previewDown", data))) {
      this.preview.setText(this.previewText());
      this.preview.scroll(actionMatches(this.keys, "pi-ask-user.previewUp", data) ? -1 : 1);
    } else if (this.reviewing) {
      if (up || down) { this.reviewCursor = up ? 0 : 1; this.followFocus = true; }
      else if (confirm || digit === 0 || digit === 1) {
        if (digit >= 0) this.reviewCursor = digit;
        if (this.reviewCursor === 1) this.requestCancel();
        else if (this.state.complete()) this.done(result(this.state));
        else { this.state.tab = this.state.answers.findIndex((_, i) => !this.state.answered(i)); this.resetScroll(); }
      }
    } else {
      const question = this.state.questions[this.state.tab];
      const answer = this.state.answers[this.state.tab];
      const lastRow = question.options.length + (question.multiSelect ? 1 : 0);
      if (up || down) {
        answer.cursor = Math.max(0, Math.min(lastRow, answer.cursor + (up ? -1 : 1)));
        this.followFocus = true;
      } else if (digit >= 0 && digit <= question.options.length) {
        answer.cursor = digit;
        this.followFocus = true;
        if (digit < question.options.length) this.state.select(this.state.tab, digit);
        if (digit < question.options.length && !question.multiSelect) this.confirmAnswer();
      } else if (question.multiSelect && answer.cursor < question.options.length && (confirm || matchesKey(data, Key.space))) {
        this.state.select(this.state.tab, answer.cursor);
      } else if (confirm) {
        if (!question.multiSelect) this.state.select(this.state.tab, answer.cursor);
        this.confirmAnswer();
      }
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const { state, theme } = this;
    const height = Math.max(1, this.tui.terminal.rows - RESERVED_ROWS);
    const previewText = !this.editing && !this.confirming ? this.previewText() : "";
    const wide = !!previewText && width >= 100 && height >= 8;
    const hasPreview = wide || (!!previewText && height >= 20);
    const bodyWidth = wide ? Math.floor((width - 3) / 2) : width;
    const body: string[] = [];
    const add = (text: string, prefix = "", indent = visibleWidth(prefix)) => {
      wrapTextWithAnsi(text, Math.max(1, bodyWidth - indent)).forEach((part, i) => body.push((i ? " ".repeat(indent) : prefix) + part));
    };
    let focusLine = 0;
    const choice = (index: number, text: string, focused: boolean) => {
      if (focused) focusLine = body.length;
      const prefix = `${focused ? "❯ " : "  "}${index + 1}. `;
      add(focused ? theme.fg("accent", text) : text, focused ? theme.fg("accent", prefix) : prefix);
    };
    const hints: string[] = [];
    const hint = (keys: string | undefined, action: string) => { if (keys) hints.push(`${keys} ${action}`); };
    const navigate = `${keyLabel(this.keys.getKeys("tui.select.up"))}/${keyLabel(this.keys.getKeys("tui.select.down"))}`;
    const switchHint = (arrows = true) => { if (!this.single) hint(arrows ? "Tab/←→" : "Tab", "switch"); };
    const noteHint = () => hint(keyLabel(actionKeys(this.keys, "pi-ask-user.note")), "note");
    const confirmKey = keyLabel(this.keys.getKeys("tui.select.confirm"));
    const cancelKey = keyLabel(this.keys.getKeys("tui.select.cancel"));
    let cancelHint = `${cancelKey} cancel`;

    if (this.confirming) {
      add(theme.bold("Discard all answers and drafts?"));
      body.push("");
      ["Keep editing", "Discard answers"].forEach((label, i) => choice(i, label, this.discard === (i === 1)));
      hint(confirmKey, "select");
      hint(navigate, "navigate");
      cancelHint = `${cancelKey} keep editing`;
    } else if (this.editing) {
      add(theme.bold(this.reviewing ? "Global note" : "Question note"));
      body.push("");
      // Preserve SGR styling and cursor positioning, but remove executable terminal controls.
      const editorLines = this.editor.render(width).map(editorDisplay);
      const cursor = editorLines.findIndex(line => line.includes(CURSOR_MARKER));
      focusLine = body.length + Math.max(0, cursor);
      body.push(...editorLines);
      hints.push("Enter apply", "Shift+Enter newline");
      cancelHint = `${cancelKey} back`;
    } else if (this.reviewing) {
      add(theme.bold("Review your answers"));
      body.push("");
      state.questions.forEach((question, i) => {
        const answer = state.answers[i];
        const labels = question.options.filter((_, index) => answer.selected.has(index)).map(option => option.label);
        if (answer.customActive) labels.push(answer.custom);
        add(display(question.question), "● ");
        add(state.answered(i) ? display(labels.join("; ")) : theme.fg("warning", "Unanswered"), "  → ");
        if (answer.notes) add(theme.fg("muted", `Note: ${display(answer.notes)}`), "    ");
      });
      if (state.globalNote) { body.push(""); add(`Global note: ${display(state.globalNote)}`); }
      body.push("");
      add(state.complete() ? "Ready to submit your answers?" : theme.fg("warning", "Answer every question before submitting."));
      body.push("");
      ["Submit answers", "Cancel"].forEach((label, i) => choice(i, label, this.reviewCursor === i));
      hint(confirmKey, "select");
      hint(navigate, "navigate");
      switchHint();
      noteHint();
    } else {
      const question = state.questions[state.tab];
      const answer = state.answers[state.tab];
      add(theme.bold(display(question.question)));
      body.push("");
      const rows = [
        ...question.options.map((option, i) => ({ label: display(option.label), description: option.description, checked: answer.selected.has(i) })),
        { label: answer.draft ? display(answer.draft) : "Type something.", description: undefined, checked: answer.customActive },
      ];
      const typing = this.typing;
      rows.forEach((row, i) => {
        const box = question.multiSelect ? `[${row.checked ? "✔" : " "}] ` : "";
        const mark = !question.multiSelect && row.checked ? theme.fg("success", " ✔") : "";
        if (typing && i === answer.cursor) {
          const input = this.customInput();
          input.focused = this.hasFocus;
          const used = 2 + `${i + 1}. `.length + box.length + visibleWidth(mark);
          row.label = editorDisplay(input.render(Math.max(1, bodyWidth - used))[0].trimEnd());
        }
        choice(i, box + row.label + mark, i === answer.cursor);
        if (row.description) add(theme.fg("muted", display(row.description)), " ".repeat(2 + `${i + 1}. `.length + box.length));
      });
      const onSubmit = question.multiSelect && answer.cursor === rows.length;
      if (question.multiSelect) {
        if (onSubmit) focusLine = body.length;
        const label = theme.bold(this.single ? "Submit" : "Next");
        const indent = " ".repeat(`${rows.length + 1}. `.length);
        add(onSubmit ? theme.fg("accent", label) : state.answered(state.tab) ? label : theme.fg("muted", label), (onSubmit ? `${theme.fg("accent", "❯")} ` : "  ") + indent);
      }
      if (answer.notes) { body.push(""); add(theme.fg("muted", `Note: ${display(answer.notes)}`)); }
      if (!question.multiSelect) hint(confirmKey, "select");
      else if (typing) hint(confirmKey, "done");
      else if (onSubmit) hint(confirmKey, this.single ? "submit" : "next");
      else hint(`Space/${confirmKey}`, "toggle");
      hint(navigate, "navigate");
      switchHint(!typing);
      if (!typing) noteHint();
      if (hasPreview) hint(`${keyLabel(actionKeys(this.keys, "pi-ask-user.previewUp"))}/${keyLabel(actionKeys(this.keys, "pi-ask-user.previewDown"))}`, "preview");
    }

    const top = [theme.fg("border", "─".repeat(width))];
    if (!this.single) top.push(this.tabs(width), "");
    const footer = (extra: string[]) => wrapTextWithAnsi(theme.fg("dim", [...hints, ...extra, cancelHint].join(" · ")), width);
    let bottom = footer([]);
    let available = height - top.length - 1 - bottom.length;
    if (body.length > available && available >= 1) {
      bottom = footer(["Ctrl+↑/↓ scroll"]);
      available = height - top.length - 1 - bottom.length;
    }
    const chrome = available >= 1;
    if (!chrome) available = height;
    const room = hasPreview && !wide ? Math.min(body.length, Math.max(2, Math.floor(available / 2))) : Math.min(body.length, available);
    if (this.confirming || this.editing || this.followFocus) {
      if (focusLine < this.scroll) this.scroll = focusLine;
      if (focusLine >= this.scroll + room) this.scroll = focusLine - room + 1;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, body.length - room));
    let viewport = body.slice(this.scroll, this.scroll + room);
    if (hasPreview) {
      this.preview.setText(previewText);
      const rows = wide ? Math.min(available, Math.max(room, PREVIEW_ROWS)) : Math.min(PREVIEW_ROWS, available - room - 1);
      const right = this.preview.render(wide ? width - bodyWidth - 3 : width, rows);
      viewport = wide ? columns(viewport, right, bodyWidth, width) : [...viewport, ...right.length ? ["", ...right] : []];
    }
    const lines = chrome ? [...top, ...viewport, "", ...bottom] : viewport;
    return lines.slice(0, height).map(line => truncateToWidth(line, width));
  }

  private tabs(width: number): string {
    const { state, theme } = this;
    const box = (i: number) => state.answered(i) ? "☒" : "☐";
    const full = [...state.questions.map((question, i) => `${box(i)} ${display(question.header || `Q${i + 1}`).replace(/\s+/g, " ")}`), "✔ Submit"];
    const short = [...state.questions.map((_, i) => `${box(i)} ${i + 1}`), "✔"];
    const fits = full.reduce((sum, label) => sum + visibleWidth(label) + 3, 6) <= width;
    const others = short.reduce((sum, label, i) => sum + (i === state.tab ? 0 : visibleWidth(label)) + 3, 6);
    const labels = fits ? full : short.map((label, i) => i === state.tab ? fit(full[i], Math.max(visibleWidth(label), width - others)) : label);
    const cells = labels.map((label, i) => {
      if (i === state.tab) return theme.bg("selectedBg", theme.fg("text", ` ${label} `));
      return theme.fg(i < state.questions.length ? (state.answered(i) ? "text" : "muted") : (state.complete() ? "success" : "muted"), ` ${label} `);
    });
    return `${theme.fg("dim", "←")}  ${cells.join(" ")}  ${theme.fg("dim", "→")}`;
  }
}

export async function runQuestionnaire(ctx: ExtensionContext, params: Params, signal?: AbortSignal): Promise<Result> {
  if (ctx.mode !== "tui") throw new Error("Questionnaires require terminal mode.");
  validate(params);
  signal?.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    const outcome = await ctx.ui.custom<Result | Error>((tui, theme, keys, done) => {
      if ((tui as TUI & { readonly hasOverlayEntries: boolean }).hasOverlayEntries) throw new Error("Close the existing dialog before opening a questionnaire.");
      let settled = false;
      const finish = (value: Result | Error) => {
        if (settled) return;
        settled = true;
        done(value);
      };
      abort = () => finish(new Error("Questionnaire aborted."));
      signal?.addEventListener("abort", abort, { once: true });
      return new Questionnaire(params, tui, theme, keys, finish);
    });
    if (outcome instanceof Error) throw outcome;
    if (!outcome) throw new Error("Questionnaire UI unavailable.");
    return outcome;
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
