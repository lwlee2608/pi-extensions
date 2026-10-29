import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getAgentDir, truncateHead, truncateTail, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Approvals, confirmEval, hostOf, parse, type Choice } from "./approval.ts";
import { loadConfirmEval, setConfirmEval } from "./config.ts";
import { Bridge, listenSocket, type BridgeOptions } from "./bridge.ts";
import { detectBrowserDirs, installHost } from "./install.ts";

const CHROME_DIR = fileURLToPath(new URL("../chrome/", import.meta.url));

const parameters = Type.Object({
  action: Type.Union(["tabs", "navigate", "read", "click", "type", "keys", "scroll", "screenshot", "console", "network", "eval"].map(action => Type.Literal(action))),
  url: Type.Optional(Type.String({ description: "navigate: http or https URL to load" })),
  tabId: Type.Optional(Type.Number({ description: "Pi tab to act on; defaults to the current pi tab" })),
  newTab: Type.Optional(Type.Boolean({ description: "navigate: open the URL in a new pi tab" })),
  ref: Type.Optional(Type.Number({ description: "click, type: element ref, the n in [n] from read. keys: focus this ref first. scroll: ref to bring into view" })),
  point: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2, description: "click: [x, y] in pixels of the tab's last screenshot, instead of a ref" })),
  button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")], { description: "click: mouse button; left by default" })),
  clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "click: 2 for a double click, 3 for a triple click; 1 by default" })),
  text: Type.Optional(Type.String({ description: "type: text to insert at the cursor of the ref, or of the focused element when no ref is given" })),
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

interface Status {
  browser: string;
  group?: { title: string; color: string };
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
  return [...(lines.length ? lines : ["No pi tabs are open."]), `${others} other tabs are not in your group.`].join("\n");
}

export function given<T extends object>(params: T): T {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== 0 && value !== "" && !(Array.isArray(value) && !value.length))) as T;
}

let screenshots: Promise<string> | undefined;

async function saveScreenshot(data: string, tabId: number): Promise<string> {
  screenshots ??= mkdtemp(join(tmpdir(), "pi-browser-"));
  const file = join(await screenshots, `${tabId}-${Date.now()}.jpg`);
  await writeFile(file, Buffer.from(data, "base64"));
  return file;
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

export function browserExtension({ browserDirs, platform = process.platform, ...overrides }: Partial<BridgeOptions> & { browserDirs?: string[]; platform?: NodeJS.Platform } = {}): (pi: ExtensionAPI) => void {
  return pi => {
    let session: ExtensionContext | undefined;
    let used = false;
    const configPath = join(getAgentDir(), "pi-browser", "config.json");
    const approvals = new Approvals(configPath);
    const sessions = join(getAgentDir(), "pi-browser", "sessions");
    const bridge = new Bridge({
      transport: async handlers => {
        await installHost(browserDirs ?? detectBrowserDirs(), sessions);
        return listenSocket(join(sessions, `${session!.sessionManager.getSessionId()}.sock`), handlers);
      },
      name: () => session!.sessionManager.getSessionName() ?? basename(session!.cwd),
      onStop: () => {
        session?.abort();
        session?.ui.notify("Stopped from Chrome.", "info");
      },
      ...overrides,
    });

    function use(ctx: ExtensionContext): Bridge {
      if (!ctx.hasUI) throw new Error("The browser needs an interactive pi session.");
      if (platform === "win32") throw new Error("The browser is not supported on Windows until the port transport lands (https://github.com/lwlee2608/pi-extensions/issues/43).");
      return bridge;
    }

    async function status(bridge: Bridge): Promise<string> {
      const lines = [`Chrome extension folder: ${CHROME_DIR}`];
      const error = await bridge.listen().then(() => bridge.mismatch, (error: Error) => error);
      if (error) return [...lines, error.message].join("\n");
      if (!bridge.connected) return [...lines, "Chrome: not connected. Click the Pi Browser toolbar icon in Chrome to reconnect; its tooltip says why if it cannot start pi's native host. After an update, reload Pi Browser in chrome://extensions. If it is not installed, load the folder unpacked in chrome://extensions. Snap and Flatpak browsers are not supported."].join("\n");
      const info = await bridge.call("status", {}).catch((error: Error) => error);
      if (info instanceof Error) return [...lines, `Chrome: connected, but its status failed: ${info.message}`].join("\n");
      const { browser, group } = info as Status;
      lines.push(`Connected browser: ${browser}`, group ? `Your group: ${group.title} (${group.color})` : "Your group: none yet; it opens on the agent's first navigate.");
      lines.push("Change eval and site approvals with /browser settings.");
      return lines.join("\n");
    }

    const hideWithoutUI = (_event: unknown, ctx: ExtensionContext) => {
      if (ctx.hasUI) return;
      const active = pi.getActiveTools();
      if (active.includes("browser")) pi.setActiveTools(active.filter(name => name !== "browser"));
    };
    pi.on("session_start", (event, ctx) => { session = ctx; approvals.reset(); hideWithoutUI(event, ctx); });
    pi.on("before_agent_start", hideWithoutUI);
    pi.on("agent_end", () => {
      if (used && bridge.connected) bridge.call("idle", {}).catch(() => {});
      used = false;
    });
    pi.on("session_shutdown", () => bridge.close());

    pi.registerTool({
      name: "browser",
      label: "Browser",
      description: "Drive the user's Chrome, only in tabs of your own pi tab group. Actions: tabs lists the tabs in your group (other tabs are only counted; "
        + "a tab on a host the user has not approved shows only its host; a non-http(s) tab shows only its scheme and is refused until navigated); "
        + "navigate loads an http/https URL in the current pi tab, or a new one with newTab; read returns the page as an accessibility tree "
        + "where [n] marks an element ref. click, type, and keys act on a ref with real input events; scroll brings a ref into view; "
        + "screenshot returns a JPEG of the tab, bringing it to the front of its window, and saves it to a file whose path it gives. console and network list the tab's console messages "
        + "and requests (method, status, type, URL) since its page loaded, newest last; when the debugger attached after the page loaded, network says so and only a reload shows every request. eval runs code in the page and returns its JSON value; "
        + "eval runs on approved hosts without asking unless the user turned on eval confirmation, which shows them the code. Refs go stale when the page navigates; "
        + "read again. Actions do not wait for a page they trigger to load; read to see the result. The user approves each new host; "
        + "if they deny one, or decline an eval, the call fails and you should not retry it. "
        + `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
      parameters,
      executionMode: "sequential",
      async execute(_id, { action, ...raw }, signal, _update, ctx) {
        const params = given(raw);
        const bridge = use(ctx);
        used = true;
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
            await confirmEval(params.code, host, (title, options) => ctx.ui.select(title, options, { signal }), configPath);
            Object.assign(params, { host });
          }
        }
        const page = await bridge.call(action, params, signal) as { url: string; text: string; data?: string };
        await approve(loaded(page.url));
        if (page.data) {
          const file = await saveScreenshot(page.data, params.tabId!);
          return { content: [{ type: "text" as const, text: `${page.text} Saved to ${file}` }, { type: "image" as const, data: page.data, mimeType: "image/jpeg" }], details: undefined };
        }
        return { content: [{ type: "text" as const, text: truncate(page.text, action === "console" || action === "network") }], details: undefined };
      },
    });

    async function settings(ctx: ExtensionContext): Promise<string | undefined> {
      const confirm = await loadConfirmEval(configPath);
      const hosts = await approvals.hosts();
      const toggle = `Ask before eval: ${confirm ? "on" : "off"}`;
      const remove = "Remove an approved site";
      const forget = `Forget all approved sites (${hosts.length})`;
      const choice = await ctx.ui.select("Browser settings", hosts.length ? [toggle, remove, forget] : [toggle]);
      if (choice === toggle) {
        await setConfirmEval(configPath, !confirm);
        return confirm ? "Eval now runs without asking on approved sites." : "Eval now asks before running.";
      }
      if (choice === remove) {
        const host = await ctx.ui.select("Remove which site?", hosts);
        if (!host) return;
        await approvals.forget(host);
        return `Removed ${host}; the agent asks before using it again.`;
      }
      if (choice === forget) {
        await approvals.forget();
        return "Forgot all approved sites; the agent asks before using each one again.";
      }
    }

    pi.registerCommand("browser", {
      description: "Browser status; /browser settings to change approvals",
      handler: async (args, ctx) => {
        const sub = args.trim();
        if (sub !== "" && sub !== "settings") { ctx.ui.notify("Usage: /browser [settings]", "warning"); return; }
        try {
          const text = sub === "settings" ? await settings(ctx) : await status(use(ctx));
          if (text) ctx.ui.notify(text, "info");
        } catch (error) {
          ctx.ui.notify((error as Error).message, "warning");
        }
      },
    });
  };
}

export default browserExtension();
