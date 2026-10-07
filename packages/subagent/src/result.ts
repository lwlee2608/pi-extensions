import { display } from "./panel.ts";

export function resultText(result: { details?: unknown; content: { type: string; text?: string }[] }, expanded: boolean, isError: boolean): string {
  const details = result.details as { workerId?: string; runId?: string; state?: string; reason?: string; pendingQuestionIds?: string[]; questionId?: string } | undefined;
  const content = result.content.filter(c => c.type === "text").map(c => c.text ?? "");
  const recognized = !!(details?.workerId || details?.reason || details?.questionId || Array.isArray(details));
  if (isError || !recognized) return content.map(display).join("\n") || "Subagent result unavailable";
  const summary = details?.reason ? `Wait: ${details.reason}${details.pendingQuestionIds?.length ? ` · ${details.pendingQuestionIds.length} question(s)` : ""}`
    : details?.workerId ? `${details.workerId} · ${details.state ?? "accepted"} · ${details.runId ?? ""}`
    : details?.questionId ? `Question ${details.questionId} · acknowledged` : `${(details as unknown[]).length} worker(s)`;
  const text = expanded ? JSON.stringify(result.details, null, 2).split("\n").map(display).join("\n") : display(summary);
  const warnings = content.filter(part => part !== JSON.stringify(result.details)).map(display);
  return [text, ...warnings].join("\n");
}
