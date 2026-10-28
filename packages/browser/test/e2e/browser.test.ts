import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, readlink, rename, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { browserExtension } from "../../src/index.ts";
import { launchChrome } from "./chrome.ts";
import { copyExtension } from "./extension.ts";

const EXTENSION = "chrome-extension://enidoebkpjligpdgedlellobooiiljib/";
const fixtures = fileURLToPath(new URL("fixtures/", import.meta.url));
const intruder = fileURLToPath(new URL("intruder/", import.meta.url));
// macOS TMPDIR is too long for the session socket path limit.
const work = await mkdtemp("/tmp/pi-browser-e2e-");

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

const fixtureServer = createServer(async (req, res) => {
  if (req.url!.startsWith("/redirect?to=")) { res.writeHead(302, { location: decodeURIComponent(req.url!.slice(13)) }).end(); return; }
  if (req.url === "/stall") return;
  if (req.url === "/api/data") {
    const status = req.headers.authorization === "Bearer fixture-secret-token" ? 201 : 401;
    res.writeHead(status, { "set-cookie": "session=fixture-secret-cookie", "x-fixture": "fixture-secret-header" }).end("fixture-secret-body");
    return;
  }
  if (req.url === "/hang") { res.writeHead(200, { "content-type": "text/html" }).write("<title>Hanging</title><h1>Never finishes</h1>"); return; }
  const body = await readFile(join(fixtures, new URL(req.url!, "http://x").pathname)).catch(() => undefined);
  if (body) res.writeHead(200, { "content-type": "text/html" }).end(body);
  else res.writeHead(404).end();
});
const site = `http://127.0.0.1:${await listen(fixtureServer)}/`;

process.env.PI_CODING_AGENT_DIR = join(work, "agent");
const configPath = join(work, "agent", "pi-browser", "config.json");
const sessions = join(work, "agent", "pi-browser", "sessions");
const profile = join(work, "profile");
const options = { browserDirs: [profile], connectTimeout: 10_000, callTimeout: 10_000 };

const stopped: string[] = [];

function session(id = "e2e", name = id, overrides = {}) {
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const tools = new Map<string, any>();
  const asked: string[] = [];
  const confirmed: string[][] = [];
  const answers: (string | boolean)[] = [];
  const notes: string[] = [];
  let command: (args: string, ctx: ExtensionContext) => Promise<void>;
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
    getActiveTools: () => [...tools.keys()],
    setActiveTools: () => {},
  } as unknown as ExtensionAPI;
  const select = async (title: string, options: string[]) => {
    const answer = answers.shift();
    if (title.startsWith("Run this JavaScript")) {
      confirmed.push([title, ...options]);
      if (typeof answer !== "boolean") throw new Error(`Unexpected eval prompt: ${title}`);
      return answer ? options[0] : options.at(-1);
    }
    asked.push(title.match(/use (\S+) in Chrome/)![1]);
    if (typeof answer !== "string") throw new Error(`Unexpected prompt: ${title}`);
    return answer;
  };
  const ctx = { hasUI: true, cwd: work, abort: () => { stopped.push(id); }, ui: { notify: (text: string) => notes.push(text), select }, sessionManager: { getSessionId: () => id, getSessionName: () => name } } as unknown as ExtensionContext;
  const emit = (event: string) => { for (const handler of handlers.get(event) ?? []) handler({}, ctx); };
  browserExtension({ ...options, ...overrides })(pi);
  emit("session_start");
  const call = async (params: object, ...replies: (string | boolean)[]): Promise<{ content: any[] }> => {
    answers.push(...replies);
    try {
      return await tools.get("browser").execute("call", params, undefined, () => {}, ctx);
    } finally {
      assert.deepEqual(answers.splice(0), [], "every queued answer was asked for");
    }
  };
  const browser = async (params: object, ...replies: (string | boolean)[]): Promise<string> => (await call(params, ...replies)).content[0].text;
  const status = async () => { await command("", ctx); return notes.splice(0).join("\n"); };
  return { asked, confirmed, emit, call, browser, status, rename: (next: string) => { name = next; } };
}

let { asked, confirmed, emit, call, browser } = session();
const host = new URL(site).hostname;
const at = (name: string, path = "other.html") => `http://${name}.test:${new URL(site).port}/${path}`;

const settings = { RECONNECT_MS: 100, RECONNECT_MAX_MS: 200, NAVIGATE_WAIT_MS: 300 };
const extensionDir = await copyExtension(join(work, "extension"), settings);
const chrome = await launchChrome([extensionDir, intruder], profile);
const { cdp } = chrome;
await cdp.send("Target.setDiscoverTargets", { discover: true });

test.after(async () => {
  emit("session_shutdown");
  second.emit("session_shutdown");
  await chrome.close();
  fixtureServer.closeAllConnections();
  fixtureServer.close();
  await rm(work, { recursive: true, force: true, maxRetries: 10 });
});

async function target(match: (info: any) => boolean): Promise<any> {
  const created = cdp.waitFor("Target.targetCreated", ({ targetInfo }) => match(targetInfo));
  return (await cdp.send("Target.getTargets")).targetInfos.find(match) ?? (await created).targetInfo;
}

const isWorker = (info: any) => info.type === "service_worker" && info.url.startsWith(EXTENSION);

async function inWorker(expression: string): Promise<any> {
  const { targetId } = await target(isWorker);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId });
  }
}

async function onPage<T>(url: string, run: (sessionId: string) => Promise<T>): Promise<T> {
  const { targetId } = await target(info => info.type === "page" && info.url === url);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    return await run(sessionId);
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId });
  }
}

async function inPage(url: string, expression: string): Promise<any> {
  return onPage(url, async sessionId => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value);
}

async function until(condition: () => Promise<boolean>, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function decode({ data, mimeType }: { data: string; mimeType: string }): Promise<number[]> {
  return inWorker(`fetch("data:${mimeType};base64,${data}").then(response => response.blob()).then(createImageBitmap).then(bitmap => {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
    canvas.drawImage(bitmap, 0, 0);
    return [bitmap.width, bitmap.height, ...canvas.getImageData(bitmap.width / 2, bitmap.height / 2, 1, 1).data];
  })`);
}

function ref(page: string, element: string): number {
  const match = page.match(new RegExp(`\\[(\\d+)\\] ${element}`));
  assert.ok(match, `no ref for ${element} in:\n${page}`);
  return Number(match[1]);
}

async function stopWorker(): Promise<void> {
  const worker = await target(isWorker);
  const stopped = cdp.waitFor("Target.targetDestroyed", ({ targetId }) => targetId === worker.targetId);
  await cdp.send("Target.closeTarget", { targetId: worker.targetId });
  await stopped;
}

async function wakeWorker(): Promise<void> {
  await cdp.send("Target.createTarget", { url: "about:blank", background: true });
}

async function hostPids(): Promise<number[]> {
  const pids: number[] = [];
  for (const pid of (await readdir("/proc")).filter(name => /^\d+$/.test(name))) {
    const args = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
    if (args.includes(sessions) && args.some(arg => arg.endsWith("/src/host.js"))) pids.push(Number(pid));
  }
  return pids;
}

async function tcpListeners(pid: number): Promise<number[]> {
  const sockets = new Set<string>();
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    const inode = (await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")).match(/^socket:\[(\d+)\]$/)?.[1];
    if (inode) sockets.add(inode);
  }
  const ports: number[] = [];
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of (await readFile(table, "utf8")).trim().split("\n").slice(1)) {
      const [, local, , state, , , , , , inode] = line.trim().split(/\s+/);
      if (state === "0A" && sockets.has(inode)) ports.push(parseInt(local.split(":").at(-1)!, 16));
    }
  }
  return ports;
}

test("a navigate to a new host asks first, and a denied one fails before Chrome loads it", async () => {
  await assert.rejects(browser({ action: "navigate", url: `${site}index.html` }, "Deny"), new RegExp(`did not allow the browser on ${host.replaceAll(".", "\\.")}`));
  assert.deepEqual(asked.splice(0), [host]);
  const { targetInfos } = await cdp.send("Target.getTargets");
  assert.ok(targetInfos.every((info: any) => !info.url.startsWith(site)));
});

test("navigate reaches Chrome through the extension and opens the page in a pi tab group", async () => {
  assert.match(await browser({ action: "navigate", url: `${site}index.html` }, "Allow for this session"), /^Tab \d+: Pi fixture </);
  assert.deepEqual(asked.splice(0), [host]);
  const group = await inWorker(`chrome.tabs.query({ url: "${site}index.html" }).then(([tab]) => chrome.tabGroups.get(tab.groupId)).then(group => group.title)`);
  assert.equal(group, "pi · e2e");
});

test("read returns the page text and refs, including shadow DOM and same-origin frames", async () => {
  const text = await browser({ action: "read" });
  assert.match(text, /heading "Pi fixture heading"/);
  assert.match(text, /Some page text\./);
  assert.match(text, /^\s*\[\d+\] button "Press me"$/m);
  assert.match(text, /^\s*\[\d+\] button "Shadow button"$/m);
  assert.match(text, /^\s*\[\d+\] link "Link inside frame"$/m);
  assert.deepEqual(asked, [], "a session-approved host does not ask again");
});

test("a redirect to a new host asks again, and allow once covers only that action", async () => {
  await assert.rejects(browser({ action: "navigate", url: `${site}redirect?to=${encodeURIComponent(at("redirect"))}` }, "Deny"), /did not allow the browser on redirect\.test/);
  await assert.rejects(browser({ action: "read" }, "Deny"), /redirect\.test/);
  assert.match(await browser({ action: "read" }, "Allow once"), /Not a pi tab/);
  await assert.rejects(browser({ action: "read" }, "Deny"), /redirect\.test/);
  const tabs = await browser({ action: "tabs" });
  assert.match(tabs, /^Tab \d+: \(unapproved host redirect\.test\) \(current\)$/m);
  assert.doesNotMatch(tabs, /Other tab|other\.html/);
  assert.deepEqual(asked.splice(0), ["redirect.test", "redirect.test", "redirect.test", "redirect.test"]);
  assert.match(await browser({ action: "navigate", url: `${site}index.html` }), /Pi fixture/);
  assert.deepEqual(asked, []);
});

test("no TCP port is open while the agent reads a page over the native host and a user-only socket", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
  const reading = browser({ action: "read" });
  const hosts = await hostPids();
  assert.equal(hosts.length, 1, "Chrome runs the native host for the e2e sessions folder");
  assert.deepEqual(await tcpListeners(hosts[0]), [], "the native host listens on no TCP port");
  assert.deepEqual(await tcpListeners(process.pid), [Number(new URL(site).port)], "pi listens on no TCP port; only the fixture server does");
  assert.equal((await stat(join(sessions, "e2e.sock"))).mode & 0o777, 0o600);
  assert.match(await reading, /heading "Pi fixture heading"/);
});

test("read refuses a tab outside the pi group", async () => {
  const tabId = await inWorker(`chrome.tabs.create({ url: "${site}other.html", active: false }).then(tab => tab.id)`);
  await assert.rejects(browser({ action: "read", tabId }), new RegExp(`Tab ${tabId} is not in your group`));
});

test("tabs lists the pi tab and only counts the others", async () => {
  const total = await inWorker("chrome.tabs.query({}).then(tabs => tabs.length)");
  const text = await browser({ action: "tabs" });
  assert.match(text, /Pi fixture .*index\.html.*\(current\)/);
  assert.doesNotMatch(text, /other\.html|Other tab|about:blank/);
  assert.match(text, new RegExp(`^${total - 1} other tabs are not in your group\\.$`, "m"));
});

test("navigate refuses non-http schemes", async () => {
  for (const url of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/hosts"]) {
    await assert.rejects(browser({ action: "navigate", url }), /only opens http and https/);
    const answer = await inWorker(`handlers.navigate({ url: ${JSON.stringify(url)} }).then(() => "opened", error => error.message)`);
    assert.match(answer, /only opens http and https/);
  }
});

test("navigate in a new tab that times out before the page commits reports the pending page", async () => {
  assert.match(await browser({ action: "navigate", url: `${site}stall`, newTab: true }), /\(still loading\)$/);
});

test("navigate returns a page that never finishes loading as still loading, and it reads", async () => {
  const text = await browser({ action: "navigate", url: `${site}hang`, newTab: true });
  assert.match(text, /^Tab (\d+): Hanging <.*\/hang> \(still loading\)$/);
  assert.match(await browser({ action: "read" }), /heading "Never finishes"/);
});

const form = `${site}form.html`;

test("type, keys, and click fill and submit a form with real input events", async () => {
  assert.match(await browser({ action: "navigate", url: form, newTab: true }), /Pi form/);
  const page = await browser({ action: "read" });
  assert.match(await browser({ action: "type", ref: ref(page, 'textbox "Name"'), text: "hello pi" }), /^Typed 8 characters into \[\d+\] in tab \d+\.$/);
  assert.match(await browser({ action: "keys", keys: "Enter" }), /^Pressed Enter in tab \d+\.$/);
  assert.match(await browser({ action: "click", ref: ref(page, 'button "Clicked 0 times"') }), /^Clicked \[\d+\] in tab \d+\.$/);
  const after = await browser({ action: "read" });
  assert.match(after, /submitted: hello pi/);
  assert.match(after, /button "Clicked 1 times"/, "the click arrived as a trusted event");
  await browser({ action: "keys", ref: ref(page, 'textbox "Name"'), keys: `${process.platform === "darwin" ? "Meta" : "Control"}+a Backspace` });
  await browser({ action: "type", ref: ref(page, 'textbox "Name"'), text: "second" });
  await browser({ action: "keys", keys: "Enter" });
  assert.match(await browser({ action: "read" }), /submitted: second/, "select-all and Backspace cleared the field");
});

const intruded = (url: string) => until(() => inPage(url, "'intruded' in document.documentElement.dataset"));

test("a page holding another extension's frame, like a password manager's, is still read, typed into, and submitted", async () => {
  assert.match(await browser({ action: "navigate", url: `${form}?intrude`, newTab: true }), /Pi form/);
  await intruded(`${form}?intrude`);
  const page = await browser({ action: "read" });
  await browser({ action: "type", ref: ref(page, 'textbox "Name"'), text: "past the intruder" });
  await browser({ action: "keys", keys: "Enter" });
  assert.match(await browser({ action: "read" }), /submitted: past the intruder/);
});

test("a page holding another extension's frame that cannot be removed fails with the cause and the workaround", async () => {
  await browser({ action: "navigate", url: `${form}?intrude=object`, newTab: true });
  await intruded(`${form}?intrude=object`);
  await assert.rejects(browser({ action: "read" }), { message: /^Another extension, likely a password manager such as LastPass, has a frame in tab \d+ that Pi Browser could not remove, and Chrome does not let Pi Browser control a tab that holds another extension's frame\. Ask the user to turn that extension off for this site/ });
});

test("the pi overlay marks where the agent clicks, stays out of read and the page's reach, and its Stop button aborts the agent", async () => {
  const tabId = await inWorker(`chrome.tabs.query({ url: "${form}" }).then(([tab]) => chrome.tabs.update(tab.id, { active: true })).then(tab => tab.id)`);
  const page = await browser({ action: "read", tabId });
  assert.doesNotMatch(page, /Stop pi/);
  await browser({ action: "click", ref: ref(page, 'button "Clicked \\d+ times"') });
  const overlay = "!!document.querySelector('pi-overlay')";
  assert.deepEqual(await inPage(form, `[${overlay}, document.querySelector('pi-overlay').shadowRoot, typeof piStop]`), [true, null, "undefined"]);
  const [x, y] = await inPage(form, "(box => [box.x + box.width / 2, box.y + box.height / 2])(count.getBoundingClientRect())");
  const shot = await onPage(form, sessionId => cdp.send("Page.captureScreenshot", { format: "png", clip: { x: x - 1, y: y - 1, width: 2, height: 2, scale: 1 } }, sessionId));
  const [, , r, g, b] = await decode({ data: shot.data, mimeType: "image/png" });
  assert.ok(Math.abs(r - 0x3b) < 16 && Math.abs(g - 0x82) < 16 && Math.abs(b - 0xf6) < 16, `pixel ${r},${g},${b} at the clicked button is the pi cursor`);

  emit("agent_end");
  await until(async () => !(await inPage(form, overlay)));

  await browser({ action: "read", tabId });
  assert.equal(await inPage(form, overlay), true);
  const [stopX, stopY] = await inPage(form, "[innerWidth / 2, innerHeight - 34]");
  await onPage(form, async sessionId => {
    for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: stopX, y: stopY, button: "left", clickCount: 1 }, sessionId);
  });
  await until(async () => stopped.length === 1);
  assert.deepEqual(stopped, ["e2e"]);
  await until(async () => !(await inPage(form, overlay)));
});

test("zero and empty params a model fills in count as not given", async () => {
  const blank = { tabId: 0, ref: 0, url: "", text: "", code: "", keys: "", newTab: false };
  const [, tabId] = (await browser({ ...blank, action: "tabs" })).match(/^Tab (\d+): .*\(current\)$/m)!;
  assert.match(await browser({ ...blank, action: "navigate", url: form }), new RegExp(`^Tab ${tabId}: Pi form`));
  const page = await browser({ ...blank, action: "read" });
  await browser({ ...blank, action: "type", ref: ref(page, 'textbox "Name"'), text: "zero" });
  assert.match(await browser({ ...blank, action: "keys", keys: "Enter" }), new RegExp(`^Pressed Enter in tab ${tabId}\\.$`));
  assert.match(await browser({ ...blank, action: "read" }), /submitted: zero/);
  await assert.rejects(browser({ ...blank, action: "click", ref: -1 }), /Ref \[-1\] is gone/);
});

test("a click that opens a dialog fails at once instead of hanging, and the tab works once it is answered", async () => {
  const page = await browser({ action: "read" });
  const start = Date.now();
  await assert.rejects(browser({ action: "click", ref: ref(page, 'button "Delete"') }), /opened a confirm dialog.*answer it in Chrome/);
  assert.ok(Date.now() - start < 2_000);
  await assert.rejects(browser({ action: "read" }), /opened a confirm dialog.*answer it in Chrome/);
  assert.ok(Date.now() - start < 2_000, "an open dialog refuses later actions at once");
  const tabId = await inWorker(`chrome.tabs.query({ url: "${form}" }).then(([tab]) => tab.id)`);
  await inWorker(`chrome.debugger.sendCommand({ tabId: ${tabId} }, "Page.handleJavaScriptDialog", { accept: false })`);
  assert.match(await browser({ action: "read" }), /declined/);
});

test("click reaches a ref inside a same-origin frame, and the frame navigating keeps the page's own refs", async () => {
  const page = await browser({ action: "read", tabId: await inWorker(`chrome.tabs.query({ url: "${site}index.html" }).then(([tab]) => tab.id)`) });
  await browser({ action: "click", ref: ref(page, 'link "Link inside frame"') });
  await until(async () => await inPage(`${site}index.html`, "document.querySelector('iframe').contentWindow.location.pathname") === "/index.html");
  await until(async () => (await browser({ action: "scroll", ref: ref(page, 'link "Link inside frame"') }).catch(error => error.message)).includes("is gone"));
  assert.match(await browser({ action: "click", ref: ref(page, 'button "Press me"') }), /^Clicked/);
});

test("scroll brings a ref below the fold into view", async () => {
  const url = `${form}?scroll`;
  await browser({ action: "navigate", url, newTab: true });
  const page = await browser({ action: "read" });
  const below = "document.getElementById('below').getBoundingClientRect().top";
  assert.ok(await inPage(url, below) > await inPage(url, "innerHeight"));
  assert.match(await browser({ action: "scroll", ref: ref(page, 'button "Below the fold"') }), /^Scrolled \[\d+\] into view in tab \d+\.$/);
  assert.ok(await inPage(url, below) < await inPage(url, "innerHeight"));
});

test("a ref goes stale when the page navigates", async () => {
  const page = await browser({ action: "read" });
  await browser({ action: "navigate", url: form });
  await assert.rejects(browser({ action: "click", ref: ref(page, 'button "Clicked 0 times"') }), /Ref \[\d+\] is gone .*Use read for fresh refs/);
});

test("screenshot brings a pi tab behind another tab to the front and returns a CSS-pixel JPEG of its page", async () => {
  const tabId = await inWorker(`chrome.tabs.query({ url: "${form}" }).then(tabs => tabs.at(-1).id)`);
  await inWorker(`chrome.tabs.get(${tabId}).then(tab => chrome.tabs.create({ windowId: tab.windowId, url: "${site}other.html", active: true }))`);
  const { content } = await call({ action: "screenshot", tabId });
  const [, file] = content[0].text.match(new RegExp(`^Screenshot in tab ${tabId}\\. Saved to (.+\\.jpg)$`));
  assert.equal(content[1].mimeType, "image/jpeg");
  assert.equal((await readFile(file)).toString("base64"), content[1].data);
  assert.equal(await inWorker(`chrome.tabs.get(${tabId}).then(tab => tab.active)`), true);
  const [width, height, r, g, b] = await decode(content[1]);
  const [cssWidth, ratio] = await inPage(form, "[innerWidth, devicePixelRatio]");
  assert.equal(ratio, 2, "Chrome runs at 2x like a high-density screen");
  assert.ok(width > 500 && width <= cssWidth && height > 100, `${width}x${height} is captured at CSS size, not ${ratio}x`);
  assert.ok(Math.abs(r - 0x20) < 16 && Math.abs(g - 0x50) < 16 && Math.abs(b - 0xc0) < 16, `pixel ${r},${g},${b} is the fixture's background`);
  await browser({ action: "scroll", tabId, ref: ref(await browser({ action: "read", tabId }), 'button "Below the fold"') });
  const [, , red, green, blue] = await decode((await call({ action: "screenshot", tabId })).content[1]);
  assert.ok(Math.abs(red - 0xc0) < 16 && Math.abs(green - 0x20) < 16 && Math.abs(blue - 0x20) < 16, `pixel ${red},${green},${blue} is the scrolled-to footer`);
});

test("a pi tab on a non-web page, like about:blank, is refused and listed by its scheme only", async () => {
  const tabId = await inWorker(`openTab({ id: "e2e", name: "e2e" }).then(tab => tab.id)`);
  for (const params of [{ action: "read", tabId }, { action: "click", tabId, ref: 1 }, { action: "screenshot", tabId }]) {
    await assert.rejects(browser(params), /only acts on http and https pages.*about: page/);
  }
  assert.match(await browser({ action: "tabs" }), new RegExp(`^Tab ${tabId}: \\(about: page\\) \\(current\\)$`, "m"));
  assert.deepEqual(asked, []);
});

test("closing the bridge detaches the debugger from pi tabs", async () => {
  const page = await target(info => info.type === "page" && info.url === `${site}index.html`);
  assert.equal(page.attached, true);
  const detached = cdp.waitFor("Target.targetInfoChanged", ({ targetInfo }) => targetInfo.targetId === page.targetId && !targetInfo.attached);
  emit("session_shutdown");
  await detached;
});

test("the extension reconnects on its own when its stopped service worker wakes", async () => {
  await browser({ action: "tabs" });
  await stopWorker();
  const start = Date.now();
  await wakeWorker();
  assert.match(await browser({ action: "tabs" }), /Pi fixture/);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2_000, `reconnected after ${elapsed}ms`);
});

test("always saves the host, and a fresh session does not ask for it", async () => {
  assert.match(await browser({ action: "navigate", url: at("always"), newTab: true }, "Always allow"), /Other tab/);
  assert.deepEqual(asked.splice(0), ["always.test"]);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { allowedHosts: ["always.test"] });
  emit("session_shutdown");
  ({ asked, confirmed, emit, call, browser } = session());
  assert.match(await browser({ action: "read" }), /Not a pi tab/);
  assert.match(await browser({ action: "navigate", url: at("always", "index.html") }), /Pi fixture/);
  assert.deepEqual(asked, []);
});

const second = session("e2e-b", "second");
const theirs = at("always", "form.html");

function groupOf(id: string): Promise<{ title: string; color: string }> {
  return inWorker(`chrome.storage.session.get("groups").then(({ groups }) => chrome.tabGroups.get(groups["${id}"])).then(({ title, color }) => ({ title, color }))`);
}

function tabGroup(url: string): Promise<{ id: number; title: string; color: string }> {
  return inWorker(`chrome.tabs.query({ url: "${url}" }).then(([tab]) => chrome.tabGroups.get(tab.groupId)).then(({ id, title, color }) => ({ id, title, color }))`);
}

function stopLabel(url: string): Promise<string> {
  return inWorker(`chrome.tabs.query({ url: "${url}" }).then(async ([{ id: tabId }]) => {
    const { frameTree } = await chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree");
    const { executionContextId: contextId } = await chrome.debugger.sendCommand({ tabId }, "Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: OVERLAY_WORLD });
    return (await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { contextId, expression: "piOverlay.stop.textContent", returnByValue: true })).result.value;
  })`);
}

test("two sessions navigate and read their own pages at the same time, each in its own labelled group", async () => {
  const [page, other] = await Promise.all([
    browser({ action: "navigate", url: at("always", "index.html") }).then(() => browser({ action: "read" })),
    second.browser({ action: "navigate", url: theirs }).then(() => second.browser({ action: "read" })),
  ]);
  assert.match(page, /heading "Pi fixture heading"/);
  assert.match(other, /textbox "Name"/);
  const [mine, yours] = [await groupOf("e2e"), await groupOf("e2e-b")];
  assert.equal(mine.title, "pi · e2e");
  assert.equal(yours.title, "pi · second");
  assert.notEqual(mine.color, yours.color);
});

test("each session's tabs lists only its own tabs", async () => {
  const other = await second.browser({ action: "tabs" });
  const [, tabId] = other.match(/^Tab (\d+): Pi form <.*> \(current\)$/m)!;
  assert.equal(other.match(/^Tab /gm)!.length, 1);
  const mine = await browser({ action: "tabs" });
  assert.match(mine, /Pi fixture/);
  assert.doesNotMatch(mine, new RegExp(`^Tab ${tabId}:|Pi form <http://always`, "m"));
});

test("a session acting on another session's tabId is refused, whatever the action", async () => {
  const mine = await inWorker(`chrome.tabs.query({ url: "${at("always", "index.html")}" }).then(([tab]) => tab.id)`);
  const yours = await inWorker(`chrome.tabs.query({ url: "${theirs}" }).then(([tab]) => tab.id)`);
  for (const params of [{ action: "read" }, { action: "click", ref: 1 }, { action: "screenshot" }, { action: "eval", code: "1" }, { action: "navigate", url: theirs }]) {
    await assert.rejects(second.browser({ ...params, tabId: mine }), new RegExp(`Tab ${mine} is not in your group`));
    await assert.rejects(browser({ ...params, tabId: yours }), new RegExp(`Tab ${yours} is not in your group`));
  }
  assert.match(await second.browser({ action: "read" }), /textbox "Name"/);
});

test("screenshots from two sessions at once each capture their own tab", async () => {
  const [mine, yours] = await Promise.all([call({ action: "screenshot" }), second.call({ action: "screenshot" })]);
  const blue = ([, , r, g, b]: number[]) => Math.abs(r - 0x20) < 16 && Math.abs(g - 0x50) < 16 && Math.abs(b - 0xc0) < 16;
  assert.ok(blue(await decode(yours.content[1])), "the second session's shot is its form");
  assert.ok(!blue(await decode(mine.content[1])), "the first session's shot is its own page, not the form");
});

test("a renamed session's group title follows on its next action", async () => {
  second.rename("renamed");
  await second.browser({ action: "tabs" });
  assert.equal((await groupOf("e2e-b")).title, "pi · renamed");
});

test("the overlay's Stop button names its session and stops only the session that owns the tab", async () => {
  await inWorker(`chrome.tabs.query({ url: "${theirs}" }).then(([tab]) => chrome.tabs.update(tab.id, { active: true }))`);
  await second.browser({ action: "read" });
  assert.equal(await stopLabel(theirs), "Stop pi · renamed");
  const [x, y] = await inPage(theirs, "[innerWidth / 2, innerHeight - 34]");
  await onPage(theirs, async sessionId => {
    for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sessionId);
  });
  await until(async () => stopped.length === 2);
  await browser({ action: "tabs" });
  assert.deepEqual(stopped, ["e2e", "e2e-b"]);
  second.emit("session_shutdown");
});

test("an exited session's group is retitled ended, keeps its tabs, and is untracked", async () => {
  await until(async () => (await tabGroup(theirs)).title === "pi · renamed (ended)");
  assert.equal(await inWorker(`chrome.storage.session.get("groups").then(({ groups }) => "e2e-b" in groups)`), false);
  const tabId = await inWorker(`chrome.tabs.query({ url: "${theirs}" }).then(([tab]) => tab.id)`);
  await until(async () => !(await inWorker(`attached.has(${tabId})`)));
  const attached = await inWorker(`attach(${tabId}).then(() => "attached", error => error.message)`);
  assert.match(attached, /not in a live pi group/, "a call still in flight for the ended session cannot reattach the debugger");
});

test("a session reconnecting with the same id acts in its old group, under its title and a color no live group uses", async () => {
  const ended = await tabGroup(theirs);
  const third = session("e2e-c", "third");
  await third.browser({ action: "navigate", url: at("always", "other.html") });
  const taken = await groupOf("e2e-c");
  assert.equal(taken.color, ended.color, "the ended group's color was free for a new session");
  const resumed = session("e2e-b", "renamed");
  assert.match(await resumed.browser({ action: "read" }), /textbox "Name"/);
  const group = await tabGroup(theirs);
  assert.equal(group.id, ended.id);
  assert.equal(group.title, "pi · renamed");
  assert.ok(![taken.color, (await groupOf("e2e")).color].includes(group.color), `${group.color} is not used by another live group`);
  const status = await resumed.status();
  assert.match(status, new RegExp(`^Your group: pi · renamed \\(${group.color}\\)$`, "m"));
  assert.match(status, /^Connected browser: Chromium \d+$/m);
  resumed.emit("session_shutdown");
  third.emit("session_shutdown");
});

test("console returns the page's logged error and uncaught exception, and a navigation clears them", async () => {
  await browser({ action: "navigate", url: at("always", "debug.html") });
  const text = await browser({ action: "console" });
  assert.match(text, /^\[error\] fixture error: widget failed$/m);
  assert.match(text, /^\[exception\] Error: fixture uncaught/m);
  await browser({ action: "navigate", url: at("always", "index.html") });
  assert.match(await browser({ action: "console" }), /^No console messages in tab \d+ since its page loaded\.$/);
});

test("network lists the page's fetch with its status, and never its headers or body", async () => {
  await browser({ action: "navigate", url: at("always", "debug.html") });
  let text = "";
  await until(async () => /^GET 201 /m.test(text = await browser({ action: "network" })));
  assert.match(text, /^GET 200 Document http:\/\/always\.test:\d+\/debug\.html$/m);
  assert.match(text, /^GET 201 Fetch http:\/\/always\.test:\d+\/api\/data$/m, "the fetch carried its Authorization header");
  assert.doesNotMatch(text, /fixture-secret|Bearer|authorization|cookie/i);
});

test("network on a page loaded before the debugger reattached says it may be missing requests", async () => {
  const tabId = await inWorker(`chrome.tabs.query({ url: "${at("always", "debug.html")}" }).then(([tab]) => tab.id)`);
  const page = await target(info => info.type === "page" && info.url === at("always", "debug.html"));
  const detached = cdp.waitFor("Target.targetInfoChanged", ({ targetInfo }) => targetInfo.targetId === page.targetId && !targetInfo.attached);
  emit("session_shutdown");
  await detached;
  ({ asked, confirmed, emit, call, browser } = session());
  assert.match(await browser({ action: "network", tabId }), /^No requests in tab \d+ since the debugger attached; reload the page to see all requests\.$/);
  await browser({ action: "navigate", url: at("always", "debug.html"), tabId });
  assert.match(await browser({ action: "network", tabId }), /^\d+ requests in tab \d+ since its page loaded, oldest first:/);
});

test("a tab that changed group while the debugger attached starts fresh on its next action", async () => {
  const tabId = await inWorker(`chrome.tabs.query({ url: "${at("always", "debug.html")}" }).then(([tab]) => tab.id)`);
  assert.match(await browser({ action: "network", tabId }), /since its page loaded/);
  await inWorker(`attached.set(${tabId}, -2)`);
  assert.match(await browser({ action: "network", tabId }), /since the debugger attached/);
});

test("eval asks with its code shown even on an always host, returns the value, and fails when declined", async () => {
  await browser({ action: "navigate", url: at("always", "debug.html"), newTab: true });
  assert.equal(await browser({ action: "eval", code: "document.title" }, true), "Pi debug");
  assert.deepEqual(confirmed.splice(0), [["Run this JavaScript in the always.test tab?\ndocument.title", "Run all 1 line", "Always run on always.test", "Never ask again on approved sites", "Don't run"]]);
  await assert.rejects(browser({ action: "eval", code: "document.title = 'changed'" }, false), /did not allow this eval/);
  assert.deepEqual(confirmed.splice(0), [["Run this JavaScript in the always.test tab?\ndocument.title = 'changed'", "Run all 1 line", "Always run on always.test", "Never ask again on approved sites", "Don't run"]]);
  assert.deepEqual(JSON.parse(await browser({ action: "eval", code: "Promise.resolve({ title: document.title, n: 1 })" }, true)), { title: "Pi debug", n: 1 });
  assert.match(await browser({ action: "eval", code: "missing.call()" }, true), /^Uncaught: ReferenceError: missing is not defined/);
  for (let i = 0; i < 2; i++) {
    assert.equal(await browser({ action: "eval", code: "const heading = await Promise.resolve(document.querySelector('h1'));\nheading.textContent" }, true), "Debug fixture");
  }
  confirmed.splice(0);
  assert.deepEqual(asked, [], "eval adds its confirm, not a host prompt");
});

test("an eval that opens a dialog fails at once instead of hanging", async () => {
  await assert.rejects(browser({ action: "eval", code: "confirm('Sure?')" }, true), /opened a confirm dialog/);
  const tabId = await inWorker(`chrome.tabs.query({ url: "${at("always", "debug.html")}" }).then(tabs => tabs.at(-1).id)`);
  await inWorker(`chrome.debugger.sendCommand({ tabId: ${tabId} }, "Page.handleJavaScriptDialog", { accept: false })`);
  assert.equal(await browser({ action: "eval", code: "1 + 1" }, true), "2");
});

test("after a debugging cancel every call fails at once, across a worker restart, until it is allowed again", async () => {
  await inWorker(`chrome.storage.session.set({ canceled: true })`);
  for (const restart of [false, true]) {
    if (restart) await stopWorker();
    const start = Date.now();
    if (restart) await wakeWorker();
    await assert.rejects(browser({ action: "read" }), /canceled in Chrome.*toolbar icon/);
    assert.ok(Date.now() - start < 2_000);
  }
  await inWorker(`chrome.storage.session.remove("canceled")`);
  assert.match(await browser({ action: "read" }), /heading/);
});

test("a native host Chrome cannot start is explained in the toolbar title, and the extension recovers once it can", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
  await browser({ action: "tabs" });
  const manifest = join(profile, "NativeMessagingHosts", "com.lwlee2608.pi_browser.json");
  await rename(manifest, `${manifest}.off`);
  for (const pid of await hostPids()) process.kill(pid);
  let title = "";
  await until(async () => /not found/.test(title = await inWorker("chrome.action.getTitle({})")));
  assert.match(title, /^Pi Browser: cannot start pi's native host \(Specified native messaging host not found\.\)\. .*click this icon to retry\. Snap and Flatpak/);
  await rename(`${manifest}.off`, manifest);
  assert.match(await browser({ action: "tabs" }), /^Tab \d+: /m);
  assert.equal(await inWorker("chrome.action.getTitle({})"), "Pi Browser: connected");
});

test("an extension at another protocol version fails every call and /browser with how to fix it", async () => {
  const dir = join(work, "stale");
  const stale = await launchChrome([await copyExtension(join(dir, "extension"), { ...settings, PROTOCOL: 0 })], join(dir, "profile"));
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  const old = session("e2e-stale", "stale", { browserDirs: [join(dir, "profile")] });
  process.env.PI_CODING_AGENT_DIR = join(work, "agent");
  const reload = /^Pi Browser protocol versions do not match \(pi 1, extension 0, native host 1\)\. Reload the Pi Browser extension in chrome:\/\/extensions/m;
  try {
    await assert.rejects(old.browser({ action: "tabs" }), { message: reload });
    assert.match(await old.status(), reload);
  } finally {
    old.emit("session_shutdown");
    await stale.close();
  }
});
