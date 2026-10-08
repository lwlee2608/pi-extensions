import { homedir } from "node:os";
import { sep } from "node:path";
import type { Outcome } from "./state.ts";

export function formatMessage(name: string | undefined, cwd: string, outcome: Outcome | "test" | "waiting for input", home = homedir()): string {
  const directory = cwd === home ? "~" : cwd.startsWith(home + sep) ? `~${cwd.slice(home.length)}` : cwd;
  const label = outcome === "completed" ? "done" : outcome;
  const icon = outcome === "completed" ? "✅" : outcome === "error" ? "❌" : "🔔";
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  return `${icon} ${[name?.trim(), directory, label].filter(Boolean).map(part => clean(part!)).join(" · ")}`;
}
