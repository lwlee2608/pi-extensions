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
  const browser = async (params: object, ...replies: string[]): Promise<string> => {
    answers.push(...replies);
    try {
      const result = await tools.get("browser").execute("call", params, undefined, () => {}, ctx);
      return result.content[0].text;
    } finally {
      assert.deepEqual(answers.splice(0), [], "every queued answer was asked for");
    }
  };
  return { asked, emit, browser };
}

let { asked, emit, browser } = session();
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
  await rm(work, { recursive: true, force: true });
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

test("navigate returns a page that never finishes loading as still loading, and it reads", async () => {
  const text = await browser({ action: "navigate", url: `${site}hang`, newTab: true });
  assert.match(text, /^Tab (\d+): Hanging <.*\/hang> \(still loading\)$/);
  assert.match(await browser({ action: "read" }), /heading "Never finishes"/);
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
  ({ asked, emit, browser } = session());
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
