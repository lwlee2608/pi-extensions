import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";

export type RowId = number | string;
export interface MenuRow { id: RowId; label: string; note?: string; toggle?: () => string }
export interface MenuSection { header?: string; rows: MenuRow[] }
export interface SetupMenuOptions { title: string; hint: string; sections: MenuSection[]; initial?: RowId; signal?: AbortSignal }

const MIN_LABEL = 8;

export class SetupMenu implements Component {
  private readonly options: SetupMenuOptions;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: (id: RowId | undefined) => void;
  private readonly cancel: () => void;
  private readonly rows: MenuRow[];
  private cursor: number;

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

  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.up") || data === "k") this.cursor = Math.max(0, this.cursor - 1);
    else if (this.keys.matches(data, "tui.select.down") || data === "j") this.cursor = Math.min(this.rows.length - 1, this.cursor + 1);
    else if (this.keys.matches(data, "tui.select.confirm") || data === "\n") this.confirm(this.rows[this.cursor]);
    else if (this.keys.matches(data, "tui.select.cancel")) this.cancel();
  }

  invalidate(): void {}
  dispose(): void { this.options.signal?.removeEventListener("abort", this.cancel); }

  render(width: number): string[] {
    const { theme } = this;
    const lines = [theme.fg("accent", theme.bold(this.options.title))];
    for (const { header, rows } of this.options.sections) {
      lines.push("", header ? theme.fg("muted", header) : theme.fg("border", "─".repeat(Math.max(0, width - 2))));
      for (const row of rows) lines.push(this.row(row, width));
    }
    lines.push("", ...wrapTextWithAnsi(theme.fg("dim", this.options.hint), Math.max(1, width - 2)));
    return lines.map(line => truncateToWidth(` ${line}`, width, ""));
  }

  private confirm(row: MenuRow): void {
    if (row.toggle) row.note = row.toggle();
    else this.done(row.id);
  }

  private row(row: MenuRow, width: number): string {
    const selected = row === this.rows[this.cursor];
    const paint = (text: string) => this.theme.fg(selected ? "accent" : "text", text);
    const note = row.note ?? "";
    const room = Math.max(width - 3 - visibleWidth(note), MIN_LABEL);
    return paint(`${selected ? "→ " : "  "}${truncateToWidth(row.label, room, "…")}`) + paint(note);
  }
}
