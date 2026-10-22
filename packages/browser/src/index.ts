import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getAgentDir, truncateHead, truncateTail, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Approvals, confirmEval, hostOf, parse, type Choice } from "./approval.ts";
import { Bridge, ORIGIN, PORT, type BridgeOptions } from "./bridge.ts";

const CHROME_DIR = fileURLToPath(new URL("../chrome/", import.meta.url));

const parameters = Type.Object({
  action: Type.Union(["tabs", "navigate", "read", "click", "type", "keys", "scroll", "screenshot", "console", "network", "eval"].map(action => Type.Literal(action))),
  url: Type.Optional(Type.String({ description: "navigate: http or https URL to load" })),
  tabId: Type.Optional(Type.Number({ description: "Pi tab to act on; defaults to the current pi tab" })),
  newTab: Type.Optional(Type.Boolean({ description: "navigate: open the URL in a new pi tab" })),
  ref: Type.Optional(Type.Number({ description: "click, type: element ref, the n in [n] from read. keys: focus this ref first. scroll: ref to bring into view" })),
  text: Type.Optional(Type.String({ description: "type: text to insert at the cursor of the ref" })),
  code: Type.Optional(Type.String({ description: "eval: JavaScript to run in the page's main frame, like the DevTools console: statements, top-level await, and const or let that may repeat across calls are allowed; the last expression's value is returned and a promise is awaited. At most 20 lines and 1500 characters, no two blank lines in a row, and no invisible or control characters other than newline and tab" })),
  keys: Type.Optional(Type.String({ description: "keys: space-separated keys or combos, like \"Enter\" or \"Shift+Tab\"; editing shortcuts use Meta on macOS and Control elsewhere, like \"Meta+a\" or \"Control+a\" to select all" })),
});

function checkUrl(url: string | undefined): void {
  if (!url) throw new Error("navigate needs a url.");
  const { protocol } = parse(url);
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

export async function listTabs({ tabs, others }: TabList, allowed: (url: string) => Promise<boolean>): Promise<string> {
  const lines = await Promise.all(tabs.map(async tab => {
    const host = tab.url && hostOf(tab.url);
    const page = !tab.url ? "(loading)" : !host ? `(${parse(tab.url).protocol} page)`
      : await allowed(tab.url) ? `${tab.title || "(untitled)"} <${tab.url}>` : `(unapproved host ${host})`;
    return `Tab ${tab.id}: ${page}${tab.current ? " (current)" : ""}`;
  }));
  return [...(lines.length ? lines : ["No pi tabs are open."]), `${others} other tabs are not in the pi group.`].join("\n");
}

function loaded(url: string): string {
  if (!url) throw new Error("The pi tab has not loaded a page yet; try again in a moment.");
  return url;
}

export function truncate(text: string, tail = false): string {
  const result = (tail ? truncateTail : truncateHead)(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!result.truncated) return text;
  if (result.firstLineExceedsLimit) {
    const line = Buffer.from(text.split("\n", 1)[0]);
    const content = line.subarray(0, DEFAULT_MAX_BYTES).toString().replace(/�$/, "");
    return `${content}\n\n[Output truncated: showing the first ${formatSize(DEFAULT_MAX_BYTES)} of line 1 (${formatSize(line.length)}) of ${result.totalLines} lines.]`;
  }
  const note = `[Output truncated: showing the ${tail ? "last" : "first"} ${result.outputLines} of ${result.totalLines} lines (${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}).]`;
  return tail ? `${note}\n\n${result.content}` : `${result.content}\n\n${note}`;
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
        + "a tab on a host the user has not approved shows only its host; a non-http(s) tab shows only its scheme and is refused until navigated); "
        + "navigate loads an http/https URL in the current pi tab, or a new one with newTab; read returns the page as an accessibility tree "
        + "where [n] marks an element ref. click, type, and keys act on a ref with real input events; scroll brings a ref into view; "
        + "screenshot returns a JPEG of the tab, bringing it to the front of its window. console and network list the tab's console messages "
        + "and requests (method, status, type, URL) since its page loaded, newest last; when the debugger attached after the page loaded, network says so and only a reload shows every request. eval runs code in the page and returns its JSON value; "
        + "the user confirms every eval with the code shown. Refs go stale when the page navigates; "
        + "read again. Actions do not wait for a page they trigger to load; read to see the result. The user approves each new host; "
        + "if they deny one, or decline an eval, the call fails and you should not retry it. "
        + `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
      parameters,
      executionMode: "sequential",
      async execute(_id, { action, ...params }, signal, _update, ctx) {
        const bridge = use(ctx);
        const granted = new Set<string>();
        const approve = (url: string) => approvals.approve(url, host => ask(ctx, host, signal), granted);
        if (action === "tabs") {
          const text = await listTabs(await bridge.call(action, {}, signal) as TabList, url => approvals.allowed(url, granted));
          return { content: [{ type: "text", text: truncate(text) }], details: undefined };
        }
        if (action === "navigate") {
          checkUrl(params.url);
          await approve(params.url!);
        } else {
          const tab = await bridge.call("tab", { tabId: params.tabId }, signal) as { id: number; url: string };
          await approve(loaded(tab.url));
          params.tabId = tab.id;
          if (action === "eval") {
            const host = hostOf(tab.url)!;
            await confirmEval(params.code, host, (title, options) => ctx.ui.select(title, options, { signal }));
            Object.assign(params, { host });
          }
        }
        const page = await bridge.call(action, params, signal) as { url: string; text: string; data?: string };
        await approve(loaded(page.url));
        const image = page.data ? [{ type: "image" as const, data: page.data, mimeType: "image/jpeg" }] : [];
        const text = truncate(page.text, action === "console" || action === "network");
        return { content: [{ type: "text" as const, text }, ...image], details: undefined };
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
