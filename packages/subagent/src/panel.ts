import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Manager, Outcome, Snapshot, Step } from "./manager.ts";

export function display(text: string): string {
  return stripVTControlCharacters(text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
}
const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const linger = 5000;
const active = ["working", "blocked", "queued"];
function shown(worker: Readonly<Snapshot>, now: number): boolean {
  return active.includes(worker.state) || !!worker.recoverable || (!!worker.result && now - worker.result.endedAt < linger);
}
type Paint = Pick<Theme, "fg">;
const plain: Paint = { fg: (_color, text) => text };
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}
function tokens(n: number): string {
  return n < 1e3 ? `${n}` : n < 1e4 ? `${(n / 1e3).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1e3)}k` : `${(n / 1e6).toFixed(1)}M`;
}
export function line(text: string, last: boolean): string {
  const lines = text.split("\n").map(l => l.replace(/\*\*|__|`/g, "").replace(/^\s*(?:#+|[-*>])\s+/, "").trim()).filter(Boolean);
  return (last ? lines.at(-1) : lines[0]) ?? "";
}
type Mark = [Parameters<Paint["fg"]>[0], string];
export function mark(state: Snapshot["state"], outcome: Outcome | undefined, now: number): Mark {
  if (state === "working") return ["accent", spinner[Math.floor(now / 100) % spinner.length]];
  if (state === "blocked") return ["warning", "?"];
  if (state === "queued") return ["dim", "○"];
  return outcome === "completed" ? ["success", "✓"] : outcome === "failed" ? ["error", "✗"] : outcome === "interrupted" ? ["warning", "⊘"] : ["dim", "○"];
}
function icon(worker: Snapshot, now: number): Mark {
  return worker.recoverable && !active.includes(worker.state) ? ["warning", "↻"] : mark(worker.state, worker.result?.outcome, now);
}
export function stepMark(step: Step, now: number): Mark { return mark(step.result ? "closed" : step.state, step.result?.outcome, now); }
export interface Node { root: Snapshot; title: string; members: Snapshot[]; steps: Step[] }
export function tree(workers: Snapshot[], steps: Step[]): Node[] {
  const byId = new Map(workers.map(w => [w.workerId, w])), nodes = new Map<string, Node>();
  const rootId = (id: string) => { const parent = byId.get(id)?.parentWorkerId; return parent && byId.has(parent) && !byId.get(parent)!.parentWorkerId ? parent : id; };
  for (const worker of workers) {
    const id = rootId(worker.workerId);
    if (!nodes.has(id)) nodes.set(id, { root: byId.get(id)!, title: "", members: [], steps: [] });
    nodes.get(id)!.members.push(worker);
  }
  for (const step of steps) nodes.get(rootId(step.workerId))?.steps.push(step);
  for (const node of nodes.values()) node.title = node.steps.find(s => s.workerId === node.root.workerId)?.label ?? node.root.label;
  const first = (node: Node) => node.steps[0]?.startedAt ?? node.root.startedAt;
  return [...nodes.values()].sort((a, b) => first(a) - first(b));
}
export function span(node: Node, now: number): number {
  const start = node.steps[0]?.startedAt ?? Math.min(...node.members.map(m => m.startedAt));
  const ends = [...node.steps, ...node.members].flatMap(r => r.result ? [r.result.endedAt] : []);
  return (node.members.some(m => active.includes(m.state)) || !ends.length ? now : Math.max(...ends)) - start;
}
export function stepCost(step: Step, worker?: Snapshot): number { return step.result ? step.result.usage.cost.total : worker?.usage?.cost.total ?? 0; }
export function cost(node: Node): number {
  return node.steps.length ? node.steps.reduce((sum, s) => sum + stepCost(s, node.members.find(m => m.workerId === s.workerId)), 0)
    : node.members.reduce((sum, m) => sum + ((m.result?.usage ?? m.usage)?.cost.total ?? 0), 0);
}
export function panelLines(workers: Snapshot[], width: number, now = Date.now(), theme: Paint = plain, steps: Step[] = []): string[] {
  if (width < 1) return [];
  const order = { blocked: 0, working: 1, queued: 2, idle: 3, closed: 4 };
  const entries = tree(workers, steps).flatMap(node => {
    const visible = node.members.filter(w => shown(w, now)).sort((a, b) => order[a.state] - order[b.state] || b.startedAt - a.startedAt);
    return visible.length ? [{ node, lead: visible[0] }] : [];
  }).sort((a, b) => order[a.lead.state] - order[b.lead.state]);
  const rows = entries.slice(0, 4).flatMap(({ node, lead: worker }) => {
    const total = cost(node);
    const meta = [duration(span(node, now)), ...(worker.context ? [`ctx ${tokens(worker.context)}`] : []), ...(total ? [`$${total.toFixed(2)}`] : [])].join(" · ");
    const [color, symbol] = icon(worker, now);
    const head = `${theme.fg(color, symbol)} ${theme.fg("accent", display(node.title))} ${theme.fg("dim", `· ${meta}`)}`;
    const parts = node.steps.map(step => { const [tone, mark] = stepMark(step, now), agent = display(step.agent); return { text: `${theme.fg(tone, mark)} ${theme.fg("muted", agent)}`, width: visibleWidth(`${mark} ${agent}`) }; });
    const fits = (n: number) => parts.slice(-n).reduce((sum, p) => sum + p.width + 3, n < parts.length ? `+${parts.length - n}`.length + 3 : 0) <= width - visibleWidth(head);
    let kept = parts.length;
    while (kept > 1 && !fits(kept)) kept--;
    const chain = parts.length > 1 ? `${theme.fg("dim", " · ")}${[...(kept < parts.length ? [theme.fg("dim", `+${parts.length - kept}`)] : []), ...parts.slice(-kept).map(p => p.text)].join(theme.fg("dim", " › "))}` : "";
    const question = worker.questions?.find(q => q.state === "pending");
    const running = active.includes(worker.state);
    const [tone, detail] = question ? ["warning", `reply ${question.questionId}: ${question.question}`] as const
      : worker.error ? ["error", worker.error] as const
      : worker.recoverable ? ["warning", `recover ${worker.workerId} · saved conversation; pending questions cancelled`] as const
      : ["muted", running ? [worker.activity, line(worker.output, true)].filter(Boolean).join(" · ") : line(worker.output, false) || worker.activity] as const;
    return [`${head}${chain}`,
      `${theme.fg("dim", "  └ ")}${theme.fg(tone, display(detail))}`];
  });
  if (entries.length > 4) rows.push(theme.fg("muted", `+${entries.length - 4} more workers · subagent status for details`));
  return rows.map(row => truncateToWidth(row, width));
}
export function attachPanel(manager: Manager, ui: ExtensionUIContext): () => void {
  let render: (() => void) | undefined;
  let scheduled: NodeJS.Timeout | undefined;
  let disposed = false;
  ui.setWidget("pi-subagent", (tui, theme: Theme): Component => {
    render = () => tui.requestRender();
    return { render: width => panelLines(manager.status(), width, Date.now(), theme, manager.history()), invalidate() {} };
  }, { placement: "aboveEditor" });
  const update = () => {
    if (!disposed && !scheduled) scheduled = setTimeout(() => { scheduled = undefined; render?.(); }, 80);
  };
  const unsubscribe = manager.onChange(update);
  let tick = 0;
  const clock = setInterval(() => {
    const now = Date.now();
    if (manager.some(w => w.state === "working") || (++tick % 10 === 0 && manager.some(w => shown(w, now - 1000)))) update();
  }, 100);
  clock.unref();
  return () => { disposed = true; unsubscribe(); clearInterval(clock); clearTimeout(scheduled); ui.setWidget("pi-subagent", undefined); };
}
