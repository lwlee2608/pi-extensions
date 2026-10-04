import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { runQuestionnaire } from "./questionnaire.ts";
import { description, parameters } from "./schema.ts";
import type { Result } from "./result.ts";

export default function (pi: ExtensionAPI): void {
  const pending = new Set<AbortController>();
  const excludeOutsideTerminal = (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      const active = pi.getActiveTools();
      if (active.includes("ask_user_question")) pi.setActiveTools(active.filter(name => name !== "ask_user_question"));
    }
  };
  pi.on("session_start", excludeOutsideTerminal);
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
        const result = await runQuestionnaire(ctx, params, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } finally { pending.delete(controller); }
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `Ask user · ${args.questions?.length ?? 0} questions`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details;
      if (!details) return new Text(result.content.filter(item => item.type === "text").map(item => item.text).join("\n"), 0, 0);
      if (details.cancelled) return new Text(theme.fg("warning", "Questionnaire cancelled"), 0, 0);
      return new Text(details.answers.map(answer => `${answer.questionIndex}. ${[...answer.selected, answer.custom].filter(Boolean).join("; ")}`).join("\n"), 0, 0);
    },
  });
}
