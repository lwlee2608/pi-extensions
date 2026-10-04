import { stripVTControlCharacters } from "node:util";

export function display(text: string): string {
  return stripVTControlCharacters(text.replace(/\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\|$)/g, ""))
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
