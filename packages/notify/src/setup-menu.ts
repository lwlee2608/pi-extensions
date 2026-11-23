import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager } from "@earendil-works/pi-tui";

export type RowId = number | string;
export interface MenuRow { id: RowId; label: string; note?: string; toggle?: () => string; edit?: { value: string; placeholder?: string; set: (value: string) => void } }
export interface MenuSection { header?: string; description?: string; rows: MenuRow[] }
export interface SetupMenuOptions { title: string; tabs?: { labels: string[]; active: number; all?: MenuSection[][] }; hint: string; sections: MenuSection[]; initial?: RowId; signal?: AbortSignal; rows?: () => number }

export const SWITCH_TAB = "switch tab";
const TAB_KEYS = ["tab", "left", "right"] as const;

const MIN_LABEL = 8;
const MIN_LINES = 3;
// Pi clips tall dialogs from the bottom, so leave room for its transcript line and footer.
const RESERVED_ROWS = 4;

export class SetupMenu implements Component, Focusable {
  private readonly options: SetupMenuOptions;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: (id: RowId | undefined) => void;
  private readonly cancel: () => void;
  private readonly rows: MenuRow[];
  private cursor: number;
  private input: Input | undefined;
  private hasFocus = false;

  constructor(options: SetupMenuOptions, theme: Theme, keys: KeybindingsManager, done: (id: RowId | undefined) => void) {
    this.options = options;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.cancel = () => done(undefined);
    this.rows = options.sections.flatMap(section => section.rows);
    this.cursor = Math.max(0, this.rows.findIndex(row => row.id === options.initial));
    options.signal?.addEventListener("abort", this.cancel, { once: true });
  }

  get editing(): boolean { return this.input !== undefined; }
  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    if (this.input) this.input.focused = value;
  }

  handleInput(data: string): void {
    if (this.input) this.input.handleInput(data);
    else if (this.options.tabs && TAB_KEYS.some(key => matchesKey(data, key))) this.done(SWITCH_TAB);
    else if (this.keys.matches(data, "tui.select.up") || data === "k") this.cursor = Math.max(0, this.cursor - 1);
    else if (this.keys.matches(data, "tui.select.down") || data === "j") this.cursor = Math.min(this.rows.length - 1, this.cursor + 1);
    else if (this.keys.matches(data, "tui.select.confirm") || data === "\n") this.confirm(this.rows[this.cursor]);
    else if (this.keys.matches(data, "tui.select.cancel")) this.cancel();
  }

  invalidate(): void {}
  dispose(): void { this.options.signal?.removeEventListener("abort", this.cancel); }

  render(width: number): string[] {
    const { theme } = this;
    const lines = [theme.fg("accent", theme.bold(this.options.title))];
    const { tabs } = this.options;
    if (tabs) {
      const bar = tabs.labels.map((label, i) => i === tabs.active ? theme.fg("accent", theme.bold(`[ ${label} ]`)) : theme.fg("muted", `  ${label}  `));
      lines.push("", `${bar.join("   ")}${theme.fg("dim", "   tab ⇄")}`, theme.fg("border", "━".repeat(Math.max(0, width - 2))));
    }
    const { sections } = this.options;
    const head = this.body(sections.slice(0, -1), width);
    const tail = this.body(sections.slice(-1), width);
    const tallest = Math.max(0, ...(tabs?.all ?? []).map(other => this.body(other, width).lines.length));
    const pad = Math.max(0, tallest - head.lines.length - tail.lines.length);
    const at = head.at >= 0 ? lines.length + head.at : tail.at >= 0 ? lines.length + head.lines.length + pad + tail.at : 0;
    lines.push(...head.lines, ...Array<string>(pad).fill(""), ...tail.lines);
    lines.push("", ...(this.input ? "enter confirm   esc back" : this.options.hint).split("\n").flatMap(line => wrapTextWithAnsi(theme.fg("dim", line), Math.max(1, width - 2))));
    const max = this.options.rows ? Math.max(MIN_LINES, this.options.rows() - RESERVED_ROWS) : lines.length;
    const start = Math.max(0, Math.min(at - (max >> 1), lines.length - max));
    return lines.slice(start, start + max).map(line => truncateToWidth(` ${line}`, width, ""));
  }

  private body(sections: MenuSection[], width: number): { lines: string[]; at: number } {
    const { theme } = this;
    const lines: string[] = [];
    let at = -1;
    for (const { header, description, rows } of sections) {
      lines.push("", header ? theme.fg("muted", header) : theme.fg("border", "─".repeat(Math.max(0, width - 2))));
      if (description) lines.push(...wrapTextWithAnsi(theme.fg("dim", description), Math.max(1, width - 2)));
      for (const row of rows) {
        if (row === this.rows[this.cursor]) at = lines.length;
        lines.push(this.row(row, width));
      }
    }
    return { lines, at };
  }

  private confirm(row: MenuRow): void {
    if (row.edit) this.edit(row, row.edit);
    else if (row.toggle) row.note = row.toggle();
    else this.done(row.id);
  }

  private edit(row: MenuRow, edit: NonNullable<MenuRow["edit"]>): void {
    const input = new Input({ prompt: "", placeholder: edit.placeholder, placeholderStyle: text => this.theme.fg("dim", text) });
    input.focused = this.hasFocus;
    // Input.setValue leaves the cursor at column 0; a paste leaves it after the text.
    if (edit.value) input.handleInput(`\x1b[200~${edit.value}\x1b[201~`);
    input.onSubmit = value => {
      this.input = undefined;
      edit.set(value);
      this.done(row.id);
    };
    input.onEscape = () => { this.input = undefined; };
    this.input = input;
  }

  private row(row: MenuRow, width: number): string {
    const selected = row === this.rows[this.cursor];
    if (selected && this.input) {
      const label = `→ ${row.label}`;
      return this.theme.fg("accent", label) + this.input.render(Math.max(1, width - 3 - visibleWidth(label)))[0];
    }
    const paint = (text: string) => this.theme.fg(selected ? "accent" : "text", text);
    const note = row.note ?? "";
    const room = Math.max(width - 3 - visibleWidth(note), MIN_LABEL);
    return paint(`${selected ? "→ " : "  "}${truncateToWidth(row.label, room, "…")}`) + paint(note);
  }
}
