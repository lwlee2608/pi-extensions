import type { ContextUsage, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export interface Totals {
  cost: number;
  cached: number;
  fresh: number;
}

export function summarize(entries: readonly SessionEntry[]): Totals {
  const totals: Totals = { cost: 0, cached: 0, fresh: 0 };
  for (const entry of entries) {
    const usage = entry.type === "message"
      ? (entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.usage : undefined)
      : (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined);
    if (!usage) continue;
    totals.cost += usage.cost.total;
    totals.cached += usage.cacheRead;
    totals.fresh += usage.input + usage.cacheWrite;
  }
  return totals;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function projectPath(cwd: string, home: string): string {
  if (cwd === home) return "~";
  return home !== "/" && cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

function singleLine(text: string): string {
  return text.replace(/[\r\n\t]/g, " ");
}

export interface FooterSnapshot {
  model: string;
  thinking: string;
  context: ContextUsage;
  totals: Totals;
  elapsed: number;
  cwd: string;
  branch: string | null;
  statuses: readonly string[];
}

export function renderFooter(snapshot: FooterSnapshot, width: number, theme?: Pick<Theme, "fg">): string[] {
  if (width <= 0) return ["", ""];
  const dim = (text: string) => theme ? theme.fg("dim", text) : text;
  const bright = (text: string) => theme ? theme.fg("text", text) : text;
  const { context, totals } = snapshot;
  const percent = context.percent === null ? null : Math.max(0, Math.min(100, context.percent));
  const filled = Math.round((percent ?? 0) / 5);
  const bar = dim("[") + bright("━".repeat(filled)) + dim(`${"─".repeat(20 - filled)}]`);
  const cached = totals.cached + totals.fresh > 0
    ? Math.round(totals.cached / (totals.cached + totals.fresh) * 100) : 0;
  const tokens = context.tokens === null ? "?" : formatTokens(context.tokens);
  const status = dim(`${snapshot.model} [${snapshot.thinking}] `) + bar
    + dim(` ${percent === null ? "?" : Math.round(percent)}% ${tokens} / ${formatTokens(context.contextWindow)} tokens • $${totals.cost.toFixed(2)} (${cached}% cached, ${formatTokens(totals.fresh)} new) • ${formatDuration(snapshot.elapsed)}`);
  const project = `${snapshot.cwd}${snapshot.branch ? ` (${snapshot.branch})` : ""}`;
  return [status, dim([project, ...snapshot.statuses].filter(Boolean).join(" • "))]
    .map(line => truncateToWidth(singleLine(line), width));
}
