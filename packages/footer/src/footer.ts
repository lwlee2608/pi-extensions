import type { ContextUsage, SessionEntry, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
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
  const [value, unit] = tokens < 1e6 ? [tokens / 1e3, "k"] : [tokens / 1e6, "M"];
  return `${value.toFixed(1).replace(/\.0$/, "")}${unit}`;
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
  provider?: string;
  model: string;
  thinking: Parameters<Theme["getThinkingBorderColor"]>[0];
  context: ContextUsage;
  totals: Totals;
  elapsed: number;
  cwd: string;
  branch: string | null;
  statuses: readonly string[];
}

export function renderFooter(
  snapshot: FooterSnapshot, width: number, theme?: Pick<Theme, "fg" | "getThinkingBorderColor">,
): string[] {
  if (width <= 0) return ["", ""];
  const paint = (color: ThemeColor, text: string) => theme ? theme.fg(color, text) : text;
  const dim = (text: string) => paint("dim", text);
  const { context, totals } = snapshot;
  const percent = context.percent === null ? null : Math.max(0, Math.min(100, context.percent));
  const pressure = percent === null || percent <= 70 ? undefined : percent > 90 ? "error" : "warning";
  const filled = Math.round((percent ?? 0) / 5);
  const bar = dim("[") + paint(pressure ?? "text", "━".repeat(filled)) + dim(`${"─".repeat(20 - filled)}]`);
  const percentText = `${percent === null ? "?" : Math.round(percent)}%`;
  const thinking = theme ? theme.getThinkingBorderColor(snapshot.thinking)(snapshot.thinking) : snapshot.thinking;
  const cached = totals.cached + totals.fresh > 0
    ? Math.round(totals.cached / (totals.cached + totals.fresh) * 100) : 0;
  const tokens = context.tokens === null ? "?" : formatTokens(context.tokens);
  const provider = snapshot.provider ? dim(`(${snapshot.provider}) `) : "";
  const status = provider + paint("text", snapshot.model) + dim(" [") + thinking + dim("] ") + bar + dim(" ")
    + paint(pressure ?? "text", percentText) + dim(" ") + paint("text", tokens)
    + dim(` / ${formatTokens(context.contextWindow)} tokens • `)
    + paint("text", `$${totals.cost.toFixed(2)}`)
    + dim(` (${cached}% cached, ${formatTokens(totals.fresh)} new) • ${formatDuration(snapshot.elapsed)}`);
  const statuses = snapshot.statuses.filter(Boolean).map(text => ` • ${text}`).join("");
  const project = snapshot.branch
    ? dim(`${snapshot.cwd} (`) + paint("accent", snapshot.branch) + dim(`)${statuses}`)
    : dim(`${snapshot.cwd}${statuses}`);
  return [status, project]
    .map(line => truncateToWidth(singleLine(line), width));
}
