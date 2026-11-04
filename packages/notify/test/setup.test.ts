import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig, loadDraft, saveDraft } from "../src/config.ts";
import { TextInput } from "../src/text-input.ts";

const TOKEN = "123:fake-token";
const theme = { fg: (_color: string, text: string) => text } as any;
const ENTER = "\r";
const ESC = "\x1b";

const OPEN = Symbol("stays open until the signal aborts");
const HUNG = Symbol("replaced by another dialog, so never resolves");

type Answer = string | boolean | undefined | symbol | (() => Answer);

async function harness(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "notify-setup-"));
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
  let detached: Promise<void> | undefined;
  extension({ on: (name: string, fn: any) => handlers.set(name, fn),
    registerCommand: (_name: string, def: any) => { command = def.handler; },
    registerTool: () => {}, getActiveTools: () => [], setActiveTools: () => {},
  } as any, setup => { detached = setup; });
  const script: Answer[] = [];
  const dialogs: { kind: string; title: string; options?: string[]; message?: string; screen?: string }[] = [];
  const screens: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const sent: { chat_id: string; text: string }[] = [];
  let status: string | undefined;
  let depth = 0;
  let stale = false;
  let failure: Error | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    sent.push(JSON.parse(options.body as string));
    return new Response('{"ok":true}');
  });
  const check = (ok: boolean, message: string) => {
    if (!ok) failure ??= new Error(message);
    assert.ok(ok, message);
  };
  const next = () => {
    check(script.length > 0, `unexpected dialog after: ${dialogs.at(-1)?.title}`);
    const answer = script.shift();
    return typeof answer === "function" ? answer() : answer;
  };
  const active = () => check(!stale, "ctx used after session shutdown");
  const track = <T>(dialog: Promise<T>) => {
    depth++;
    return dialog.finally(() => { depth--; });
  };
  const hold = <T>(answer: symbol, signal: AbortSignal | undefined, closed: T) => new Promise<T>(resolve => {
    if (answer === OPEN) signal?.addEventListener("abort", () => resolve(closed), { once: true });
  });
  const ctx = { mode: "tui", cwd: root, sessionManager: { getSessionName: () => "session" }, ui: {
    setStatus: (_key: string, text: string | undefined) => { active(); status = text; },
    notify: (text: string, type: string) => { active(); notices.push(text); if (type === "warning") warnings.push(text); },
    select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => track((async () => {
      active();
      dialogs.push({ kind: "select", title, options });
      const answer = next();
      if (typeof answer === "symbol") return hold(answer, opts?.signal, undefined);
      if (answer !== undefined) check(options.includes(answer as string), `no option ${String(answer)} in ${options}`);
      return answer;
    })()),
    confirm: (title: string, message: string, opts?: { signal?: AbortSignal }) => track((async () => {
      active();
      dialogs.push({ kind: "confirm", title, message });
      const answer = next();
      return typeof answer === "symbol" ? hold(answer, opts?.signal, false) : answer;
    })()),
    custom: (factory: any) => track(new Promise(resolve => {
      active();
      let component: any;
      component = factory({ requestRender() {} }, theme, {}, (value: unknown) => { resolve(value); component.dispose?.(); });
      dialogs.push({ kind: "input", title: component.render(80)[0], screen: component.render(80).join("\n") });
      const answer = next();
      if (typeof answer === "symbol") return;
      if (answer === undefined) { component.handleInput(ESC); return; }
      for (const char of answer as string) { component.handleInput(char); screens.push(component.render(80).join("\n")); }
      component.handleInput(ENTER);
    })),
  } };
  const path = join(root, "pi-notify", "config.json");
  const start = (args: string, ...answers: Answer[]) => {
    script.push(...answers);
    detached = undefined;
    const handler = command(args, ctx);
    return Promise.all([handler, detached]).then(() => { if (failure) throw failure; });
  };
  return {
    root, path, ctx, script, dialogs, screens, warnings, notices, sent, start,
    handler: (args: string) => command(args, ctx),
    status: () => status,
    depth: () => depth,
    emit: (name: string, outcome?: string) => {
      if (name === "session_start") stale = false;
      const result = handlers.get(name)!({ outcome }, ctx);
      if (name === "session_shutdown") stale = true;
      return result;
    },
    run: async (args: string, ...answers: Answer[]) => {
      await start(args, ...answers);
      assert.deepEqual(script, [], "unused answers");
    },
    write: async (content: string) => {
      await mkdir(join(root, "pi-notify"), { recursive: true });
      await writeFile(path, content);
    },
  };
}

const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 2)); };
const TELEGRAM = ["Add connector", "Telegram", TOKEN, "-123"];
const SAVE_NO_TEST = ["Save", false];

test("from no config, the dialogs write a config loadConfig accepts with owner-only permissions", async t => {
  const h = await harness(t);
  await h.run("setup", ...TELEGRAM, "Notify when waiting for input: off", "Nerd Font status icon: off", ...SAVE_NO_TEST);
  assert.deepEqual(h.dialogs[0].options, ["Add connector", "Notify when waiting for input: off", "Nerd Font status icon: off", "Save", "Cancel"]);
  assert.deepEqual(await loadConfig(h.path), {
    onPrompt: true, nerdFont: true, connectors: [{ type: "telegram", botToken: TOKEN, chatId: "-123" }],
  });
  assert.equal((await stat(h.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(h.root, "pi-notify"))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(h.root, "pi-notify")), ["config.json"]);
  assert.deepEqual(h.warnings, []);
});

test("a command connector saves and appears in the menu", async t => {
  const h = await harness(t);
  await h.run("setup", "Add connector", "Shell command", "echo hi", "Save", false);
  assert.deepEqual((await loadConfig(h.path)).connectors, [{ type: "command", run: "echo hi" }]);
  await h.run("setup", "1. Command echo hi", undefined, "Cancel");
});

test("$VAR values are stored unexpanded", async t => {
  const h = await harness(t);
  process.env.NOTIFY_SETUP_TOKEN = TOKEN;
  process.env.NOTIFY_SETUP_CHAT = "-123";
  t.after(() => { delete process.env.NOTIFY_SETUP_TOKEN; delete process.env.NOTIFY_SETUP_CHAT; });
  await h.run("setup", "Add connector", "Telegram", "$NOTIFY_SETUP_TOKEN", "$NOTIFY_SETUP_CHAT", ...SAVE_NO_TEST);
  assert.deepEqual(JSON.parse(await readFile(h.path, "utf8")).connectors, [{ type: "telegram", botToken: "$NOTIFY_SETUP_TOKEN", chatId: "$NOTIFY_SETUP_CHAT" }]);
  assert.equal((await loadConfig(h.path)).connectors[0].type, "telegram");
});

test("Cancel and Esc write nothing and sub-dialog Esc returns to the menu", async t => {
  const h = await harness(t);
  await h.run("setup", ...TELEGRAM, "Cancel");
  await h.run("setup", ...TELEGRAM, undefined);
  await assert.rejects(lstat(h.path), /ENOENT/);
  await h.run("setup", "Add connector", undefined, "Add connector", "Telegram", undefined, "Add connector", "Telegram", TOKEN, undefined,
    "Add connector", "Shell command", undefined, "Cancel");
  await assert.rejects(lstat(h.path), /ENOENT/);
});

test("invalid existing config warns, opens no dialog and stays byte-identical", async t => {
  const h = await harness(t);
  for (const content of ["{ not json", "[]", "null", '{"connectors":{"type":"command"}}\n', '{"connectors":null}']) {
    await h.write(content);
    await h.run("setup");
    assert.equal(h.dialogs.length, 0);
    assert.equal(h.warnings.pop()?.includes("fix it by hand"), true);
    assert.equal(await readFile(h.path, "utf8"), content);
  }
});

test("a parseable config without connectors opens and keeps unknown keys", async t => {
  const h = await harness(t);
  await h.write(JSON.stringify({ custom: { a: 1 }, onPrompt: "yes" }));
  await h.run("setup", ...TELEGRAM, "Save", true);
  const saved = JSON.parse(await readFile(h.path, "utf8"));
  assert.deepEqual(saved.custom, { a: 1 });
  assert.equal(saved.onPrompt, "yes");
  assert.equal(h.dialogs.find(dialog => dialog.kind === "confirm")?.title, "Save this invalid config?");
});

test("unreadable config is refused rather than treated as missing", async t => {
  const h = await harness(t);
  await mkdir(h.path, { recursive: true });
  await h.run("setup");
  assert.match(h.warnings.pop()!, /Cannot read/);
  assert.equal(h.dialogs.length, 0);
});

test("masked input never renders a literal token but keeps $VAR readable", async t => {
  const h = await harness(t);
  await h.run("setup", ...TELEGRAM, "Cancel");
  assert.ok(h.screens.length > 0);
  for (const screen of h.screens) assert.ok(!screen.includes(TOKEN.slice(0, 5)) && !screen.includes("fake"), screen);

  const render = (value: string, mask: boolean, width = 80) => {
    const input = new TextInput({ title: "t", mask }, theme, () => {});
    input.focused = true;
    input.handleInput(value);
    return input.render(width).join("\n");
  };
  assert.ok(!render(TOKEN, true).includes(TOKEN));
  assert.match(render(TOKEN, true), /•{14}/);
  assert.ok(render("$MY_TOKEN", true).includes("$MY_TOKEN"));
  assert.ok(!render("$MY:secret", true).includes("secret"));
  assert.ok(render(TOKEN, false).includes(TOKEN));
  assert.ok(!render(`\x1b[200~${TOKEN}\x1b[201~`, true).includes("fake"));
  assert.ok(!render(TOKEN, true, 5).includes("fake"));
});

test("text input submits, escapes and appends after its initial value", () => {
  const results: (string | undefined)[] = [];
  const input = new TextInput({ title: "t", initial: "-12" }, theme, value => results.push(value));
  input.handleInput("3");
  input.handleInput(ENTER);
  input.handleInput(ESC);
  assert.deepEqual(results, ["-123", undefined]);
});

test("text input closes on abort and stops listening once disposed", () => {
  const results: (string | undefined)[] = [];
  const open = new AbortController();
  new TextInput({ title: "t", initial: "x", signal: open.signal }, theme, value => results.push(value));
  open.abort();
  assert.deepEqual(results, [undefined]);

  const disposed = new AbortController();
  const late: unknown[] = [];
  new TextInput({ title: "t", signal: disposed.signal }, theme, value => late.push(value)).dispose();
  disposed.abort();
  assert.deepEqual(late, []);
});

test("entry checks reject bad values without echoing them and re-prompt", async t => {
  const h = await harness(t);
  await h.run("setup", "Add connector", "Telegram", "secret/token", " ", TOKEN, "not-a-chat", "\x15@ok", ...SAVE_NO_TEST);
  assert.equal(h.warnings.length, 3);
  for (const warning of h.warnings) assert.ok(!warning.includes("secret") && !warning.includes("not-a-chat"));
  h.warnings.length = 0;
  await h.run("setup", "Add connector", "Shell command", "  ", undefined, "Cancel");
  assert.match(h.warnings.pop()!, /cannot be empty/);
  assert.deepEqual((await loadConfig(h.path)).connectors, [{ type: "telegram", botToken: TOKEN, chatId: "@ok" }]);
});

test("zero connectors block Save", async t => {
  const h = await harness(t);
  await h.run("setup", "Save", "Cancel");
  assert.match(h.warnings.pop()!, /Add a connector/);
  await assert.rejects(lstat(h.path), /ENOENT/);
  await h.write(JSON.stringify({ connectors: [] }));
  await h.run("setup", "Save", undefined);
  assert.match(h.warnings.pop()!, /Add a connector/);
});

test("existing connectors are listed without tokens and preserved on Save", async t => {
  const h = await harness(t);
  const existing = [{ type: "telegram", botToken: TOKEN, chatId: "-1", label: "phone" }, { type: "command", run: "echo\nhi" }, "stray", { type: "slack", url: "x" }];
  await h.write(JSON.stringify({ extra: true, connectors: existing }));
  await h.run("setup", "1. Telegram -1", undefined, "Save", true);
  const options = h.dialogs[0].options!;
  assert.deepEqual(options.slice(0, 5), ["1. Telegram -1", "2. Command echo hi", "3. Unsupported connector (needs fixing)", "4. Unsupported connector (needs fixing)", "Add connector"]);
  for (const dialog of h.dialogs) assert.ok(!JSON.stringify(dialog).includes(TOKEN));
  assert.deepEqual(JSON.parse(await readFile(h.path, "utf8")), { extra: true, connectors: existing });
  assert.equal(h.dialogs.filter(dialog => dialog.title === "Notify setup").length, 2);
});

const CLEAR = "\x15";
const inputs = (h: { dialogs: { kind: string; screen?: string }[] }) => h.dialogs.filter(dialog => dialog.kind === "input").map(dialog => dialog.screen!);
const saved = async (h: { path: string }) => JSON.parse(await readFile(h.path, "utf8"));

test("a literal token never appears in a title, option, prefill, notification or masked render", async t => {
  const h = await harness(t);
  await h.write(JSON.stringify({ connectors: [
    { type: "telegram", botToken: TOKEN, chatId: "-1" },
    { type: "telegram", botToken: "$NOTIFY_SETUP_UNSET", chatId: TOKEN },
  ] }));
  await h.run("setup", "1. Telegram -1", "Edit", "bad/value", "", "", "2. Telegram (invalid) (needs fixing)", "Edit", "", "not-a-chat", undefined, "Save", true);
  assert.ok(inputs(h)[0].includes("Leave empty to keep the stored token"));
  assert.ok(h.notices.length > 0 && h.screens.length > 0);
  const shown = JSON.stringify([h.dialogs, h.screens, h.notices]);
  for (const secret of [TOKEN, "fake", "bad/value"]) assert.ok(!shown.includes(secret), secret);
  assert.equal((await saved(h)).connectors[0].botToken, TOKEN);
});

test("changing only the chat ID leaves the token, $VAR values and unknown keys unchanged", async t => {
  const h = await harness(t);
  const literal = { label: "phone", botToken: TOKEN, type: "telegram", chatId: "-1", extra: { a: [1] } };
  const variable = { type: "telegram", botToken: "$NOTIFY_SETUP_TOKEN", chatId: "$NOTIFY_SETUP_CHAT", label: "env" };
  process.env.NOTIFY_SETUP_TOKEN = TOKEN;
  process.env.NOTIFY_SETUP_CHAT = "-5";
  t.after(() => { delete process.env.NOTIFY_SETUP_TOKEN; delete process.env.NOTIFY_SETUP_CHAT; });
  await h.write(JSON.stringify({ custom: true, connectors: [literal, variable] }));
  await h.run("setup", "1. Telegram -1", "Edit", "", `${CLEAR}-999`, "2. Telegram $NOTIFY_SETUP_CHAT", "Edit", "", "", ...SAVE_NO_TEST);
  assert.equal(JSON.stringify(await saved(h)), JSON.stringify({ custom: true, connectors: [{ ...literal, chatId: "-999" }, variable] }));
  const [literalToken, literalChat, variableToken, variableChat] = inputs(h);
  assert.ok(!literalToken.includes("•") && !literalToken.includes(TOKEN), "literal token input is not prefilled");
  assert.ok(literalChat.includes("> -1"));
  assert.ok(variableToken.includes("> $NOTIFY_SETUP_TOKEN"));
  assert.ok(variableChat.includes("> $NOTIFY_SETUP_CHAT"));
});

test("clearing a prefilled $VAR token keeps it and a bad entry re-prompts with the prefill only", async t => {
  const h = await harness(t);
  const content = { type: "telegram", botToken: "$NOTIFY_SETUP_UNSET", chatId: "-1" };
  await h.write(JSON.stringify({ connectors: [content] }));
  await h.run("setup", "1. Telegram -1 (needs fixing)", "Edit", ":secret", CLEAR, "", "Save", true);
  assert.ok(inputs(h)[1].includes("> $NOTIFY_SETUP_UNSET") && !inputs(h)[1].includes("secret"));
  assert.equal(h.warnings.length, 1);
  assert.deepEqual(await saved(h), { connectors: [content] });
});

test("a missing stored token cannot be kept with empty input", async t => {
  const h = await harness(t);
  await h.write(JSON.stringify({ connectors: [{ type: "telegram", botToken: 5, chatId: 7 }] }));
  await h.run("setup", "1. Telegram (invalid) (needs fixing)", "Edit", "", TOKEN, "", "-1", ...SAVE_NO_TEST);
  assert.ok(!inputs(h)[0].includes("Leave empty"));
  assert.equal(h.warnings.length, 2);
  assert.deepEqual((await loadConfig(h.path)).connectors, [{ type: "telegram", botToken: TOKEN, chatId: "-1" }]);
});

test("a connector with an unset $VAR is flagged, opens and can be fixed", async t => {
  const h = await harness(t);
  await h.write(JSON.stringify({ connectors: [
    { type: "telegram", botToken: "$NOTIFY_SETUP_UNSET", chatId: "-1", label: "phone" },
    { type: "command", run: "$NOTIFY_SETUP_UNSET" },
  ] }));
  await h.run("setup", "1. Telegram -1 (needs fixing)", "Edit", `${CLEAR}${TOKEN}`, "", "2. Command $NOTIFY_SETUP_UNSET (needs fixing)", "Edit", `${CLEAR}echo hi`, ...SAVE_NO_TEST);
  assert.deepEqual(h.dialogs.filter(dialog => dialog.kind === "confirm").map(dialog => dialog.title), ["Send a test notification?"]);
  assert.deepEqual((await saved(h)).connectors, [{ type: "telegram", botToken: TOKEN, chatId: "-1", label: "phone" }, { type: "command", run: "echo hi" }]);
  await h.run("setup", "Cancel");
  assert.deepEqual(h.dialogs.at(-1)?.options?.slice(0, 2), ["1. Telegram -1", "2. Command echo hi"]);
});

test("Esc during an edit keeps the stored connector", async t => {
  const h = await harness(t);
  const connector = { type: "telegram", botToken: TOKEN, chatId: "-1" };
  await h.write(JSON.stringify({ connectors: [connector] }));
  await h.run("setup", "1. Telegram -1", undefined, "1. Telegram -1", "Edit", undefined, "1. Telegram -1", "Edit", "$NOTIFY_SETUP_NEW", undefined, "Save", false);
  assert.deepEqual(await saved(h), { connectors: [connector] });
});

test("removing the last connector blocks Save and Cancel leaves the file", async t => {
  const h = await harness(t);
  const content = JSON.stringify({ connectors: [{ type: "telegram", botToken: TOKEN, chatId: "-1" }] });
  await h.write(content);
  await h.run("setup", "1. Telegram -1", "Remove", "Save", "Cancel");
  assert.match(h.warnings.pop()!, /Add a connector/);
  assert.equal(h.dialogs.at(-1)?.options?.[0], "Add connector");
  assert.equal(await readFile(h.path, "utf8"), content);
});

test("unsupported connectors can only be removed, and removal targets the chosen row", async t => {
  const h = await harness(t);
  const command = { type: "command", run: "true" };
  await h.write(JSON.stringify({ connectors: ["stray", { type: "slack", url: "x" }, command] }));
  await h.run("setup", "1. Unsupported connector (needs fixing)", undefined, "2. Unsupported connector (needs fixing)", "Remove", "1. Unsupported connector (needs fixing)", "Remove", ...SAVE_NO_TEST);
  assert.deepEqual(h.dialogs[1].options, ["Remove"]);
  assert.deepEqual(h.dialogs[3].options, ["Remove"]);
  assert.deepEqual(await saved(h), { connectors: [command] });
});

test("command edits prefill run, keep unknown keys and keep an unchanged run byte-identical", async t => {
  const h = await harness(t);
  await h.write(JSON.stringify({ connectors: [{ type: "command", run: " echo hi ", label: "shell" }, { type: "command", run: "true" }] }));
  await h.run("setup", "1. Command  echo hi ", "Edit", "", "2. Command true", "Edit", " --x", ...SAVE_NO_TEST);
  assert.ok(inputs(h)[0].includes(">  echo hi"));
  assert.deepEqual((await saved(h)).connectors, [{ type: "command", run: " echo hi ", label: "shell" }, { type: "command", run: "true --x" }]);
});

test("a multi-line run is not editable, so it cannot be flattened, and can still be removed", async t => {
  const h = await harness(t);
  const multiLine = { type: "command", run: "printf a\nprintf\tb" };
  await h.write(JSON.stringify({ connectors: [multiLine, { type: "command", run: "true" }] }));
  const label = "1. Command printf a printf b";
  await h.run("setup", label, undefined, ...SAVE_NO_TEST);
  assert.deepEqual(h.dialogs[1].options, ["Remove"]);
  assert.match(h.dialogs[1].title, /multi-line.*config\.json/);
  assert.equal(inputs(h).length, 0);
  assert.deepEqual((await saved(h)).connectors[0], multiLine);
  await h.run("setup", label, "Remove", ...SAVE_NO_TEST);
  assert.deepEqual((await saved(h)).connectors, [{ type: "command", run: "true" }]);
});

test("declining the test sends nothing and accepting sends once", async t => {
  const h = await harness(t);
  await h.run("setup", ...TELEGRAM, "Save", false);
  await flush();
  assert.deepEqual(h.sent, []);
  await h.run("setup", "Save", true);
  await flush();
  assert.deepEqual(h.sent, [{ chat_id: "-123", text: `🔔 session · ${h.root} · test` }]);
  assert.equal(h.dialogs.at(-1)?.title, "Send a test notification?");
});

test("a command connector runs only on an explicit yes", async t => {
  const h = await harness(t);
  await h.run("setup", "Add connector", "Shell command", "touch ran", "Save", false);
  await flush();
  await assert.rejects(lstat(join(h.root, "ran")), /ENOENT/);
  await h.run("setup", "Save", true);
  for (let i = 0; i < 100 && !(await lstat(join(h.root, "ran")).catch(() => undefined)); i++) await flush();
  assert.ok(await lstat(join(h.root, "ran")));
});

test("during a run, setup warns and opens no dialog", async t => {
  const h = await harness(t);
  h.emit("agent_start");
  await h.run("setup");
  assert.equal(h.dialogs.length, 0);
  assert.match(h.warnings.pop()!, /during a run/);
  await assert.rejects(lstat(h.path), /ENOENT/);
  h.emit("agent_before_settle", "completed");
  h.emit("agent_settled");
  await h.run("setup", "Cancel");
  assert.equal(h.dialogs.length, 1);
});

for (const [name, connector] of [
  ["an unset $VAR", { type: "telegram", botToken: "$NOTIFY_SETUP_UNSET", chatId: "-123" }],
  ["a kept unsupported connector", { type: "slack", url: "https://example.invalid" }],
] as const) {
  test(`saving with ${name} requires confirmation, offers no test and leaves /notify on armed`, async t => {
    const h = await harness(t);
    await h.write(JSON.stringify({ connectors: [{ type: "telegram", botToken: TOKEN, chatId: "-123" }] }));
    await h.run("on");
    assert.equal(h.status(), "🔔 on");
    const content = JSON.stringify({ connectors: [connector] });
    await h.write(content);

    await h.run("setup", "Save", false, "Cancel");
    assert.equal(await readFile(h.path, "utf8"), content);
    assert.equal(h.dialogs.at(-3)?.title, "Notify setup");
    assert.equal(h.dialogs.at(-2)?.title, "Save this invalid config?");

    h.dialogs.length = 0;
    await h.run("setup", "Nerd Font status icon: off", "Save", true);
    assert.deepEqual(h.dialogs.filter(dialog => dialog.kind === "confirm").map(dialog => dialog.title), ["Save this invalid config?"]);
    assert.equal(JSON.parse(await readFile(h.path, "utf8")).nerdFont, true);
    await assert.rejects(loadConfig(h.path));
    assert.equal(h.status(), " on");
    await flush();
    assert.deepEqual(h.sent, []);
  });
}

test("a valid save refreshes nerdFont status without changing arming", async t => {
  const h = await harness(t);
  await h.run("setup", ...TELEGRAM, ...SAVE_NO_TEST);
  assert.equal(h.status(), undefined);
  await h.run("on");
  assert.equal(h.status(), "🔔 on");
  await h.run("setup", "Nerd Font status icon: off", ...SAVE_NO_TEST);
  assert.equal(h.status(), " on");
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(check(), "condition not reached");
};
const COMMAND_CONFIG = JSON.stringify({ connectors: [{ type: "command", run: "true" }] });
const ROW = "1. Command true";
const OVERWRITE = "Overwrite outside changes?";
const ALREADY_OPEN = "Notify setup is already open; if you cannot see it, /reload clears it.";
const edit = (path: string, content: string, answer: Answer) => () => { writeFileSync(path, content); return answer; };

test("a second /notify setup while one is open opens no new dialog", async t => {
  const h = await harness(t);
  const first = h.start("setup", OPEN);
  await until(() => h.depth() === 1);
  await h.run("setup");
  h.emit("agent_start");
  await h.run("setup");
  await flush();
  assert.equal(h.dialogs.length, 1);
  assert.deepEqual(h.notices, [ALREADY_OPEN, ALREADY_OPEN]);
  h.emit("session_shutdown");
  await first;
  h.emit("session_start");
  await h.run("setup", "Cancel");
  await h.run("setup", "Cancel");
  assert.equal(h.dialogs.length, 3);
});

test("the command handler returns while setup stays open, so Pi's input loop is not held", async t => {
  const h = await harness(t);
  h.script.push(OPEN);
  await h.handler("setup");
  await until(() => h.depth() === 1);
  assert.equal(h.dialogs.length, 1);
  await h.handler("setup");
  assert.deepEqual(h.warnings, [ALREADY_OPEN]);
  h.emit("session_shutdown");
  await until(() => h.depth() === 0);
});

test("a setup failure is reported as a warning, and stays silent after session reset", async t => {
  const h = await harness(t);
  const { select } = h.ctx.ui;
  h.ctx.ui.select = (async () => { throw new Error("dialog broke"); }) as any;
  await h.run("setup");
  assert.deepEqual(h.warnings, ["Notify setup failed: dialog broke"]);

  h.warnings.length = 0;
  h.ctx.ui.select = (async () => { h.emit("session_shutdown"); throw new Error("dialog broke"); }) as any;
  await h.run("setup");
  assert.deepEqual(h.warnings, []);
  h.emit("session_start");
  h.ctx.ui.select = select;
  await h.run("setup", "Cancel");
  assert.equal(h.dialogs.length, 1);
});

test("a dialog that never resolves blocks a second setup only until session reset", async t => {
  const h = await harness(t);
  void h.start("setup", HUNG);
  await until(() => h.dialogs.length === 1);
  await h.run("setup");
  assert.equal(h.dialogs.length, 1);
  assert.deepEqual(h.warnings, [ALREADY_OPEN]);
  h.emit("session_shutdown");
  h.emit("session_start");
  await h.run("setup", "Cancel");
  assert.equal(h.dialogs.length, 2);
  assert.deepEqual(h.warnings, [ALREADY_OPEN]);
});

for (const [name, kind, answers] of [
  ["the menu", "select", [OPEN]],
  ["the connector type", "select", ["Add connector", OPEN]],
  ["the connector action", "select", [ROW, OPEN]],
  ["the masked token input", "input", ["Add connector", "Telegram", OPEN]],
  ["the chat ID input", "input", ["Add connector", "Telegram", TOKEN, OPEN]],
  ["the command input", "input", [ROW, "Edit", OPEN]],
  ["the invalid config confirm", "confirm", [ROW, "Remove", "Add connector", "Shell command", "$NOTIFY_SETUP_UNSET", "Save", OPEN]],
] as [string, string, Answer[]][]) {
  test(`session reset at ${name} closes setup, writes nothing and leaves prompt depth at zero`, async t => {
    const h = await harness(t);
    await h.write(COMMAND_CONFIG);
    const running = h.start("setup", ...answers);
    await until(() => h.script.length === 0 && h.depth() === 1);
    assert.equal(h.dialogs.at(-1)?.kind, kind);
    const opened = h.dialogs.length;
    h.emit("session_shutdown");
    await running;
    assert.equal(h.depth(), 0);
    assert.equal(h.dialogs.length, opened);
    assert.deepEqual(h.notices, []);
    assert.equal(await readFile(h.path, "utf8"), COMMAND_CONFIG);
  });
}

test("session reset at the overwrite confirm leaves the outside edit", async t => {
  const h = await harness(t);
  await h.write(COMMAND_CONFIG);
  const outside = JSON.stringify({ connectors: [], outside: true });
  const running = h.start("setup", edit(h.path, outside, "Save"), OPEN);
  await until(() => h.dialogs.at(-1)?.title === OVERWRITE);
  h.emit("session_shutdown");
  await running;
  assert.equal(h.depth(), 0);
  assert.equal(await readFile(h.path, "utf8"), outside);
});

const INVALID_CONFIG = JSON.stringify({ connectors: [{ type: "slack" }] });
for (const [name, content, before, choice] of [
  ["Save is chosen", COMMAND_CONFIG, [], "Save"],
  ["Save is chosen on an invalid config", INVALID_CONFIG, [], "Save"],
  ["a connector type is chosen", COMMAND_CONFIG, ["Add connector"], "Telegram"],
] as [string, string, Answer[], string][]) {
  test(`session reset at the moment ${name} opens no dialog and writes nothing`, async t => {
    const h = await harness(t);
    await h.write(content);
    await h.run("setup", ...before, () => { h.emit("session_shutdown"); return choice; });
    assert.equal(h.depth(), 0);
    assert.equal(h.dialogs.length, before.length + 1);
    assert.equal(await readFile(h.path, "utf8"), content);
  });
}

test("a write that fails after session reset warns nobody", async t => {
  const h = await harness(t);
  await h.write(COMMAND_CONFIG);
  t.mock.method(fsPromises, "rename", async () => { h.emit("session_shutdown"); throw new Error("EIO"); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await h.run("setup", "Save");
  assert.deepEqual(h.notices, []);
  assert.equal(await readFile(h.path, "utf8"), COMMAND_CONFIG);
});

test("an old setup closing after reset does not release the new setup's guard", async t => {
  const h = await harness(t);
  const first = h.start("setup", OPEN);
  await until(() => h.depth() === 1);
  h.emit("session_shutdown");
  h.emit("session_start");
  const second = h.start("setup", OPEN);
  await first;
  await until(() => h.depth() === 1 && h.dialogs.length === 2);
  await h.run("setup");
  await flush();
  assert.equal(h.dialogs.length, 2);
  h.emit("session_shutdown");
  await second;
});

test("session reset during the write touches no stale ctx and offers no test", async t => {
  const h = await harness(t);
  await h.write(COMMAND_CONFIG);
  const { rename } = fsPromises;
  t.mock.method(fsPromises, "rename", async (from: string, to: string) => { h.emit("session_shutdown"); await rename(from, to); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await h.run("setup", "Save");
  assert.equal(h.dialogs.length, 1);
  assert.deepEqual(h.notices, []);
  assert.deepEqual(await saved(h), JSON.parse(COMMAND_CONFIG));
});

test("session reset at the test offer closes it without sending", async t => {
  const h = await harness(t);
  const running = h.start("setup", "Add connector", "Shell command", "touch ran", "Save", OPEN);
  await until(() => h.dialogs.at(-1)?.title === "Send a test notification?");
  h.emit("session_shutdown");
  await running;
  await flush();
  assert.equal(h.depth(), 0);
  await assert.rejects(lstat(join(h.root, "ran")), /ENOENT/);
});

test("changing the file after opening asks first, and declining leaves the outside edit", async t => {
  const h = await harness(t);
  await h.write(COMMAND_CONFIG);
  const outside = JSON.stringify({ connectors: [{ type: "command", run: "outside" }] });
  await h.run("setup", edit(h.path, outside, "Save"), false, "Cancel");
  assert.deepEqual(h.dialogs.map(dialog => dialog.title), ["Notify setup", OVERWRITE, "Notify setup"]);
  assert.equal(await readFile(h.path, "utf8"), outside);

  await h.run("setup", edit(h.path, COMMAND_CONFIG, "Nerd Font status icon: off"), "Save", true, false);
  assert.deepEqual(await saved(h), { connectors: [{ type: "command", run: "outside" }], nerdFont: true });
});

test("a file created or removed after opening also asks, and rewriting the same bytes does not", async t => {
  const h = await harness(t);
  const created = () => { mkdirSync(join(h.root, "pi-notify"), { recursive: true }); return edit(h.path, COMMAND_CONFIG, "Save")(); };
  await h.run("setup", ...TELEGRAM, created, false, "Cancel");
  assert.equal(h.dialogs.at(-2)?.title, OVERWRITE);
  assert.equal(await readFile(h.path, "utf8"), COMMAND_CONFIG);

  await h.run("setup", () => { rmSync(h.path); return "Save"; }, false, "Cancel");
  assert.equal(h.dialogs.at(-2)?.title, OVERWRITE);
  await assert.rejects(lstat(h.path), /ENOENT/);

  await h.write(COMMAND_CONFIG);
  h.dialogs.length = 0;
  await h.run("setup", edit(h.path, COMMAND_CONFIG, "Save"), false);
  assert.ok(!h.dialogs.some(dialog => dialog.title === OVERWRITE));
});

for (const [args, shown] of [["", "🔔 once"], ["on", "🔔 on"], ["off", undefined]] as const) {
  test(`/notify ${args || "(no args)"} status is the same before and after setup`, async t => {
    const h = await harness(t);
    await h.write(JSON.stringify({ connectors: [{ type: "telegram", botToken: TOKEN, chatId: "-1" }] }));
    await h.run(args);
    assert.equal(h.status(), shown);
    await h.run("setup", "Cancel");
    assert.equal(h.status(), shown);
    await h.run("setup", ...SAVE_NO_TEST);
    assert.equal(h.status(), shown);
    h.emit("agent_start");
    h.emit("agent_before_settle", "completed");
    h.emit("agent_settled");
    await flush();
    assert.equal(h.sent.length, shown ? 1 : 0);
  });
}

test("non-TUI modes open no dialog and bad subcommands show setup in usage", async t => {
  const h = await harness(t);
  h.ctx.mode = "rpc";
  await h.run("setup");
  assert.equal(h.dialogs.length, 0);
  h.ctx.mode = "tui";
  await h.write(JSON.stringify({ connectors: [{ type: "command", run: "true" }] }));
  await h.run("bogus");
  assert.match(h.warnings.pop()!, /\[on\|off\|test\|setup\]/);
});

test("saveDraft replaces atomically, tightens mode and writes through symlinks", async t => {
  const root = await mkdtemp(join(tmpdir(), "notify-save-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "plain", "config.json");
  await mkdir(join(root, "plain"));
  await writeFile(file, "old", { mode: 0o644 });
  await saveDraft(file, { connectors: [], extra: 1 });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { connectors: [], extra: 1 });
  assert.deepEqual(await readdir(join(root, "plain")), ["config.json"]);

  await mkdir(join(root, "real"));
  await mkdir(join(root, "links"));
  await symlink(join(root, "real"), join(root, "links", "dir"));
  const link = join(root, "links", "dir", "config.json");
  await writeFile(join(root, "real", "actual.json"), "old");
  await symlink("actual.json", link);
  await saveDraft(link, { connectors: [] });
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.deepEqual(JSON.parse(await readFile(join(root, "real", "actual.json"), "utf8")), { connectors: [] });

  const dangling = join(root, "links", "dangling.json");
  await symlink(join(root, "made", "config.json"), dangling);
  assert.deepEqual(await loadDraft(dangling), { connectors: [] });
  await saveDraft(dangling, { connectors: [] });
  assert.ok((await lstat(dangling)).isSymbolicLink());
  assert.equal((await stat(join(root, "made"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "made", "config.json"))).mode & 0o777, 0o600);

  await symlink(join(root, "loop-b"), join(root, "loop-a"));
  await symlink(join(root, "loop-a"), join(root, "loop-b"));
  await assert.rejects(saveDraft(join(root, "loop-a"), { connectors: [] }), /Too many symlinks/);
});

test("saveDraft failure leaves the old file and no temp file", async t => {
  const root = await mkdtemp(join(tmpdir(), "notify-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "config.json");
  await mkdir(target);
  await assert.rejects(saveDraft(target, { connectors: [] }));
  assert.deepEqual(await readdir(root), ["config.json"]);
});
