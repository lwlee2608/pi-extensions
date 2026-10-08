import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, parseConfig } from "../src/config.ts";
import { sendCommand, sendTelegram, SEND_TIMEOUT_MS } from "../src/connectors.ts";
import { formatMessage } from "../src/message.ts";
import { NotifyState } from "../src/state.ts";

const connector = { type: "telegram", botToken: "123:fake-token", chatId: "-123" } as const;
const config = { connectors: [connector] };

test("config validates shape, resolves env and never echoes secrets", async () => {
  assert.deepEqual(parseConfig(config), { ...config, onPrompt: false });
  assert.deepEqual(parseConfig({ connectors: [{ type: "command", run: "$RUN" }] }, { RUN: "echo test" }), {
    onPrompt: false, connectors: [{ type: "command", run: "echo test" }],
  });
  assert.throws(() => parseConfig({ connectors: [{ type: "command", run: "$MISSING" }] }, {}));
  assert.deepEqual(parseConfig({ onPrompt: true, connectors: [{ ...connector, botToken: "$TOKEN", chatId: "$CHAT" }] }, { TOKEN: connector.botToken, CHAT: "@channel" }), {
    onPrompt: true, connectors: [{ ...connector, chatId: "@channel" }],
  });
  for (const value of [null, [], {}, { connectors: [] }, { ...config, onPrompt: "true" },
    { connectors: [{ type: "command", run: " " }] }, { connectors: [{ ...connector, chatId: 123 }] },
    { connectors: [{ ...connector, botToken: "$MISSING" }] }, { connectors: [{ ...connector, botToken: "secret/invalid" }] },
    { connectors: [{ ...connector, chatId: " " }] }]) {
    assert.throws(() => parseConfig(value, {}), error => error instanceof Error && !error.message.includes("secret/invalid"));
  }
  const root = await mkdtemp(join(tmpdir(), "notify-config-"));
  try {
    const path = join(root, "config.json");
    await assert.rejects(loadConfig(path), /Cannot read/);
    await writeFile(path, "{ secret invalid json");
    await assert.rejects(loadConfig(path), /not valid JSON/);
    await writeFile(path, JSON.stringify(config));
    assert.deepEqual(await loadConfig(path), { ...config, onPrompt: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("state defaults off, consumes once only for completed/error and resets sessions", () => {
  const state = new NotifyState();
  state.beforeSettle("completed"); assert.equal(state.settle(), undefined);
  state.armed = "once";
  state.beforeSettle("completed"); state.start(); // Continuation then abort: stale outcome is discarded.
  assert.equal(state.settle(), undefined); assert.equal(state.armed, "once");
  state.beforeSettle("error"); assert.equal(state.settle(), "error"); assert.equal(state.armed, "off");
  state.armed = "on";
  for (const outcome of ["completed", "error"] as const) {
    state.start(); state.beforeSettle(outcome); assert.equal(state.settle(), outcome); assert.equal(state.armed, "on");
    assert.equal(state.settle(), undefined);
  }
  state.reset(); assert.equal(state.armed, "off"); assert.equal(state.settle(), undefined);
});

test("messages contain only name, directory and outcome", () => {
  assert.equal(formatMessage("fix-login", "/home/me/src/app", "completed", "/home/me"), "✅ fix-login · ~/src/app · done");
  assert.equal(formatMessage(undefined, "/home/me", "error", "/home/me"), "❌ ~ · error");
  assert.equal(formatMessage("  ", "/home/me-other", "test", "/home/me"), "🔔 /home/me-other · test");
  assert.equal(formatMessage("hello\nworld", "/tmp", "completed"), "✅ hello world · /tmp · done");
});

test("Telegram sends JSON without parse mode, checks API failures, redacts errors and times out", async t => {
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://api.telegram.org/bot123:fake-token/sendMessage");
    assert.equal(options.method, "POST"); assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body as string), { chat_id: "-123", text: "hello" });
    signal = options.signal!;
    return new Response(JSON.stringify({ ok: true }));
  });
  await sendTelegram(connector, "hello"); assert.ok(signal);
  for (const response of [new Response('{"ok":false}'), new Response('{"ok":true}', { status: 500 }), new Response("invalid")]) {
    t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(sendTelegram(connector, "hello"), /Telegram send failed/);
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error(connector.botToken); });
  await assert.rejects(sendTelegram(connector, "hello"), error => error instanceof Error && !error.message.includes(connector.botToken));
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, SEND_TIMEOUT_MS); return timeout.signal; });
  t.mock.method(globalThis, "fetch", (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  const pending = sendTelegram(connector, "hello"); timeout.abort();
  await assert.rejects(pending, /Telegram send failed/);
});

test("command passes text literally in env, redacts failures and cleans up on abort/timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "notify-command-"));
  try {
    const text = 'hello "quotes"\n$(touch injected); `touch injected`';
    await sendCommand({ type: "command", run: 'printf "%s" "$PI_NOTIFY_TEXT" > message' }, text, undefined, root);
    assert.equal(await readFile(join(root, "message"), "utf8"), text);
    await assert.rejects(readFile(join(root, "injected")), /ENOENT/);
    await assert.rejects(sendCommand({ type: "command", run: "echo private >&2; exit 9" }, text), /Command send failed/);
    const controller = new AbortController();
    const pending = sendCommand({ type: "command", run: "sleep 1; touch leaked" }, text, controller.signal, root);
    controller.abort(); await assert.rejects(pending, /Command send failed/);
    const start = Date.now();
    await assert.rejects(sendCommand({ type: "command", run: "sleep 11; touch leaked" }, text, undefined, root), /timeout/);
    assert.ok(Date.now() - start < SEND_TIMEOUT_MS + 2000);
    await new Promise(resolve => setTimeout(resolve, 1200));
    await assert.rejects(readFile(join(root, "leaked")), /ENOENT/);
    await assert.rejects(sendCommand({ type: "command", run: "touch leaked" }, text, controller.signal, root), /Command send failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TUI lifecycle sends once at final settle, never on abort/unarmed, reloads config and resets", async t => {
  const root = await mkdtemp(join(tmpdir(), "notify-lifecycle-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const { default: extension } = await import("../src/index.ts");
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  let command!: (args: string, ctx: any) => Promise<void>;
  let tool: any;
  let activeTools = ["read", "notify_me"];
  extension({ on: (name: string, fn: any) => handlers.set(name, fn),
    registerCommand: (_name: string, def: any) => { command = def.handler; },
    registerTool: (def: any) => { tool = def; },
    getActiveTools: () => activeTools, setActiveTools: (names: string[]) => { activeTools = names; },
  } as any);
  let status: string | undefined;
  const warnings: string[] = [];
  const sent: { chat_id: string; text: string }[] = [];
  let release: (() => void) | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    sent.push(JSON.parse(options.body as string));
    if (release) await new Promise<void>(resolve => { release = resolve; });
    return new Response('{"ok":true}');
  });
  const ctx = { mode: "tui", cwd: "/project", sessionManager: { getSessionName: () => "session" },
    ui: { setStatus: (_key: string, text: string | undefined) => { status = text; }, notify: (text: string) => warnings.push(text) } };
  const emit = (name: string, outcome?: string) => handlers.get(name)!({ outcome }, ctx);
  const settle = () => { emit("agent_before_settle", "completed"); return emit("agent_settled"); };
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 2)); };
  try {
    emit("session_start"); settle(); await flush(); assert.equal(sent.length, 0);
    await command("", ctx); assert.equal(status, undefined); assert.match(warnings.pop()!, /Cannot read/);
    await assert.rejects(tool.execute("id", {}, undefined, undefined, ctx), /Cannot read/);
    assert.equal(status, undefined);
    await mkdir(join(root, "pi-notify"));
    const path = join(root, "pi-notify", "config.json");
    await writeFile(path, JSON.stringify(config));
    await command("", ctx); assert.equal(status, "🔔 once");
    emit("agent_start"); emit("agent_before_settle", "completed"); emit("agent_start");
    assert.equal(sent.length, 0); emit("agent_settled"); await flush();
    assert.equal(sent.length, 0); assert.equal(status, "🔔 once");
    emit("agent_start"); emit("agent_before_settle", "completed"); emit("agent_start");
    emit("agent_before_settle", "error"); assert.equal(emit("agent_settled"), undefined);
    assert.equal(status, undefined); await flush();
    assert.deepEqual(sent, [{ chat_id: "-123", text: "❌ session · /project · error" }]);
    settle(); await flush(); assert.equal(sent.length, 1);
    await command("on", ctx);
    await writeFile(path, JSON.stringify({ connectors: [{ ...connector, chatId: "456" }] }));
    release = () => {};
    assert.equal(settle(), undefined); await flush(); assert.equal(sent[1].chat_id, "456");
    assert.equal(status, "🔔 on"); release!(); release = undefined;
    await command("off", ctx); settle(); await flush(); assert.equal(sent.length, 2);
    await command("test", ctx); await flush(); assert.equal(sent.length, 3); assert.match(sent[2].text, /test$/); assert.equal(status, undefined);
    await command("on", ctx); emit("session_start"); assert.equal(status, undefined); settle(); await flush(); assert.equal(sent.length, 3);
    for (const mode of ["rpc", "json", "print"]) {
      activeTools = ["read", "notify_me"];
      ctx.mode = mode; emit("session_start");
      assert.deepEqual(activeTools, ["read"]);
      activeTools.push("notify_me"); emit("before_agent_start"); assert.deepEqual(activeTools, ["read"]);
      await assert.rejects(tool.execute("id", {}, undefined, undefined, ctx), /only available in TUI/);
      await command("test", ctx); await command("on", ctx); emit("agent_start"); emit("ui_prompt_start"); settle();
    }
    await flush(); assert.equal(sent.length, 3);
    ctx.mode = "tui";
    await writeFile(path, JSON.stringify({ ...config, onPrompt: true }));
    const result = await tool.execute("id", {}, undefined, undefined, ctx);
    assert.match(result.content[0].text, /armed/); assert.match(tool.description, /explicitly asks/);
    assert.equal(status, "🔔 once");
    emit("ui_prompt_start"); await flush(); assert.equal(sent.length, 3);
    emit("agent_start");
    handlers.get("ui_prompt_start")!({ title: "PRIVATE PROMPT", type: "select" }, ctx);
    await flush(); assert.equal(sent.length, 4);
    assert.equal(sent[3].text, "🔔 session · /project · waiting for input");
    assert.equal(status, "🔔 once");
    settle(); await flush(); assert.equal(sent.length, 5); assert.match(sent[4].text, /done$/);
    assert.equal(status, undefined);
    emit("agent_start"); emit("ui_prompt_start"); await flush(); assert.equal(sent.length, 5);
    await command("", ctx);
    await writeFile(path, JSON.stringify(config));
    emit("ui_prompt_start"); await flush(); assert.equal(sent.length, 5);
    emit("session_start");
    await writeFile(path, JSON.stringify({ connectors: [connector, connector] }));
    t.mock.method(globalThis, "fetch", async () => { throw new Error("sensitive"); });
    await command("test", ctx); await flush();
    assert.equal(warnings.length, 2); assert.match(warnings[0], /connector 1 failed/); assert.match(warnings[1], /connector 2 failed/);
    await command("on", ctx); await writeFile(path, "{}"); await command("", ctx); assert.equal(status, undefined);
    emit("session_shutdown");
  } finally { await rm(root, { recursive: true, force: true }); }
});
