import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Manager, Snapshot } from "./manager.ts";

export function display(text: string): string {
  return stripVTControlCharacters(text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
}
export function panelLines(workers: Snapshot[], width: number, now = Date.now()): string[] {
  if (width < 1 || !workers.length) return [];
  const worker = workers.find(w => w.state === "working") ?? workers.at(-1)!;
  const elapsed = Math.max(0, Math.floor(((worker.result?.endedAt ?? now) - worker.startedAt) / 1000));
  const usage = worker.result?.usage.totalTokens ? ` · ${worker.result.usage.totalTokens} tokens` : "";
  return [
    truncateToWidth(display(`Subagent · ${worker.label} · ${worker.state}${worker.result ? `/${worker.result.outcome}` : ""} · ${elapsed}s${usage}`), width),
    truncateToWidth(display(worker.error ?? (worker.state === "working" ? `${worker.activity} · ${worker.output}` : worker.result?.text ?? worker.activity)), width),
  ];
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
  const clock = setInterval(() => { if (manager.status().some(w => w.state === "working")) update(); }, 1000);
  clock.unref();
  return () => { disposed = true; unsubscribe(); clearInterval(clock); clearTimeout(scheduled); ui.setWidget("pi-subagent", undefined); };
}
