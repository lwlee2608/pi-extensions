import type { Snapshot, WaitResult } from "./manager.ts";
import { display } from "./panel.ts";

function brief({ output, toolOutput: _, questions, result, ...view }: Snapshot): object {
  const pending = questions?.filter(q => q.state === "pending");
  if (!result) return { ...view, output, questions: pending };
  const { text: _text, ...summary } = result;
  return { ...view, result: summary, questions: pending };
}
export function modelView(action: string, result: unknown): unknown {
  if (action === "status") return (result as Snapshot[]).map(brief);
  if (action === "wait") return { ...(result as WaitResult), workers: (result as WaitResult).workers.map(brief) };
  if (action === "reply") return result;
  return brief(result as Snapshot);
}

export function resultText(result: { details?: unknown; content: { type: string; text?: string }[] }, expanded: boolean, isError: boolean): string {
  const details = result.details as { workerId?: string; runId?: string; state?: string; reason?: string; pendingQuestionIds?: string[]; questionId?: string; runs?: { result?: { outcome: string } }[] } | undefined;
  const content = result.content.filter(c => c.type === "text").map(c => c.text ?? "");
  const recognized = !!(details?.workerId || details?.reason || details?.questionId || Array.isArray(details));
  if (isError || !recognized) return content.map(display).join("\n") || "Subagent result unavailable";
  const failures = details?.runs?.filter(run => run.result && run.result.outcome !== "completed").map(run => run.result!.outcome);
  const summary = details?.reason ? `Wait: ${details.reason}${failures?.length ? ` · ${failures.length} failed/interrupted run(s)` : ""}${details.pendingQuestionIds?.length ? ` · ${details.pendingQuestionIds.length} question(s)` : ""}`
    : details?.workerId ? `${details.workerId} · ${details.state ?? "accepted"} · ${details.runId ?? ""}`
    : details?.questionId ? `Question ${details.questionId} · acknowledged` : `${(details as unknown[]).length} worker(s)`;
  const text = expanded ? JSON.stringify(result.details, null, 2).split("\n").map(display).join("\n") : display(summary);
  const warnings = content.slice(1).map(display);
  return [text, ...warnings].join("\n");
}
