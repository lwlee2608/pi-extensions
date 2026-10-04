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

export const limits: Params = { questions: Array.from({ length: 8 }, (_, i) => ({
  question: `Question ${i + 1}: choose an option from a maximum-size questionnaire with Unicode 界 labels.`,
  header: `Long navigation header ${i + 1} — 界`,
  multiSelect: i % 2 === 1,
  options: Array.from({ length: 8 }, (_, j) => ({
    label: `Option ${j + 1} — 界`,
    description: "A long description that wraps at narrow widths. ".repeat(4),
    preview: `# Option ${j + 1}\n\n` + "Preview detail with Unicode 界.\n".repeat(30),
  })),
})) };

export default function (pi: ExtensionAPI): void {
  let pending: AbortController | undefined;
  pi.on("session_shutdown", () => pending?.abort());
  pi.registerCommand("ask-user-demo", {
    description: "Offline questionnaire fixture: core, single, cancel, rich, limits",
    async handler(args, ctx) {
      if (!["core", "single", "cancel", "rich", "limits"].includes(args.trim())) {
        ctx.ui.notify("Use /ask-user-demo core|single|cancel|rich|limits", "warning");
        return;
      }
      if (pending) { ctx.ui.notify("A fixture is already open.", "warning"); return; }
      pending = new AbortController();
      try {
        const params = args.trim() === "limits" ? limits : args.trim() === "rich" ? rich : args.trim() === "single" ? { questions: core.questions.slice(0, 1) } : core;
        const result = await runQuestionnaire(ctx, params, pending.signal);
        pi.sendMessage({ customType: "ask-user-demo", content: JSON.stringify(result), display: true }, { triggerTurn: false });
      } finally { pending = undefined; }
    },
  });
}
