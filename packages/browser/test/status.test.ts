import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Handlers } from "../src/bridge.ts";
import { browserExtension } from "../src/index.ts";

function browser(status?: object): () => Promise<string> {
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
    if (status) {
      const peer = { send: ({ id, method }: { id: number; method: string }) => queueMicrotask(() => bridge.message(peer, method === "status" ? { id, result: status } : { id, error: method })), close: () => {} };
      bridge.open(peer);
    }
    return () => {};
  };
  browserExtension({ transport, connectTimeout: 10, callTimeout: 100 })(pi);
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
  const text = await browser({ browser: "Brave 141", group: { title: "pi · foo", color: "red" } })();
  assert.match(text, /^Chrome extension folder: .*chrome\/$/m);
  assert.match(text, /^Connected browser: Brave 141$/m);
  assert.match(text, /^Your group: pi · foo \(red\)$/m);
});

test("/browser says plainly when the session has no group yet", async () => {
  const text = await browser({ browser: "Google Chrome 156" })();
  assert.match(text, /^Connected browser: Google Chrome 156$/m);
  assert.match(text, /^Your group: none yet; it opens on the agent's first navigate\.$/m);
});

test("/browser says how to reconnect when no browser is connected", async () => {
  const text = await browser()();
  assert.match(text, /^Chrome: not connected\. Click the Pi Browser toolbar icon/m);
  assert.doesNotMatch(text, /Your group/);
});
