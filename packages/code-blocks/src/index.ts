import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installPatch } from "./patch.ts";

export default function (pi: ExtensionAPI): void {
  let dispose: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    dispose?.();
    dispose = undefined;
    if (ctx.mode !== "tui") return;
    try {
      dispose = installPatch(text => ctx.ui.theme.fg("accent", text));
    } catch (error) {
      ctx.ui.notify(`Code blocks: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });
  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = undefined;
  });
}
