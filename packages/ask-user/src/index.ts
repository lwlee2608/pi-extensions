import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { display } from "./display.ts";
import { runQuestionnaire } from "./questionnaire.ts";
import { description, parameters } from "./schema.ts";
import { modelText, usageLabel, type Result } from "./result.ts";
import type { Request } from "./explain.ts";

export default function (pi: ExtensionAPI): void {
  const pending = new Set<AbortController>();
  let lastRequest: Request | undefined;
  pi.on("context_with_system", event => { lastRequest = event.messages; });
  const excludeOutsideTerminal = (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      const active = pi.getActiveTools();
      if (active.includes("ask_user_question")) pi.setActiveTools(active.filter(name => name !== "ask_user_question"));
    }
  };
  pi.on("session_start", (event, ctx) => { lastRequest = undefined; excludeOutsideTerminal(event, ctx); });
  pi.on("before_agent_start", excludeOutsideTerminal);
  pi.on("session_shutdown", () => {
    for (const controller of pending) controller.abort();
    pending.clear();
  });
  pi.registerTool<typeof parameters, Result>({
    name: "ask_user_question", label: "Ask user", description, parameters,
    exposure: "model-only", executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      const controller = new AbortController();
      pending.add(controller);
      try {
        const result = await runQuestionnaire(ctx, params, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, () => lastRequest);
        return { content: [{ type: "text", text: modelText(result) }], details: result };
      } finally { pending.delete(controller); }
    },
    renderCall(args, theme) {
      const count = args.questions?.length ?? 0;
      return new Text(theme.fg("toolTitle", `Ask user · ${count} question${count === 1 ? "" : "s"}`), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const details = result.details;
      if (!details) return new Text(display(result.content.filter(item => item.type === "text").map(item => item.text).join("\n")), 0, 0);
      if (details.cancelled) return new Text(theme.fg("warning", "Questionnaire cancelled"), 0, 0);
      const lines = details.answers.map(answer => {
        const question = context?.args?.questions?.[answer.questionIndex - 1]?.question;
        const label = question ? `${display(question)} ${theme.fg("muted", "→")}` : `${answer.questionIndex}.`;
        const value = theme.fg("accent", display([...answer.selected, answer.custom].filter(Boolean).join("; ")));
        const note = answer.notes ? `\n  ${theme.fg("muted", `Note: ${display(answer.notes)}`)}` : "";
        const explained = answer.explanationUsage ? `\n  ${theme.fg("dim", `Explained · ${usageLabel(answer.explanationUsage)}`)}` : "";
        return `${theme.fg("muted", "·")} ${label} ${value}${note}${explained}`;
      });
      if (details.globalNote) lines.push(`Global note: ${display(details.globalNote)}`);
      if (details.chat) lines.unshift(theme.fg("warning", "User wants to chat about this"));
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
