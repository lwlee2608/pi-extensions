import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runQuestionnaire } from "../../src/questionnaire.ts";
import type { Params } from "../../src/schema.ts";

export const core: Params = { questions: [
  { question: "Which storage should we use?", options: [{ label: "SQLite" }, { label: "PostgreSQL" }] },
  { question: "Which features should we include?", multiSelect: true, options: [{ label: "Search" }, { label: "Export" }, { label: "Audit" }] },
] };

export const rich: Params = { questions: core.questions.map((question, i) => ({
  ...question,
  header: i === 0 ? "Storage" : "Features",
  options: question.options.map((option, j) => ({
    ...option,
    preview: j === 0
      ? `# ${option.label}\n\n\`\`\`yaml\nfeature: ${option.label.toLowerCase()}\nenabled: true\n\`\`\`\n\n` + Array.from({ length: 40 }, (_, line) => `- Detail ${line + 1}: Unicode 界 and operational considerations.`).join("\n")
      : `# ${option.label}\n\n\`\`\`ts\nconst enabled = true;\n\`\`\`\n\nA simpler alternative.`,
  })),
})) };

export default function (pi: ExtensionAPI): void {
  let pending: AbortController | undefined;
  pi.on("session_shutdown", () => pending?.abort());
  pi.registerCommand("ask-user-demo", {
    description: "Offline questionnaire fixture: core, single, cancel, rich",
    async handler(args, ctx) {
      if (!["core", "single", "cancel", "rich"].includes(args.trim())) {
        ctx.ui.notify("Use /ask-user-demo core|single|cancel|rich", "warning");
        return;
      }
      if (pending) { ctx.ui.notify("A fixture is already open.", "warning"); return; }
      pending = new AbortController();
      try {
        const params = args.trim() === "rich" ? rich : args.trim() === "single" ? { questions: core.questions.slice(0, 1) } : core;
        const result = await runQuestionnaire(ctx, params, pending.signal);
        pi.sendMessage({ customType: "ask-user-demo", content: JSON.stringify(result), display: true }, { triggerTurn: false });
      } finally { pending = undefined; }
    },
  });
}
