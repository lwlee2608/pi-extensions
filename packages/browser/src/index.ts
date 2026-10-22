import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, join } from "node:path";
import { Bridge, ORIGIN, PORT, type BridgeOptions } from "./bridge.ts";

export function browserExtension(overrides: Partial<BridgeOptions> = {}): (pi: ExtensionAPI) => void {
  return pi => {
    let session: ExtensionContext | undefined;
    const bridge = new Bridge({
      port: PORT,
      origin: ORIGIN,
      secretPath: join(getAgentDir(), "pi-browser", "secret"),
      label: () => `${session?.sessionManager.getSessionName() ?? basename(session?.cwd ?? "pi")} (pid ${process.pid})`,
      onRelease: () => session?.ui.notify("Another pi session took the browser.", "info"),
      ...overrides,
    });

    function use(ctx: ExtensionContext): Bridge {
      if (!ctx.hasUI) throw new Error("The browser needs an interactive pi session.");
      return bridge;
    }

    pi.on("session_start", (_event, ctx) => { session = ctx; });
    pi.on("session_shutdown", () => bridge.close());

    pi.registerCommand("browser", {
      description: "Browser status, or take: move the browser to this session",
      handler: async (args, ctx) => {
        if (args.trim() !== "take") { ctx.ui.notify("Usage: /browser [take]", "warning"); return; }
        try {
          const moved = await use(ctx).take();
          ctx.ui.notify(moved
            ? "This session now owns the browser. Chrome reconnects within about 30s; click the Pi Browser toolbar icon to reconnect now."
            : "This session already owns the browser.", "info");
        } catch (error) {
          ctx.ui.notify((error as Error).message, "warning");
        }
      },
    });
  };
}

export default browserExtension();
