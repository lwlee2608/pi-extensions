import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Manager, Snapshot } from "./manager.ts";

export function display(text: string): string {
  return stripVTControlCharacters(text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
}
const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
type Paint = Pick<Theme, "fg">;
const plain: Paint = { fg: (_color, text) => text };
function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}
function tokens(n: number): string {
  return n < 1e3 ? `${n}` : n < 1e4 ? `${(n / 1e3).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1e3)}k` : `${(n / 1e6).toFixed(1)}M`;
}
function line(text: string, last: boolean): string {
  const lines = text.split("\n").map(l => l.replace(/\*\*|__|`/g, "").replace(/^\s*(?:#+|[-*>])\s+/, "").trim()).filter(Boolean);
  return (last ? lines.at(-1) : lines[0]) ?? "";
}
function icon(worker: Snapshot, now: number): [Parameters<Paint["fg"]>[0], string] {
  if (worker.state === "working") return ["accent", spinner[Math.floor(now / 100) % spinner.length]];
  if (worker.state === "blocked") return ["warning", "?"];
  if (worker.state === "queued") return ["dim", "○"];
  if (worker.recoverable) return ["warning", "↻"];
  const outcome = worker.result?.outcome;
  return outcome === "completed" ? ["success", "✓"] : outcome === "failed" ? ["error", "✗"] : outcome === "interrupted" ? ["warning", "⊘"] : ["dim", "○"];
}
export function panelLines(workers: Snapshot[], width: number, now = Date.now(), theme: Paint = plain): string[] {
  if (width < 1 || !workers.length) return [];
  const live = workers.filter(w => w.state !== "closed");
  const order = { blocked: 0, working: 1, queued: 2, idle: 3, closed: 4 };
  const ordered = live.sort((a, b) => order[a.state] - order[b.state]);
  if (!ordered.length) ordered.push(...workers.filter(w => w.recoverable));
  if (!ordered.length) ordered.push(workers.at(-1)!);
  const rows = ordered.slice(0, 4).flatMap(worker => {
    const total = (worker.result?.usage ?? worker.usage)?.totalTokens;
    const meta = [duration((worker.result?.endedAt ?? now) - worker.startedAt), ...(total ? [`${tokens(total)} tok`] : [])].join(" · ");
    const [color, symbol] = icon(worker, now);
    const question = worker.questions?.find(q => q.state === "pending");
    const running = ["working", "queued", "blocked"].includes(worker.state);
    const [tone, detail] = question ? ["warning", `reply ${question.questionId}: ${question.question}`] as const
      : worker.error ? ["error", worker.error] as const
      : worker.recoverable ? ["warning", `recover ${worker.workerId} · saved conversation; pending questions cancelled`] as const
      : ["muted", running ? [worker.activity, line(worker.output, true)].filter(Boolean).join(" · ") : line(worker.output, false) || worker.activity] as const;
    return [`${theme.fg(color, symbol)} ${theme.fg("accent", display(worker.label))} ${theme.fg("dim", `· ${meta}`)}`,
      `${theme.fg("dim", "  └ ")}${theme.fg(tone, display(detail))}`];
  });
  if (ordered.length > 4) rows.push(theme.fg("muted", `+${ordered.length - 4} more workers · subagent status for details`));
  return rows.map(row => truncateToWidth(row, width));
}
export function attachPanel(manager: Manager, ui: ExtensionUIContext): () => void {
  let render: (() => void) | undefined;
  let scheduled: NodeJS.Timeout | undefined;
  let disposed = false;
  ui.setWidget("pi-subagent", (tui, theme: Theme): Component => {
    render = () => tui.requestRender();
    return { render: width => panelLines(manager.status(), width, Date.now(), theme), invalidate() {} };
  }, { placement: "aboveEditor" });
  const update = () => {
    if (!disposed && !scheduled) scheduled = setTimeout(() => { scheduled = undefined; render?.(); }, 80);
  };
  const unsubscribe = manager.onChange(update);
  const clock = setInterval(() => { if (manager.status().some(w => ["working", "blocked", "queued"].includes(w.state))) update(); }, 100);
  clock.unref();
  return () => { disposed = true; unsubscribe(); clearInterval(clock); clearTimeout(scheduled); ui.setWidget("pi-subagent", undefined); };
}
