import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getAgentDir, truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { Bridge, ORIGIN, PORT, type BridgeOptions } from "./bridge.ts";

const parameters = Type.Object({
  action: Type.Union([Type.Literal("tabs"), Type.Literal("navigate"), Type.Literal("read")]),
  url: Type.Optional(Type.String({ description: "navigate: http or https URL to load" })),
  tabId: Type.Optional(Type.Number({ description: "Pi tab to act on; defaults to the current pi tab" })),
  newTab: Type.Optional(Type.Boolean({ description: "navigate: open the URL in a new pi tab" })),
});

function checkUrl(url: string | undefined): void {
  if (!url) throw new Error("navigate needs a url.");
  let protocol: string;
  try { protocol = new URL(url).protocol; } catch { throw new Error(`Invalid URL: ${url}`); }
  if (protocol !== "http:" && protocol !== "https:") throw new Error(`navigate only opens http and https URLs, not ${protocol}`);
}

function truncate(text: string): string {
  const result = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!result.truncated) return text;
  return `${result.content}\n\n[Output truncated: showing ${result.outputLines} of ${result.totalLines} lines (${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}).]`;
}

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

    pi.registerTool({
      name: "browser",
      label: "Browser",
      description: "Drive the user's Chrome, only in tabs of its \"pi\" tab group. Actions: tabs lists pi tabs (other tabs are only counted); "
        + "navigate loads an http/https URL in the current pi tab, or a new one with newTab; read returns the page as an accessibility tree "
        + `where [n] marks an element ref. Refs go stale when the page navigates; read again. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
      parameters,
      executionMode: "sequential",
      async execute(_id, { action, url, tabId, newTab }, signal, _update, ctx) {
        const bridge = use(ctx);
        if (action === "navigate") checkUrl(url);
        const text = String(await bridge.call(action, { url, tabId, newTab }, signal));
        return { content: [{ type: "text", text: truncate(text) }], details: undefined };
      },
    });

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
