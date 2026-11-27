import { homedir } from "node:os";
import { sep } from "node:path";
import type { Outcome } from "./state.ts";

export type Kind = Outcome | "test" | "waiting for input" | { reason: string } | { outcome: Outcome; summary: string };

const MAX_SUMMARY = 120;
const TAGGED = /^[\s>#-]*(\*\*|__|\*|_)?summary(\1)?\s*:\s*(\1)?\s*(.*\S)/i;

export function summaryLine(text: string): string | undefined {
  for (const line of text.split("\n").reverse()) {
    const match = TAGGED.exec(line);
    if (!match) continue;
    const [, mark, before, after, body] = match;
    return oneLine(mark && !before && !after && body.endsWith(mark) ? body.slice(0, -mark.length) : body);
  }
}

export function oneLine(text: string): string | undefined {
  const line = Array.from(text.replace(/[\x00-\x1f\x7f-\x9f\s]+/g, " ").trim());
  if (!line.length) return undefined;
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1).join("").trimEnd()}…` : line.join("");
}

export function formatMessage(name: string | undefined, cwd: string, outcome: Kind, home = homedir()): string {
  const directory = cwd === home ? "~" : cwd.startsWith(home + sep) ? `~${cwd.slice(home.length)}` : cwd;
  const result = typeof outcome === "object" && "outcome" in outcome ? outcome.outcome : outcome;
  const label = typeof outcome === "object" ? "reason" in outcome ? outcome.reason : outcome.summary : outcome === "completed" ? "done" : outcome;
  const icon = result === "completed" ? "✅" : result === "error" ? "❌" : "🔔";
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  return `${icon} ${[name?.trim(), directory, label].filter(Boolean).map(part => clean(part!)).join(" · ")}`;
}
