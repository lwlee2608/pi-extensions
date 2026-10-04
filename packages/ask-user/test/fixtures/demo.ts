import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runQuestionnaire } from "../../src/questionnaire.ts";
import type { Params } from "../../src/schema.ts";

export const core: Params = { questions: [
  { question: "Which storage should we use?", options: [{ label: "SQLite" }, { label: "PostgreSQL" }] },
  { question: "Which features should we include?", multiSelect: true, options: [{ label: "Search" }, { label: "Export" }, { label: "Audit" }] },
] };

export default function (pi: ExtensionAPI): void {
  let pending: AbortController | undefined;
  pi.on("session_shutdown", () => pending?.abort());
  pi.registerCommand("ask-user-demo", {
    description: "Offline questionnaire fixture: core, single, cancel",
    async handler(args, ctx) {
      if (!["core", "single", "cancel"].includes(args.trim())) {
        ctx.ui.notify("Use /ask-user-demo core|single|cancel", "warning");
        return;
      }
      if (pending) { ctx.ui.notify("A fixture is already open.", "warning"); return; }
      pending = new AbortController();
      try {
        const params = args.trim() === "single" ? { questions: core.questions.slice(0, 1) } : core;
        const result = await runQuestionnaire(ctx, params, pending.signal);
        pi.sendMessage({ customType: "ask-user-demo", content: JSON.stringify(result), display: true }, { triggerTurn: false });
      } finally { pending = undefined; }
    },
  });
}
