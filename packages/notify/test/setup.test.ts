import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { loadConfig, saveDraft } from "../src/config.ts";
import { SetupMenu } from "../src/setup-menu.ts";
import { TextInput } from "../src/text-input.ts";

const TOKEN = "123:fake-token";
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const CLEAR = "\x15";

const OPEN = Symbol("stays open until the signal aborts");
const HUNG = Symbol("replaced by another dialog, so never resolves");

interface MenuAnswer { row: string; nth?: number; after?: () => void }
type Answer = string | boolean | undefined | symbol | MenuAnswer | (() => Answer);

const tidy = (text: string) => text.replace(/\s+/g, " ").trim();

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
  const dialogs: { kind: string; title: string; options?: string[]; message?: string; screen?: string; cursor?: number }[] = [];
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
  let openMenu: SetupMenu | undefined;
  const terminal = { rows: 40 };
  const driveMenu = (menu: SetupMenu) => {
    const screen = menu.render(80);
    const rows = screen.filter(line => line.startsWith(" → ") || line.startsWith("   "));
    const options = rows.map(line => tidy(line.slice(3)));
    const cursor = rows.findIndex(line => line.startsWith(" → "));
    dialogs.push({ kind: "menu", title: tidy(screen[0]), options, cursor, screen: screen.join("\n") });
    const answer = next();
    if (typeof answer === "symbol") return;
    if (answer === undefined) { menu.handleInput(ESC); return; }
    const { row, nth = 0, after } = (typeof answer === "string" ? { row: answer } : answer) as MenuAnswer;
    const target = options.flatMap((option, i) => option === tidy(row) ? [i] : [])[nth];
    check(target !== undefined, `no row ${row} in ${options}`);
    for (let i = cursor; i < target; i++) menu.handleInput(DOWN);
    for (let i = cursor; i > target; i--) menu.handleInput(UP);
    menu.handleInput(ENTER);
    after?.();
    if (openMenu === menu) driveMenu(menu);
  };
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
      component = factory({ requestRender() {}, terminal }, theme, getKeybindings(), (value: unknown) => { openMenu = undefined; resolve(value); component.dispose?.(); });
      if (component instanceof SetupMenu) { openMenu = component; driveMenu(component); return; }
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
    root, path, ctx, script, dialogs, screens, warnings, notices, sent, start, terminal,
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
const until = async (check: () => boolean) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(check(), "condition not reached");
};
const inputs = (h: { dialogs: { kind: string; screen?: string }[] }) => h.dialogs.filter(dialog => dialog.kind === "input").map(dialog => dialog.screen!);
const saved = async (h: { path: string }) => JSON.parse(await readFile(h.path, "utf8"));
const edit = (path: string, content: string, answer: Answer) => () => { writeFileSync(path, content); return answer; };
const onRename = (t: TestContext, fn: (from: string, to: string) => Promise<void>) => {
  t.mock.method(fsPromises, "rename", fn);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
};

const TELEGRAM = ["+ Add connector", "Telegram", TOKEN, "-123"];
const SAVE_NO_TEST = ["Save and close", false];
const COMMAND_CONFIG = JSON.stringify({ connectors: [{ type: "command", run: "true" }] });
const INVALID_CONFIG = JSON.stringify({ connectors: [{ type: "slack" }] });
const ROW = "Command, true";
const OVERWRITE = "Overwrite outside changes?";
const ALREADY_OPEN = "Notify setup is already open; if you cannot see it, /reload clears it.";

test("from no config, the dialogs write a config loadConfig accepts with owner-only permissions", async t => {
  const h = await harness(t);
  await h.run("setup", ...TELEGRAM, "Notify when waiting for input off", "Nerd Font status icon off", ...SAVE_NO_TEST);
  assert.deepEqual(h.dialogs[0].options, ["+ Add connector", "Notify when waiting for input off", "Nerd Font status icon off", "Save and close", "Discard and close"]);
  assert.deepEqual(await loadConfig(h.path), {
    onPrompt: true, nerdFont: true, connectors: [{ type: "telegram", botToken: TOKEN, chatId: "-123" }],
  });
  assert.equal((await stat(h.path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(h.root, "pi-notify"))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(h.root, "pi-notify")), ["config.json"]);
  assert.deepEqual(h.warnings, []);
});

test("$VAR values are stored unexpanded", async t => {
  const h = await harness(t);
  await h.run("setup", "+ Add connector", "Telegram", "$NOTIFY_SETUP_TOKEN", "$NOTIFY_SETUP_CHAT", "Save and close", true);
  assert.deepEqual((await saved(h)).connectors, [{ type: "telegram", botToken: "$NOTIFY_SETUP_TOKEN", chatId: "$NOTIFY_SETUP_CHAT" }]);
});

test("Discard and close or Esc writes nothing and sub-dialog Esc returns to the menu", async t => {
  const h = await harness(t);
  await h.run("setup", ...TELEGRAM, "Discard and close");
  await h.run("setup", ...TELEGRAM, undefined);
  await assert.rejects(lstat(h.path), /ENOENT/);
  await h.run("setup", "+ Add connector", undefined, "+ Add connector", "Telegram", undefined, "+ Add connector", "Telegram", TOKEN, undefined,
    "+ Add connector", "Shell command", undefined, "Discard and close");
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

test("unreadable config is refused rather than treated as missing", async t => {
  const h = await harness(t);
  await mkdir(h.path, { recursive: true });
  await h.run("setup");
  assert.match(h.warnings.pop()!, /Cannot read/);
  assert.equal(h.dialogs.length, 0);
});

test("masked input never renders a literal token but keeps $VAR readable", async t => {
  const h = await harness(t);
  await h.run("setup", ...TELEGRAM, "Discard and close");
  assert.ok(h.screens.length > 0);
  for (const screen of h.screens) assert.ok(!screen.includes(TOKEN.slice(0, 5)) && !screen.includes("fake"), screen);

  const render = (value: string, mask: boolean, width = 80) => {
    const input = new TextInput({ title: "t", mask }, theme, () => {});
    input.focused = true;
    input.handleInput(value);
    return input.render(width).join("\n");
  };
  assert.match(render(TOKEN, true), /•{14}/);
  assert.ok(render("$MY_TOKEN", true).includes("$MY_TOKEN"));
  assert.ok(!render("$MY:secret", true).includes("secret"));
  assert.ok(render(TOKEN, false).includes(TOKEN));
  assert.ok(!render(`\x1b[200~${TOKEN}\x1b[201~`, true).includes("fake"));
  assert.ok(!render(TOKEN, true, 5).includes("fake"));
});

test("no dialog, prefill or notice shows a literal token, including one hand-placed in chatId", async t => {
  const h = await harness(t);
  await h.write(JSON.stringify({ connectors: [
    { type: "telegram", botToken: TOKEN, chatId: "-1" },
    { type: "telegram", botToken: TOKEN, chatId: TOKEN },
    { type: TOKEN, botToken: TOKEN },
    TOKEN,
  ] }));
  await h.run("setup", "Telegram, chat -1", "Edit", "bad/value", "", "", "Telegram, chat (invalid) (needs fixing)", "Edit", "", "not-a-chat", undefined, "Save and close", true);
  assert.deepEqual(h.dialogs[0].options!.slice(1, 4), ["Telegram, chat (invalid) (needs fixing)", "Unsupported connector (needs fixing) (remove only)", "Not a connector (needs fixing) (remove only)"]);
  assert.ok(inputs(h)[0].includes("Leave empty to keep the stored token"));
  assert.ok(h.notices.length > 0 && h.screens.length > 0);
  const shown = JSON.stringify([h.dialogs, h.screens, h.notices]);
  for (const secret of [TOKEN, "fake", "123:", "bad/value"]) assert.ok(!shown.includes(secret), secret);
  assert.equal((await saved(h)).connectors[0].botToken, TOKEN);
});

test("entry checks reject bad values without echoing them and re-prompt", async t => {
  const h = await harness(t);
  await h.run("setup", "+ Add connector", "Telegram", "secret/token", " ", TOKEN, "not-a-chat", `${CLEAR}@ok`, ...SAVE_NO_TEST);
  assert.equal(h.warnings.length, 3);
  for (const warning of h.warnings) assert.ok(!warning.includes("secret") && !warning.includes("not-a-chat"));
  h.warnings.length = 0;
  await h.run("setup", "+ Add connector", "Shell command", "  ", undefined, "Discard and close");
  assert.match(h.warnings.pop()!, /cannot be empty/);
  assert.deepEqual((await loadConfig(h.path)).connectors, [{ type: "telegram", botToken: TOKEN, chatId: "@ok" }]);
});

test("Save is blocked with no connectors, including after removing the last, and Discard leaves the file", async t => {
  const h = await harness(t);
  await h.run("setup", "Save and close", "Discard and close");
  assert.match(h.warnings.pop()!, /Add a connector/);
  await assert.rejects(lstat(h.path), /ENOENT/);
  const content = JSON.stringify({ connectors: [{ type: "telegram", botToken: TOKEN, chatId: "-1" }] });
  await h.write(content);
  await h.run("setup", "Telegram, chat -1", "Remove", "Save and close", "Discard and close");
  assert.match(h.warnings.pop()!, /Add a connector/);
  assert.equal(await readFile(h.path, "utf8"), content);
});

test("existing connectors of every kind and unknown keys are preserved on Save", async t => {
  const h = await harness(t);
  const existing = [{ type: "telegram", botToken: TOKEN, chatId: "-1", label: "phone" }, { type: "command", run: "echo\nhi" }, "stray", { type: "slack", url: "x" }];
  await h.write(JSON.stringify({ extra: true, connectors: existing }));
  await h.run("setup", "Telegram, chat -1", undefined, "Save and close", true);
  assert.deepEqual(await saved(h), { extra: true, connectors: existing });

  await h.write(JSON.stringify({ custom: { a: 1 }, onPrompt: "yes" }));
  await h.run("setup", ...TELEGRAM, "Save and close", true);
  const config = await saved(h);
  assert.deepEqual([config.custom, config.onPrompt], [{ a: 1 }, "yes"]);
});

test("changing only the chat ID leaves the token, $VAR values and unknown keys unchanged", async t => {
  const h = await harness(t);
  const literal = { label: "phone", botToken: TOKEN, type: "telegram", chatId: "-1", extra: { a: [1] } };
  const variable = { type: "telegram", botToken: "$NOTIFY_SETUP_TOKEN", chatId: "$NOTIFY_SETUP_CHAT", label: "env" };
  process.env.NOTIFY_SETUP_TOKEN = TOKEN;
  process.env.NOTIFY_SETUP_CHAT = "-5";
  t.after(() => { delete process.env.NOTIFY_SETUP_TOKEN; delete process.env.NOTIFY_SETUP_CHAT; });
  await h.write(JSON.stringify({ custom: true, connectors: [literal, variable] }));
  await h.run("setup", "Telegram, chat -1", "Edit", "", `${CLEAR}-999`, "Telegram, chat $NOTIFY_SETUP_CHAT", "Edit", "", "", ...SAVE_NO_TEST);
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
  await h.run("setup", "Telegram, chat -1 (needs fixing)", "Edit", ":secret", CLEAR, "", "Save and close", true);
  assert.ok(inputs(h)[1].includes("> $NOTIFY_SETUP_UNSET") && !inputs(h)[1].includes("secret"));
  assert.equal(h.warnings.length, 1);
  assert.deepEqual(await saved(h), { connectors: [content] });
});

test("Esc during an edit keeps the stored connector", async t => {
  const h = await harness(t);
  const connector = { type: "telegram", botToken: TOKEN, chatId: "-1" };
  await h.write(JSON.stringify({ connectors: [connector] }));
  await h.run("setup", "Telegram, chat -1", "Edit", undefined, "Telegram, chat -1", "Edit", "$NOTIFY_SETUP_NEW", undefined, "Save and close", false);
  assert.deepEqual(await saved(h), { connectors: [connector] });
});

test("command edits prefill run, keep unknown keys and keep an unchanged run byte-identical", async t => {
  const h = await harness(t);
  await h.write(JSON.stringify({ connectors: [{ type: "command", run: " echo hi ", label: "shell" }, { type: "command", run: "true" }] }));
  await h.run("setup", "Command,  echo hi ", "Edit", "", "Command, true", "Edit", " --x", ...SAVE_NO_TEST);
  assert.ok(inputs(h)[0].includes(">  echo hi"));
  assert.deepEqual((await saved(h)).connectors, [{ type: "command", run: " echo hi ", label: "shell" }, { type: "command", run: "true --x" }]);
});

test("a multi-line run can only be removed, so it cannot be flattened", async t => {
  const h = await harness(t);
  const multiLine = { type: "command", run: "printf a\nprintf\tb" };
  await h.write(JSON.stringify({ connectors: [multiLine, { type: "command", run: "true" }] }));
  await h.run("setup", "Command, printf a printf b (remove only)", undefined, ...SAVE_NO_TEST);
  assert.match(h.dialogs[1].title, /multi-line.*config\.json/);
  assert.deepEqual((await saved(h)).connectors[0], multiLine);
});

test("a row is marked remove only when its select offers only Remove, and shows no control characters", async t => {
  const h = await harness(t);
  await h.write(JSON.stringify({ connectors: [
    { type: "telegram", botToken: TOKEN, chatId: "$NOTIFY_SETUP_UNSET" },
    { type: "command", run: "true" },
    { type: "command", run: 5 },
    { type: "command", run: "echo\x07hi\x9f" },
    { type: "slack" },
    null,
  ] }));
  const rows = [
    "Telegram, chat $NOTIFY_SETUP_UNSET (needs fixing)",
    "Command, true",
    "Command, (invalid) (needs fixing)",
    "Command, echo hi (remove only)",
    "Unsupported connector (needs fixing) (remove only)",
    "Not a connector (needs fixing) (remove only)",
  ];
  await h.run("setup", ...rows.flatMap(row => [row, undefined]), "Discard and close");
  assert.deepEqual(h.dialogs[0].options!.slice(0, rows.length), rows);
  const actions = h.dialogs.filter(dialog => dialog.title !== "Notify setup").map(dialog => dialog.options);
  assert.deepEqual(actions, rows.map(row => row.endsWith("(remove only)") ? ["Remove"] : ["Edit", "Remove"]));
});

test("identical Telegram rows act on the chosen connector", async t => {
  const h = await harness(t);
  const same = { type: "telegram", botToken: TOKEN, chatId: "-1" };
  await h.write(JSON.stringify({ connectors: [same, same] }));
  await h.run("setup", { row: "Telegram, chat -1", nth: 1 }, "Edit", "", `${CLEAR}-2`, ...SAVE_NO_TEST);
  assert.deepEqual((await saved(h)).connectors, [same, { ...same, chatId: "-2" }]);

  const [a, b] = [{ ...same, tag: "a" }, { ...same, tag: "b" }];
  await h.write(JSON.stringify({ connectors: [a, b] }));
  await h.run("setup", { row: "Telegram, chat -1", nth: 0 }, "Remove", ...SAVE_NO_TEST);
  assert.deepEqual((await saved(h)).connectors, [b]);
});

const SECTIONS = [
  { header: "First", rows: [{ id: 0, label: "same" }, { id: 1, label: "same" }] },
  { header: "Second", rows: [{ id: "x", label: "x", note: "on " }] },
  { rows: [{ id: "y", label: "y" }] },
];
const menu = (done: (id: unknown) => void = () => {}, options = {}) => new SetupMenu({ title: "T", hint: "H", sections: SECTIONS, ...options }, theme, getKeybindings(), done);

test("the cursor visits only rows, stops at the ends, and the menu returns the row id", () => {
  const chosen: unknown[] = [];
  const m = menu(id => chosen.push(id));
  const line = () => m.render(30).findIndex(text => text.startsWith(" → "));
  const stops = [3, 4, 7, 10];
  assert.equal(line(), stops[0]);
  m.handleInput(UP);
  assert.equal(line(), stops[0]);
  for (const stop of stops.slice(1)) { m.handleInput(DOWN); assert.equal(line(), stop); }
  m.handleInput(DOWN);
  assert.equal(line(), stops.at(-1));
  for (const stop of stops.slice(0, -1).reverse()) { m.handleInput(UP); assert.equal(line(), stop); }
  m.handleInput("j");
  assert.equal(line(), stops[1]);
  m.handleInput("k");
  m.handleInput(ENTER);
  m.handleInput(DOWN);
  m.handleInput(ENTER);
  m.handleInput(ESC);
  assert.deepEqual(chosen, [0, 1, undefined]);
  assert.ok(menu(() => {}, { initial: "y" }).render(30)[10].startsWith(" → y"));
  assert.ok(menu(() => {}, { initial: "gone" }).render(30)[3].startsWith(" → same"));
});

test("the cursor stays on the row acted on, clamps after a removal and falls back to Add connector", async t => {
  const h = await harness(t);
  await h.write(JSON.stringify({ connectors: [{ type: "command", run: "a" }, { type: "command", run: "b" }] }));
  await h.run("setup",
    "Nerd Font status icon off",
    "Command, b", undefined,
    "+ Add connector", undefined,
    "Command, b", "Remove",
    "Command, a", "Remove",
    "Discard and close");
  const menus = h.dialogs.filter(dialog => dialog.kind === "menu");
  assert.deepEqual(menus.map(dialog => dialog.options![dialog.cursor!]), [
    "Command, a",
    "Nerd Font status icon on",
    "Command, b",
    "+ Add connector",
    "Command, a",
    "+ Add connector",
  ]);
});

test("a toggle stays in the open menu without resolving, and only a save writes it", async t => {
  const chosen: unknown[] = [];
  let value = " off";
  const m = menu(id => chosen.push(id), { sections: [{ rows: [{ id: "x", label: "x", note: value, toggle: () => value = " on " }] }] });
  m.handleInput(ENTER);
  assert.deepEqual(chosen, []);
  assert.ok(m.render(30).some(line => line.startsWith(" → x on")));

  const h = await harness(t);
  const content = JSON.stringify({ onPrompt: "yes", connectors: [{ type: "command", run: "true" }] });
  await h.write(content);
  await h.run("setup", "Nerd Font status icon off", "Nerd Font status icon on", "Nerd Font status icon off", undefined);
  assert.equal(await readFile(h.path, "utf8"), content);

  await h.run("setup", "Notify when waiting for input off", ...SAVE_NO_TEST);
  assert.equal((await saved(h)).onPrompt, true);
});

test("rendered lines fit every width and keep the row's note", () => {
  const sections = [{ rows: [{ id: 0, label: "x".repeat(200), note: " (remove only)" }, { id: 1, label: "界".repeat(100) }] }];
  for (const width of [40, 30, 20, 10, 5, 3, 1]) {
    assert.ok(menu(() => {}, { sections }).render(width).every(line => visibleWidth(line) <= width), `menu overflows width ${width}`);
  }
  const row = menu(() => {}, { sections }).render(40)[3].replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(row.startsWith(" → xxx") && row.endsWith("… (remove only)"), row);
});

test("a short terminal keeps the cursor row visible and the menu within its height", async t => {
  for (const rows of [14, 10, 5, 1]) {
    const m = menu(() => {}, { rows: () => rows });
    for (let i = 0; i < 4; i++) {
      const lines = m.render(30);
      assert.ok(lines.length <= Math.max(3, rows - 4));
      assert.ok(lines.some(line => line.startsWith(" → ")), `cursor hidden at ${rows} rows`);
      m.handleInput(DOWN);
    }
  }
  assert.equal(menu(() => {}, { rows: () => 40 }).render(30).length, 13, "a tall terminal shows everything");

  const h = await harness(t);
  h.terminal.rows = 10;
  await h.run("setup", undefined);
  assert.equal(h.dialogs[0].screen!.split("\n").length, 6);
});

test("declining the test sends nothing, and only an explicit yes sends and runs commands", async t => {
  const h = await harness(t);
  await h.run("setup", ...TELEGRAM, "+ Add connector", "Shell command", "touch ran", ...SAVE_NO_TEST);
  await flush();
  assert.deepEqual(h.sent, []);
  await assert.rejects(lstat(join(h.root, "ran")), /ENOENT/);
  await h.run("setup", "Save and close", true);
  await until(() => h.sent.length > 0);
  assert.deepEqual(h.sent, [{ chat_id: "-123", text: `🔔 session · ${h.root} · test` }]);
  for (let i = 0; i < 100 && !(await lstat(join(h.root, "ran")).catch(() => undefined)); i++) await flush();
  assert.ok(await lstat(join(h.root, "ran")));
});

test("during a run, setup warns and opens no dialog", async t => {
  const h = await harness(t);
  h.emit("agent_start");
  await h.run("setup");
  assert.equal(h.dialogs.length, 0);
  assert.match(h.warnings.pop()!, /during a run/);
  h.emit("agent_before_settle", "completed");
  h.emit("agent_settled");
  await h.run("setup", "Discard and close");
  assert.equal(h.dialogs.length, 1);
});

test("saving an invalid config requires confirmation, offers no test and leaves /notify on armed", async t => {
  const h = await harness(t);
  await h.write(JSON.stringify({ connectors: [{ type: "telegram", botToken: TOKEN, chatId: "-123" }] }));
  await h.run("on");
  assert.equal(h.status(), "🔔 on");
  const content = JSON.stringify({ connectors: [{ type: "telegram", botToken: "$NOTIFY_SETUP_UNSET", chatId: "-123" }] });
  await h.write(content);

  await h.run("setup", "Save and close", false, "Discard and close");
  assert.equal(await readFile(h.path, "utf8"), content);
  assert.equal(h.dialogs.at(-2)?.title, "Save this invalid config?");

  h.dialogs.length = 0;
  await h.run("setup", "Nerd Font status icon off", "Save and close", true);
  assert.deepEqual(h.dialogs.filter(dialog => dialog.kind === "confirm").map(dialog => dialog.title), ["Save this invalid config?"]);
  assert.equal((await saved(h)).nerdFont, true);
  await assert.rejects(loadConfig(h.path));
  assert.equal(h.status(), "\uf0f3 on");
  await flush();
  assert.deepEqual(h.sent, []);
});

test("only one setup opens per session, and an old setup closing does not release the new guard", async t => {
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
  h.emit("session_start");
  const second = h.start("setup", OPEN);
  await first;
  await until(() => h.depth() === 1 && h.dialogs.length === 2);
  await h.run("setup");
  await flush();
  assert.equal(h.dialogs.length, 2);

  h.emit("session_shutdown");
  await second;
  h.emit("session_start");
  await h.run("setup", "Discard and close");
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
  h.ctx.ui.custom = (async () => { throw new Error("dialog broke"); }) as any;
  await h.run("setup");
  assert.deepEqual(h.warnings, ["Notify setup failed: dialog broke"]);

  h.warnings.length = 0;
  h.ctx.ui.custom = (async () => { h.emit("session_shutdown"); throw new Error("dialog broke"); }) as any;
  await h.run("setup");
  assert.deepEqual(h.warnings, []);
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
  await h.run("setup", "Discard and close");
  assert.equal(h.dialogs.length, 2);
});

for (const [kind, answers] of [
  ["menu", [OPEN]],
  ["select", ["+ Add connector", OPEN]],
  ["input", ["+ Add connector", "Telegram", OPEN]],
  ["confirm", [ROW, "Remove", "+ Add connector", "Shell command", "$NOTIFY_SETUP_UNSET", "Save and close", OPEN]],
] as [string, Answer[]][]) {
  test(`session reset at an open ${kind} closes setup, writes nothing and leaves prompt depth at zero`, async t => {
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

const saveThen = (reset: () => void): Answer => ({ row: "Save and close", after: reset });
for (const [name, content, before, choose] of [
  ["Save and close is chosen", COMMAND_CONFIG, [], saveThen],
  ["Save and close is chosen on an invalid config", INVALID_CONFIG, [], saveThen],
  ["a connector type is chosen", COMMAND_CONFIG, ["+ Add connector"], (reset: () => void) => () => { reset(); return "Telegram"; }],
] as [string, string, Answer[], (reset: () => void) => Answer][]) {
  test(`session reset at the moment ${name} opens no dialog and writes nothing`, async t => {
    const h = await harness(t);
    await h.write(content);
    await h.run("setup", ...before, choose(() => h.emit("session_shutdown")));
    assert.equal(h.depth(), 0);
    assert.equal(h.dialogs.length, before.length + 1);
    assert.equal(await readFile(h.path, "utf8"), content);
  });
}

test("a write that fails after session reset warns nobody", async t => {
  const h = await harness(t);
  await h.write(COMMAND_CONFIG);
  onRename(t, async () => { h.emit("session_shutdown"); throw new Error("EIO"); });
  await h.run("setup", "Save and close");
  assert.deepEqual(h.notices, []);
  assert.equal(await readFile(h.path, "utf8"), COMMAND_CONFIG);
});

test("session reset during the write touches no stale ctx and offers no test", async t => {
  const h = await harness(t);
  await h.write(COMMAND_CONFIG);
  const { rename } = fsPromises;
  onRename(t, async (from, to) => { h.emit("session_shutdown"); await rename(from, to); });
  await h.run("setup", "Save and close");
  assert.equal(h.dialogs.length, 1);
  assert.deepEqual(h.notices, []);
  assert.deepEqual(await saved(h), JSON.parse(COMMAND_CONFIG));
});

test("session reset at the test offer closes it without sending", async t => {
  const h = await harness(t);
  const running = h.start("setup", "+ Add connector", "Shell command", "touch ran", "Save and close", OPEN);
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
  await h.run("setup", edit(h.path, outside, "Save and close"), false, "Discard and close");
  assert.deepEqual(h.dialogs.map(dialog => dialog.title), ["Notify setup", OVERWRITE, "Notify setup"]);
  assert.equal(await readFile(h.path, "utf8"), outside);

  await h.run("setup", edit(h.path, COMMAND_CONFIG, "Nerd Font status icon off"), "Save and close", true, false);
  assert.deepEqual(await saved(h), { connectors: [{ type: "command", run: "outside" }], nerdFont: true });
});

test("setup leaves a one-shot /notify armed", async t => {
  const h = await harness(t);
  await h.write(JSON.stringify({ connectors: [{ type: "telegram", botToken: TOKEN, chatId: "-1" }] }));
  await h.run("");
  await h.run("setup", "Discard and close");
  assert.equal(h.status(), "🔔 once");
  await h.run("setup", ...SAVE_NO_TEST);
  assert.equal(h.status(), "🔔 once");
  h.emit("agent_start");
  h.emit("agent_before_settle", "completed");
  h.emit("agent_settled");
  await flush();
  assert.equal(h.sent.length, 1);
});

test("non-TUI modes open no dialog and bad subcommands show setup in usage", async t => {
  const h = await harness(t);
  h.ctx.mode = "rpc";
  await h.run("setup");
  assert.equal(h.dialogs.length, 0);
  h.ctx.mode = "tui";
  await h.write(COMMAND_CONFIG);
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
