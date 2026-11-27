import { homedir } from "node:os";
import { sep } from "node:path";
import type { Outcome } from "./state.ts";

export type Kind = Outcome | "test" | "waiting for input" | { reason: string } | { outcome: Outcome; summary: string };

const MAX_SUMMARY = 120;
const TAGGED = /^[\s>*_#-]*summary[*_\s]*:[*_\s]*(.*\S)/i;

export function summaryLine(text: string): string | undefined {
  const line = text.split("\n").reverse().map(line => TAGGED.exec(line)?.[1]).find(Boolean);
  return line && oneLine(line.replace(/\*\*|__/g, ""));
}

export function oneLine(text: string): string | undefined {
  const line = text.replace(/[\x00-\x1f\x7f-\x9f\s]+/g, " ").trim();
  if (!line) return undefined;
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : line;
}

export function formatMessage(name: string | undefined, cwd: string, outcome: Kind, home = homedir()): string {
  const directory = cwd === home ? "~" : cwd.startsWith(home + sep) ? `~${cwd.slice(home.length)}` : cwd;
  const result = typeof outcome === "object" && "outcome" in outcome ? outcome.outcome : outcome;
  const label = typeof outcome === "object" ? "reason" in outcome ? outcome.reason : outcome.summary : outcome === "completed" ? "done" : outcome;
  const icon = result === "completed" ? "✅" : result === "error" ? "❌" : "🔔";
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  return `${icon} ${[name?.trim(), directory, label].filter(Boolean).map(part => clean(part!)).join(" · ")}`;
}
