import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Manager, Snapshot } from "./manager.ts";

export function display(text: string): string {
  return stripVTControlCharacters(text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
}
export function panelLines(workers: Snapshot[], width: number, now = Date.now()): string[] {
  if (width < 1 || !workers.length) return [];
  const live = workers.filter(w => w.state !== "closed");
  const order = { blocked: 0, working: 1, queued: 2, idle: 3, closed: 4 };
  const ordered = live.sort((a, b) => order[a.state] - order[b.state]);
  if (!ordered.length) ordered.push(workers.at(-1)!);
  const rows = ordered.slice(0, 4).flatMap(worker => {
    const elapsed = Math.max(0, Math.floor(((worker.result?.endedAt ?? now) - worker.startedAt) / 1000));
    const usage = worker.result?.usage.totalTokens ? ` · ${worker.result.usage.totalTokens} tokens` : "";
    const question = worker.questions?.find(q => q.state === "pending");
    const detail = question ? `reply ${question.questionId}: ${question.question}` : worker.error ?? `${worker.activity} · ${worker.output}`;
    return [`Subagent · ${worker.label} · ${worker.state}${worker.result ? `/${worker.result.outcome}` : ""} · ${elapsed}s${usage}`, detail];
  });
  if (ordered.length > 4) rows.push(`+${ordered.length - 4} more workers · subagent status for details`);
  return rows.map(row => truncateToWidth(display(row), width));
}
export function attachPanel(manager: Manager, ui: ExtensionUIContext): () => void {
  let render: (() => void) | undefined;
  let scheduled: NodeJS.Timeout | undefined;
  let disposed = false;
  ui.setWidget("pi-subagent", (tui, theme: Theme): Component => {
    render = () => tui.requestRender();
    return { render: width => panelLines(manager.status(), width).map(line => theme.fg("muted", line)), invalidate() {} };
  }, { placement: "aboveEditor" });
  const update = () => {
    if (!disposed && !scheduled) scheduled = setTimeout(() => { scheduled = undefined; render?.(); }, 80);
  };
  const unsubscribe = manager.onChange(update);
  const clock = setInterval(() => { if (manager.status().some(w => ["working", "blocked", "queued"].includes(w.state))) update(); }, 1000);
  clock.unref();
  return () => { disposed = true; unsubscribe(); clearInterval(clock); clearTimeout(scheduled); ui.setWidget("pi-subagent", undefined); };
}
