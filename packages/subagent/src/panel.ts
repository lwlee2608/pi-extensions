import { stripVTControlCharacters } from "node:util";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Manager, Outcome, Snapshot, Step } from "./manager.ts";

export function display(text: string): string {
  return stripVTControlCharacters(text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
}
const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const linger = 5000;
export const active = ["working", "blocked", "queued"];
export function reminded(worker: Readonly<Snapshot>): boolean { return !!worker.recoverable && !worker.stopped; }
function shown(worker: Readonly<Snapshot>, now: number): boolean {
  return active.includes(worker.state) || reminded(worker) || (!!worker.result && now - worker.result.endedAt < linger);
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
function mark(state: Snapshot["state"], outcome: Outcome | undefined, now: number): Mark {
  if (state === "working") return ["accent", spinner[Math.floor(now / 100) % spinner.length]];
  if (state === "blocked") return ["warning", "?"];
  if (state === "queued") return ["dim", "○"];
  return outcome === "completed" ? ["success", "✓"] : outcome === "failed" ? ["error", "✗"] : outcome === "interrupted" ? ["warning", "⊘"] : ["dim", "○"];
}
export function icon(worker: Snapshot, now: number): Mark {
  return reminded(worker) && !active.includes(worker.state) ? ["warning", "↻"] : mark(worker.state, worker.result?.outcome, now);
}
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
function stepCost(step: Step, worker?: Snapshot): number { return step.result ? step.result.usage.cost.total : worker?.usage?.cost.total ?? 0; }
export function cost(node: Node): number {
  return node.steps.length ? node.steps.reduce((sum, s) => sum + stepCost(s, node.members.find(m => m.workerId === s.workerId)), 0)
    : node.members.reduce((sum, m) => sum + ((m.result?.usage ?? m.usage)?.cost.total ?? 0), 0);
}
const order = { blocked: 0, working: 1, queued: 2, idle: 3, closed: 4 };
const budget = 8;
export function byState(a: Snapshot, b: Snapshot): number { return order[a.state] - order[b.state] || b.startedAt - a.startedAt; }
export function elapsed(worker: Snapshot, now: number): number { return (active.includes(worker.state) ? now : worker.result?.endedAt ?? now) - worker.startedAt; }
function detail(worker: Snapshot): Mark {
  const question = worker.questions?.find(q => q.state === "pending");
  if (question) return ["warning", `asks: ${question.question} · /subagents → r`];
  const error = worker.error ?? worker.result?.error;
  if (error) return ["error", error];
  if (reminded(worker)) return ["warning", `saved conversation${worker.questions?.some(q => q.state === "cancelled") ? "; pending questions cancelled" : ""} · /subagents → c`];
  return ["dim", active.includes(worker.state) ? [worker.activity, line(worker.output, true)].filter(Boolean).join(" · ") : line(worker.output, false) || worker.activity];
}
export function names(nodes: Node[]): Map<string, string> {
  const result = new Map<string, string>();
  const number = (pairs: [string, string][]) => {
    const totals = new Map<string, number>(), seen = new Map<string, number>();
    for (const [, name] of pairs) totals.set(name, (totals.get(name) ?? 0) + 1);
    for (const [id, name] of pairs) { const k = (seen.get(name) ?? 0) + 1; seen.set(name, k); result.set(id, totals.get(name)! > 1 ? `${name} #${k}` : name); }
  };
  number(nodes.map(node => [node.root.workerId, display(node.title)]));
  for (const node of nodes) number(node.members.filter(m => m.workerId !== node.root.workerId).map(m => [m.workerId, display(m.label)]));
  return result;
}
export function named(node: Node, member: Snapshot, labels: Map<string, string>): string {
  return member.workerId === node.root.workerId && member.label !== node.title ? display(member.label) : labels.get(member.workerId) ?? display(member.label);
}
const tones = ["text", "muted", "dim", "dim"] as const;
function group(node: Node, members: Snapshot[], title: string, labels: Map<string, string>, agents: Map<string, string>, now: number, theme: Paint): string[] {
  const total = cost(node), [color, symbol] = icon([...members].sort(byState)[0], now);
  const head = `${theme.fg(color, symbol)} ${theme.fg("accent", title)} ${theme.fg("dim", `· ${[duration(span(node, now)), ...(total ? [`$${total.toFixed(2)}`] : [])].join(" · ")}`)}`;
  const cells = members.map(m => {
    const full = named(node, m, labels), name = full === title ? "" : full, agent = agents.get(m.runId) ?? "";
    return [truncateToWidth(name, 32, "…"), name.startsWith(agent) ? "" : agent, duration(elapsed(m, now)), m.context ? `ctx ${tokens(m.context)}` : ""];
  });
  const widths = tones.map((_, j) => Math.max(...cells.map(c => visibleWidth(c[j]))));
  return [head, ...members.map((member, i) => {
    const [mc, ms] = icon(member, now), [tone, text] = detail(member);
    const cols = cells[i].flatMap((cell, j) => {
      const space = " ".repeat(widths[j] - visibleWidth(cell));
      return widths[j] ? [theme.fg(tones[j], j === 2 ? space + cell : cell + space)] : [];
    });
    return `${theme.fg("dim", i === members.length - 1 ? "  └ " : "  ├ ")}${theme.fg(mc, ms)} ${[...cols, theme.fg(tone, display(text))].join("  ")}`;
  })];
}
export function panelLines(workers: Snapshot[], width: number, now = Date.now(), theme: Paint = plain, steps: Step[] = []): string[] {
  if (width < 1) return [];
  const agents = new Map(steps.map(s => [s.runId, display(s.agent)])), nodes = tree(workers, steps), labels = names(nodes);
  const groups = nodes.flatMap(node => {
    const members = node.members.filter(w => shown(w, now));
    return members.length ? [{ node, members, title: labels.get(node.root.workerId)!, rank: Math.min(...members.map(m => order[m.state])) }] : [];
  }).sort((a, b) => a.rank - b.rank);
  const queued = groups.filter(g => g.members.every(m => m.state === "queued"));
  const lines: string[] = [];
  let hidden = 0;
  for (const { node, members, title } of groups.filter(g => !queued.includes(g))) {
    const text = group(node, members, title, labels, agents, now, theme);
    if (hidden || (lines.length && lines.length + text.length > budget)) hidden++;
    else lines.push(...text);
  }
  if (queued.length) lines.push(theme.fg("dim", `○ ${queued.length} queued: ${queued.map(g => g.title).join(", ")}`));
  if (hidden) lines.push(theme.fg("muted", `+${hidden} more · /subagents`));
  if (lines.length) lines[0] += theme.fg("dim", " · ↓ inspect");
  return lines.map(line => truncateToWidth(line, width));
}
export function attachPanel(manager: Manager, ui: ExtensionUIContext, inspect: () => void): () => void {
  let render: (() => void) | undefined;
  let host: (TUI & { getFocusedComponent?(): Component | null }) | undefined;
  let scheduled: NodeJS.Timeout | undefined;
  let disposed = false;
  ui.setWidget("pi-subagent", (tui, theme: Theme): Component => {
    host = tui; render = () => tui.requestRender();
    return { render: width => panelLines(manager.status(), width, Date.now(), theme, manager.history()), invalidate() {} };
  }, { placement: "aboveEditor" });
  const update = () => {
    if (!disposed && !scheduled) scheduled = setTimeout(() => { scheduled = undefined; render?.(); }, 80);
  };
  const unsubscribe = manager.onChange(update);
  const unlisten = ui.onTerminalInput(data => {
    const editor = host?.getFocusedComponent?.() as { getText?(): string } | null | undefined;
    if (!matchesKey(data, "down") || editor?.getText?.() !== "" || !manager.some(w => shown(w, Date.now()))) return;
    inspect();
    return { consume: true };
  });
  let tick = 0;
  const clock = setInterval(() => {
    const now = Date.now();
    if (manager.some(w => w.state === "working") || (++tick % 10 === 0 && manager.some(w => shown(w, now - 1000)))) update();
  }, 100);
  clock.unref();
  return () => { disposed = true; unsubscribe(); unlisten(); clearInterval(clock); clearTimeout(scheduled); ui.setWidget("pi-subagent", undefined); };
}
