import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderFooter, projectPath, summarize } from "./footer.ts";

export default function (pi: ExtensionAPI): void {
  let started: number | undefined;
  let elapsed = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;
  let dispose: (() => void) | undefined;

  function stopTimer(): void {
    clearInterval(timer);
    timer = undefined;
  }

  function start(): void {
    if (!requestRender || started !== undefined) return;
    started = performance.now();
    elapsed = 0;
    timer = setInterval(() => requestRender?.(), 1000);
    timer.unref();
    requestRender();
  }

  pi.on("session_start", (_event, ctx) => {
    dispose?.();
    started = undefined;
    elapsed = 0;
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(requestRender);
      let disposed = false;
      let leaf: string | null | undefined;
      let totals = summarize([]);
      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        stopTimer();
        started = undefined;
        requestRender = undefined;
        unsubscribe();
      };
      dispose = cleanup;
      if (!ctx.isIdle()) start();
      return {
        dispose: cleanup,
        invalidate() { leaf = undefined; },
        render(width: number): string[] {
          const currentLeaf = ctx.sessionManager.getLeafId();
          if (leaf !== currentLeaf) {
            totals = summarize(ctx.sessionManager.getBranch());
            leaf = currentLeaf;
          }
          return renderFooter({
            model: ctx.model ? `(${ctx.model.provider}) ${ctx.model.id}` : "No model",
            thinking: pi.getThinkingLevel(),
            context: ctx.getContextUsage() ?? {
              tokens: 0, percent: 0, contextWindow: ctx.model?.contextWindow ?? 0,
            },
            totals,
            elapsed: started === undefined ? elapsed : performance.now() - started,
            cwd: projectPath(ctx.cwd, homedir()),
            branch: footerData.getGitBranch(),
            statuses: [...footerData.getExtensionStatuses().values()],
          }, width, theme);
        },
      };
    });
  });
  pi.on("agent_start", start);
  pi.on("agent_settled", () => {
    if (started !== undefined) elapsed = performance.now() - started;
    started = undefined;
    stopTimer();
    requestRender?.();
  });
  pi.on("session_tree", () => {
    elapsed = 0;
    requestRender?.();
  });
  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = undefined;
  });
}
