import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getAgentDir, truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Approvals, hostOf, type Choice } from "./approval.ts";
import { Bridge, ORIGIN, PORT, type BridgeOptions } from "./bridge.ts";

const CHROME_DIR = fileURLToPath(new URL("../chrome/", import.meta.url));

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

const CHOICES: Record<string, Choice> = { "Allow once": "once", "Allow for this session": "session", "Always allow": "always", Deny: "deny" };

async function ask(ctx: ExtensionContext, host: string, signal?: AbortSignal): Promise<Choice> {
  const answer = await ctx.ui.select(`Let the agent use ${host} in Chrome?`, Object.keys(CHOICES), { signal });
  return (answer && CHOICES[answer]) || "deny";
}

interface TabList {
  tabs: { id: number; title: string; url: string; current: boolean }[];
  others: number;
}

async function listTabs({ tabs, others }: TabList, allowed: (url: string) => Promise<boolean>): Promise<string> {
  const lines = await Promise.all(tabs.map(async tab => {
    const page = await allowed(tab.url) ? `${tab.title || "(untitled)"} <${tab.url}>` : `(unapproved host ${hostOf(tab.url)})`;
    return `Tab ${tab.id}: ${page}${tab.current ? " (current)" : ""}`;
  }));
  return [...(lines.length ? lines : ["No pi tabs are open."]), `${others} other tabs are not in the pi group.`].join("\n");
}

function truncate(text: string): string {
  const result = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!result.truncated) return text;
  return `${result.content}\n\n[Output truncated: showing ${result.outputLines} of ${result.totalLines} lines (${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}).]`;
}

export function browserExtension(overrides: Partial<BridgeOptions> = {}): (pi: ExtensionAPI) => void {
  return pi => {
    let session: ExtensionContext | undefined;
    const approvals = new Approvals(join(getAgentDir(), "pi-browser", "config.json"));
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

    async function status(bridge: Bridge): Promise<string> {
      const lines = [`Chrome extension folder: ${CHROME_DIR}`];
      const error = await bridge.listen().catch((error: Error) => error);
      const owner = error ? await bridge.owner() : { label: "this session", connected: bridge.connected };
      if (!owner) return [...lines, (error as Error).message].join("\n");
      lines.push(`Owner: ${owner.label}${error ? ". Run /browser take to move it here." : ""}`);
      lines.push(owner.connected ? "Chrome: connected" : "Chrome: not connected. Load the folder unpacked in chrome://extensions, then click the Pi Browser toolbar icon.");
      return lines.join("\n");
    }

    const hideWithoutUI = (_event: unknown, ctx: ExtensionContext) => {
      if (ctx.hasUI) return;
      const active = pi.getActiveTools();
      if (active.includes("browser")) pi.setActiveTools(active.filter(name => name !== "browser"));
    };
    pi.on("session_start", (event, ctx) => { session = ctx; approvals.reset(); hideWithoutUI(event, ctx); });
    pi.on("before_agent_start", hideWithoutUI);
    pi.on("session_shutdown", () => bridge.close());

    pi.registerTool({
      name: "browser",
      label: "Browser",
      description: "Drive the user's Chrome, only in tabs of its \"pi\" tab group. Actions: tabs lists pi tabs (other tabs are only counted; "
        + "a tab on a host the user has not approved shows only its host); "
        + "navigate loads an http/https URL in the current pi tab, or a new one with newTab; read returns the page as an accessibility tree "
        + "where [n] marks an element ref. Refs go stale when the page navigates; read again. The user approves each new host; "
        + "if they deny one, the call fails and you should not retry it. "
        + `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
      parameters,
      executionMode: "sequential",
      async execute(_id, { action, url, tabId, newTab }, signal, _update, ctx) {
        const bridge = use(ctx);
        const granted = new Set<string>();
        const approve = (url: string) => approvals.approve(url, host => ask(ctx, host, signal), granted);
        let text: string;
        if (action === "tabs") {
          text = await listTabs(await bridge.call(action, {}, signal) as TabList, url => approvals.allowed(url, granted));
        } else {
          if (action === "navigate") {
            checkUrl(url);
            await approve(url!);
          } else {
            const tab = await bridge.call("tab", { tabId }, signal) as { id: number; url: string };
            await approve(tab.url);
            tabId = tab.id;
          }
          const page = await bridge.call(action, { url, tabId, newTab }, signal) as { url: string; text: string };
          await approve(page.url);
          text = page.text;
        }
        return { content: [{ type: "text", text: truncate(text) }], details: undefined };
      },
    });

    pi.registerCommand("browser", {
      description: "Browser status, or take: move the browser to this session",
      handler: async (args, ctx) => {
        const command = args.trim();
        if (command !== "" && command !== "take") { ctx.ui.notify("Usage: /browser [take]", "warning"); return; }
        try {
          if (command === "take") {
            const moved = await use(ctx).take();
            ctx.ui.notify(moved
              ? "This session now owns the browser. Chrome reconnects within about 30s; click the Pi Browser toolbar icon to reconnect now."
              : "This session already owns the browser.", "info");
          } else {
            ctx.ui.notify(await status(use(ctx)), "info");
          }
        } catch (error) {
          ctx.ui.notify((error as Error).message, "warning");
        }
      },
    });
  };
}

export default browserExtension();
