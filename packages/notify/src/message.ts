import { homedir } from "node:os";
import { sep } from "node:path";
import type { Outcome } from "./state.ts";

export type Kind = Outcome | "test" | "waiting for input" | { reason: string };

export function formatMessage(name: string | undefined, cwd: string, outcome: Kind, home = homedir()): string {
  const directory = cwd === home ? "~" : cwd.startsWith(home + sep) ? `~${cwd.slice(home.length)}` : cwd;
  const label = typeof outcome === "object" ? outcome.reason : outcome === "completed" ? "done" : outcome;
  const icon = outcome === "completed" ? "✅" : outcome === "error" ? "❌" : "🔔";
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  return `${icon} ${[name?.trim(), directory, label].filter(Boolean).map(part => clean(part!)).join(" · ")}`;
}
