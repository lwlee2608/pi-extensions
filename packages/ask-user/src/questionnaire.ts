import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
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
  private editing: "custom" | "note" | undefined;
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
      if (this.editing === "custom") this.state.answers[this.state.tab].draft = text;
      else if (this.editing === "note") {
        if (this.reviewing) this.state.globalNoteDraft = text;
        else this.state.answers[this.state.tab].noteDraft = text;
      }
    };
    editor.onSubmit = text => {
      const kind = this.editing;
      this.editing = undefined;
      this.editor.focused = false;
      this.resetScroll();
      if (kind === "note") this.state.saveNote(this.state.tab, text);
      else {
        this.state.saveCustom(this.state.tab, text);
        this.confirmAnswer();
      }
      this.tui.requestRender();
    };
    return editor;
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.editor.focused = value && !!this.editing; }
  invalidate(): void { this.editor.invalidate(); this.preview.invalidate(); }

  private get single(): boolean { return this.state.questions.length === 1; }
  private get reviewing(): boolean { return this.state.tab === this.state.questions.length; }

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

  // Pi focuses the questionnaire mid-keystroke, so text typed for the main editor must not answer it.
  // Answering keys wait until input pauses once; Esc and navigation work immediately.
  private typedAhead(data: string): boolean {
    const time = this.now();
    if (time >= this.quietUntil) return false;
    this.quietUntil = time + TYPE_AHEAD_MS;
    return this.keys.matches(data, "tui.select.confirm") || /^[1-9]$/.test(data) || matchesKey(data, Key.space) || actionMatches(this.keys, "pi-ask-user.note", data);
  }

  handleInput(data: string): void {
    if (this.typedAhead(data)) return;
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
    const digit = /^[1-9]$/.test(data) ? Number(data) - 1 : -1;
    const next = matchesKey(data, Key.tab) || matchesKey(data, Key.right);
    const previous = matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left);
    if (this.editing) {
      if (cancel) { this.editing = undefined; this.editor.focused = false; }
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
    } else if (actionMatches(this.keys, "pi-ask-user.note", data)) {
      this.openEditor("note");
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
      if (up || down) {
        answer.cursor = Math.max(0, Math.min(question.options.length, answer.cursor + (up ? -1 : 1)));
        this.followFocus = true;
      } else if (matchesKey(data, Key.space) && question.multiSelect && answer.cursor < question.options.length) {
        this.state.select(this.state.tab, answer.cursor);
      } else if (confirm || (digit >= 0 && digit <= question.options.length)) {
        if (digit >= 0) { answer.cursor = digit; this.followFocus = true; }
        if (answer.cursor === question.options.length) this.openEditor("custom");
        else if (question.multiSelect && digit >= 0) this.state.select(this.state.tab, answer.cursor);
        else {
          if (!question.multiSelect) this.state.select(this.state.tab, answer.cursor);
          this.confirmAnswer();
        }
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
      const number = `${index + 1}. `;
      add(focused ? theme.fg("accent", number + text) : number + text, focused ? `${theme.fg("accent", "❯")} ` : "  ", 2 + number.length);
    };
    const hints: string[] = [];
    const hint = (keys: string | undefined, action: string) => { if (keys) hints.push(`${keys} ${action}`); };
    const navigate = `${keyLabel(this.keys.getKeys("tui.select.up"))}/${keyLabel(this.keys.getKeys("tui.select.down"))}`;
    const switchHint = () => { if (!this.single) hint("Tab/←→", "switch"); };
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
      add(theme.bold(this.editing === "note" ? (this.reviewing ? "Global note" : "Question note") : display(state.questions[state.tab].question)));
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
        { label: answer.custom ? display(answer.custom) : "Type something.", description: undefined, checked: answer.customActive },
      ];
      rows.forEach((row, i) => {
        const box = question.multiSelect ? `[${row.checked ? "✔" : " "}] ` : "";
        const mark = !question.multiSelect && row.checked ? theme.fg("success", " ✔") : "";
        choice(i, box + row.label + mark, i === answer.cursor);
        if (row.description) add(theme.fg("muted", display(row.description)), " ".repeat(2 + `${i + 1}. `.length + box.length));
      });
      if (answer.notes) { body.push(""); add(theme.fg("muted", `Note: ${display(answer.notes)}`)); }
      if (question.multiSelect) hint("Space", "toggle");
      hint(confirmKey, question.multiSelect ? "confirm" : "select");
      hint(navigate, "navigate");
      switchHint();
      noteHint();
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
