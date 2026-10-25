import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Handlers } from "../src/bridge.ts";
import { PROTOCOL } from "../src/host.js";
import { browserExtension } from "../src/index.ts";

function browser(reply?: { result: object } | { error: string }, platform: NodeJS.Platform = "linux", hello: { result: object } | { error: string } = { result: { version: PROTOCOL, host: PROTOCOL } }): () => Promise<string> {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  let command: (args: string, ctx: ExtensionContext) => Promise<void>;
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
    registerTool: () => {},
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
    getActiveTools: () => [],
    setActiveTools: () => {},
  } as unknown as ExtensionAPI;
  const transport = async (bridge: Handlers) => {
    if (reply) {
      const peer = { send: ({ id, method }: { id: number; method: string }) => queueMicrotask(() => bridge.message(peer, { id, ...method === "status" ? reply : method === "hello" ? hello : { error: method } })), close: () => {} };
      bridge.open(peer);
    }
    return () => {};
  };
  browserExtension({ transport, platform, connectTimeout: 10, callTimeout: 100 })(pi);
  const notes: string[] = [];
  const ctx = { hasUI: true, cwd: "/work/demo", ui: { notify: (text: string) => notes.push(text) }, sessionManager: { getSessionId: () => "id", getSessionName: () => "foo" } } as unknown as ExtensionContext;
  handlers.get("session_start")!({}, ctx);
  return async () => {
    await command("", ctx);
    handlers.get("session_shutdown")!({}, ctx);
    return notes.join("\n");
  };
}

test("/browser prints your group with its color and the connected browser", async () => {
  const text = await browser({ result: { browser: "Brave 141", group: { title: "pi · foo", color: "red" } } })();
  assert.match(text, /^Chrome extension folder: .*chrome\/$/m);
  assert.match(text, /^Connected browser: Brave 141$/m);
  assert.match(text, /^Your group: pi · foo \(red\)$/m);
});

test("/browser says plainly when the session has no group yet", async () => {
  const text = await browser({ result: { browser: "Google Chrome 156" } })();
  assert.match(text, /^Connected browser: Google Chrome 156$/m);
  assert.match(text, /^Your group: none yet; it opens on the agent's first navigate\.$/m);
});

test("/browser keeps its other lines and shows the error when the status call fails", async () => {
  const text = await browser({ error: "Unknown browser action: status" })();
  assert.match(text, /^Chrome extension folder: .*chrome\/$/m);
  assert.match(text, /^Chrome: connected, but its status failed: Unknown browser action: status$/m);
});

test("/browser tells you to reload an extension that predates the version handshake", async () => {
  const text = await browser({ error: "Unknown browser action: status" }, "linux", { error: "Unknown browser action: hello" })();
  assert.match(text, /^Pi Browser protocol versions do not match \(pi \d+, extension none, native host none\)\. Reload the Pi Browser extension in chrome:\/\/extensions/m);
});

test("/browser says how to reconnect when no browser is connected", async () => {
  const text = await browser()();
  assert.match(text, /^Chrome: not connected\. Click the Pi Browser toolbar icon/m);
  assert.match(text, /Snap and Flatpak browsers are not supported\.$/m);
  assert.doesNotMatch(text, /Your group/);
});

test("/browser on Windows says it is not supported until the port transport", async () => {
  assert.match(await browser({ result: { browser: "Google Chrome 156" } }, "win32")(), /^The browser is not supported on Windows until the port transport lands/);
});
