import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { browserExtension } from "../../src/index.ts";
import { launchChrome } from "./chrome.ts";
import { copyExtension } from "./extension.ts";

const EXTENSION = "chrome-extension://enidoebkpjligpdgedlellobooiiljib/";
const ALARM_MS = 1_000;
const fixtures = fileURLToPath(new URL("fixtures/", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "pi-browser-e2e-"));

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

const fixtureServer = createServer(async (req, res) => {
  if (req.url!.startsWith("/redirect?to=")) { res.writeHead(302, { location: decodeURIComponent(req.url!.slice(13)) }).end(); return; }
  if (req.url === "/stall") return;
  if (req.url === "/hang") { res.writeHead(200, { "content-type": "text/html" }).write("<title>Hanging</title><h1>Never finishes</h1>"); return; }
  const body = await readFile(join(fixtures, new URL(req.url!, "http://x").pathname)).catch(() => undefined);
  if (body) res.writeHead(200, { "content-type": "text/html" }).end(body);
  else res.writeHead(404).end();
});
const site = `http://127.0.0.1:${await listen(fixtureServer)}/`;
const probe = createServer();
const port = await listen(probe);
probe.close();

process.env.PI_CODING_AGENT_DIR = join(work, "agent");
const configPath = join(work, "agent", "pi-browser", "config.json");
const options = { port, secretPath: join(work, "secret"), connectTimeout: 10_000, callTimeout: 10_000 };

function session() {
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const tools = new Map<string, any>();
  const asked: string[] = [];
  const answers: string[] = [];
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: () => {},
    getActiveTools: () => [...tools.keys()],
    setActiveTools: () => {},
  } as unknown as ExtensionAPI;
  const select = async (title: string) => {
    asked.push(title.match(/use (\S+) in Chrome/)![1]);
    const answer = answers.shift();
    if (!answer) throw new Error(`Unexpected prompt: ${title}`);
    return answer;
  };
  const ctx = { hasUI: true, cwd: work, ui: { notify: () => {}, select }, sessionManager: { getSessionName: () => "e2e" } } as unknown as ExtensionContext;
  const emit = (event: string) => { for (const handler of handlers.get(event) ?? []) handler({}, ctx); };
  browserExtension(options)(pi);
  emit("session_start");
  const call = async (params: object, ...replies: string[]): Promise<{ content: any[] }> => {
    answers.push(...replies);
    try {
      return await tools.get("browser").execute("call", params, undefined, () => {}, ctx);
    } finally {
      assert.deepEqual(answers.splice(0), [], "every queued answer was asked for");
    }
  };
  const browser = async (params: object, ...replies: string[]): Promise<string> => (await call(params, ...replies)).content[0].text;
  return { asked, emit, call, browser };
}

let { asked, emit, call, browser } = session();
const host = new URL(site).hostname;
const at = (name: string, path = "other.html") => `http://${name}.test:${new URL(site).port}/${path}`;

const extensionDir = await copyExtension(join(work, "extension"), { PORT: port, ALARM_MINUTES: ALARM_MS / 60_000, NAVIGATE_WAIT_MS: 300 });
const chrome = await launchChrome(extensionDir, join(work, "profile"));
const { cdp } = chrome;
await cdp.send("Target.setDiscoverTargets", { discover: true });

test.after(async () => {
  emit("session_shutdown");
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

async function inPage(url: string, expression: string): Promise<any> {
  const { targetId } = await target(info => info.type === "page" && info.url === url);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    return (await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value;
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId });
  }
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
  assert.equal(group, "pi");
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

test("read refuses a tab outside the pi group", async () => {
  const tabId = await inWorker(`chrome.tabs.create({ url: "${site}other.html", active: false }).then(tab => tab.id)`);
  await assert.rejects(browser({ action: "read", tabId }), new RegExp(`Tab ${tabId} is not in the pi tab group`));
});

test("tabs lists the pi tab and only counts the others", async () => {
  const total = await inWorker("chrome.tabs.query({}).then(tabs => tabs.length)");
  const text = await browser({ action: "tabs" });
  assert.match(text, /Pi fixture .*index\.html.*\(current\)/);
  assert.doesNotMatch(text, /other\.html|Other tab|about:blank/);
  assert.match(text, new RegExp(`^${total - 1} other tabs are not in the pi group\\.$`, "m"));
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
  await browser({ action: "keys", ref: ref(page, 'textbox "Name"'), keys: "Control+a Backspace" });
  await browser({ action: "type", ref: ref(page, 'textbox "Name"'), text: "second" });
  await browser({ action: "keys", keys: "Enter" });
  assert.match(await browser({ action: "read" }), /submitted: second/, "select-all and Backspace cleared the field");
});

test("a click that opens a dialog fails at once instead of hanging, and the tab works once it is answered", async () => {
  const page = await browser({ action: "read" });
  const start = Date.now();
  await assert.rejects(browser({ action: "click", ref: ref(page, 'button "Delete"') }), /opened a confirm dialog.*answer it in Chrome/);
  assert.ok(Date.now() - start < 2_000);
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
  assert.match(content[0].text, new RegExp(`^Screenshot in tab ${tabId}\\.$`));
  assert.equal(content[1].mimeType, "image/jpeg");
  assert.equal(await inWorker(`chrome.tabs.get(${tabId}).then(tab => tab.active)`), true);
  const [width, height, r, g, b] = await decode(content[1]);
  const [cssWidth, ratio] = await inPage(form, "[innerWidth, devicePixelRatio]");
  assert.equal(ratio, 2, "Chrome runs at 2x like a high-density screen");
  assert.ok(width > 500 && width <= cssWidth && height > 100, `${width}x${height} is captured at CSS size, not ${ratio}x`);
  assert.ok(Math.abs(r - 0x20) < 16 && Math.abs(g - 0x50) < 16 && Math.abs(b - 0xc0) < 16, `pixel ${r},${g},${b} is the fixture's background`);
});

test("a pi tab on a non-web page, like about:blank, is refused and listed by its scheme only", async () => {
  const tabId = await inWorker("openTab().then(tab => tab.id)");
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

test("the extension reconnects on its own after its service worker stops", async () => {
  await browser({ action: "tabs" });
  await stopWorker();
  const start = Date.now();
  assert.match(await browser({ action: "tabs" }), /Pi fixture/);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < ALARM_MS + 1_000, `reconnected after ${elapsed}ms`);
});

test("always saves the host, and a fresh session does not ask for it", async () => {
  assert.match(await browser({ action: "navigate", url: at("always"), newTab: true }, "Always allow"), /Other tab/);
  assert.deepEqual(asked.splice(0), ["always.test"]);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { allowedHosts: ["always.test"] });
  emit("session_shutdown");
  ({ asked, emit, call, browser } = session());
  assert.match(await browser({ action: "read" }), /Not a pi tab/);
  assert.match(await browser({ action: "navigate", url: at("always", "index.html") }), /Pi fixture/);
  assert.deepEqual(asked, []);
});

test("after a debugging cancel every call fails at once, across a worker restart, until it is allowed again", async () => {
  await inWorker(`chrome.storage.session.set({ canceled: true })`);
  for (const restart of [false, true]) {
    if (restart) await stopWorker();
    const start = Date.now();
    await assert.rejects(browser({ action: "read" }), /canceled in Chrome.*toolbar icon/);
    assert.ok(Date.now() - start < ALARM_MS + 1_000);
  }
  await inWorker(`chrome.storage.session.remove("canceled")`);
  assert.match(await browser({ action: "read" }), /heading/);
});
