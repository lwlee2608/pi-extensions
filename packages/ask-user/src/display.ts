import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

export function display(text: string): string {
  return stripVTControlCharacters(text.replace(/\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\|$)/g, ""))
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function editorDisplay(line: string): string {
  return line.split(/(\x1b\[[\d;:]*m|\x1b_pi:c\x07)/g)
    .map(part => part === CURSOR_MARKER || /^\x1b\[[\d;:]*m$/.test(part) ? part : display(part)).join("");
}
