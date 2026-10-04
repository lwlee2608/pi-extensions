import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { display, editorDisplay } from "./display.ts";

export class Preview {
  private markdown?: Markdown;
  private text = "";
  private offset = 0;
  private length = 0;
  private page = 1;

  setText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.offset = 0;
    this.markdown = undefined;
  }
  invalidate(): void { this.markdown = undefined; }
  scroll(direction: number): void { this.offset = Math.max(0, Math.min(this.length - this.page, this.offset + direction * this.page)); }
  render(width: number, height: number): string[] {
    if (height < 1 || width < 1) return [];
    this.markdown ??= new Markdown(display(this.text), 0, 0, getMarkdownTheme());
    const lines = this.markdown.render(width).map(line => truncateToWidth(editorDisplay(line), width));
    this.page = Math.max(1, height - 1);
    this.length = lines.length;
    this.offset = Math.max(0, Math.min(this.offset, lines.length - this.page));
    return [truncateToWidth(`Preview ${this.offset + 1}–${Math.min(lines.length, this.offset + this.page)}/${lines.length}`, width), ...lines.slice(this.offset, this.offset + this.page)].slice(0, height);
  }
}

export function columns(left: string[], right: string[], leftWidth: number, width: number): string[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => {
    const line = truncateToWidth(left[i] ?? "", leftWidth);
    return truncateToWidth(line + " ".repeat(Math.max(0, leftWidth - visibleWidth(line))) + " │ " + (right[i] ?? ""), width);
  });
}
