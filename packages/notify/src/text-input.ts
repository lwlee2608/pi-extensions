import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";

export interface TextInputOptions { title: string; hint?: string; initial?: string; mask?: boolean; signal?: AbortSignal }

const READABLE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?$/;

export class TextInput implements Component, Focusable {
  private readonly input = new Input();
  private readonly options: TextInputOptions;
  private readonly theme: Theme;
  private readonly cancel: () => void;

  constructor(options: TextInputOptions, theme: Theme, done: (value: string | undefined) => void) {
    this.options = options;
    this.theme = theme;
    this.cancel = () => done(undefined);
    this.input.onSubmit = done;
    this.input.onEscape = this.cancel;
    options.signal?.addEventListener("abort", this.cancel, { once: true });
    // Input.setValue leaves the cursor at column 0; a paste leaves it after the text.
    if (options.initial) this.input.handleInput(`\x1b[200~${options.initial}\x1b[201~`);
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  handleInput(data: string): void { this.input.handleInput(data); }
  invalidate(): void {}
  dispose(): void { this.options.signal?.removeEventListener("abort", this.cancel); }

  render(width: number): string[] {
    const { title, hint } = this.options;
    return [
      ...wrapTextWithAnsi(this.theme.fg("accent", title), width),
      ...(hint ? wrapTextWithAnsi(this.theme.fg("muted", hint), width) : []),
      "",
      this.line(width),
      "",
      truncateToWidth(this.theme.fg("dim", "enter confirm · esc back"), width),
    ];
  }

  private line(width: number): string {
    const value = this.input.getValue();
    if (!this.options.mask || READABLE.test(value)) return this.input.render(width)[0];
    const dots = "•".repeat(Math.min(value.length, Math.max(0, width - 3)));
    return truncateToWidth(`> ${dots}${this.focused ? CURSOR_MARKER : ""}\x1b[7m \x1b[27m`, width, "");
  }
}
