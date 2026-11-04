import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig, loadDraft, saveDraft } from "../src/config.ts";
import { TextInput } from "../src/text-input.ts";

const TOKEN = "123:fake-token";
const theme = { fg: (_color: string, text: string) => text } as any;
const ENTER = "\r";
const ESC = "\x1b";

type Answer = string | boolean | undefined;

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
  extension({ on: (name: string, fn: any) => handlers.set(name, fn),
    registerCommand: (_name: string, def: any) => { command = def.handler; },
    registerTool: () => {}, getActiveTools: () => [], setActiveTools: () => {},
  } as any);
  const script: Answer[] = [];
  const dialogs: { kind: string; title: string; options?: string[] }[] = [];
  const screens: string[] = [];
  const warnings: string[] = [];
  const sent: { chat_id: string; text: string }[] = [];
  let status: string | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    sent.push(JSON.parse(options.body as string));
    return new Response('{"ok":true}');
  });
  const next = () => {
    assert.ok(script.length > 0, `unexpected dialog after: ${dialogs.at(-1)?.title}`);
    return script.shift();
  };
  const ctx = { mode: "tui", cwd: root, sessionManager: { getSessionName: () => "session" }, ui: {
    setStatus: (_key: string, text: string | undefined) => { status = text; },
    notify: (text: string, type: string) => { if (type === "warning") warnings.push(text); },
    select: async (title: string, options: string[]) => {
      dialogs.push({ kind: "select", title, options });
      const answer = next();
      if (answer !== undefined) assert.ok(options.includes(answer as string), `no option ${answer} in ${options}`);
      return answer;
    },
    confirm: async (title: string) => { dialogs.push({ kind: "confirm", title }); return next(); },
    custom: (factory: any) => new Promise(resolve => {
      const component = factory({ requestRender() {} }, theme, {}, resolve);
      dialogs.push({ kind: "input", title: component.render(80)[0] });
      const answer = next();
      if (answer === undefined) { component.handleInput(ESC); return; }
      for (const char of answer as string) { component.handleInput(char); screens.push(component.render(80).join("\n")); }
      component.handleInput(ENTER);
    }),
  } };
  const path = join(root, "pi-notify", "config.json");
  return {
    root, path, ctx, script, dialogs, screens, warnings, sent,
    status: () => status,
    emit: (name: string, outcome?: string) => handlers.get(name)!({ outcome }, ctx),
    run: async (args: string, ...answers: Answer[]) => {
      script.push(...answers);
      await command(args, ctx);
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
  await h.run("setup", "1. Command echo hi", "Cancel");
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

test("existing connectors are listed without tokens and preserved, not edited", async t => {
  const h = await harness(t);
  const existing = [{ type: "telegram", botToken: TOKEN, chatId: "-1", label: "phone" }, { type: "command", run: "echo\nhi" }, "stray", { type: "slack", url: "x" }];
  await h.write(JSON.stringify({ extra: true, connectors: existing }));
  await h.run("setup", "1. Telegram -1", undefined, "Save", true);
  const options = h.dialogs[0].options!;
  assert.deepEqual(options.slice(0, 5), ["1. Telegram -1", "2. Command echo hi", "3. Unsupported connector", "4. Unsupported connector", "Add connector"]);
  for (const dialog of h.dialogs) assert.ok(!JSON.stringify(dialog).includes(TOKEN));
  assert.deepEqual(JSON.parse(await readFile(h.path, "utf8")), { extra: true, connectors: existing });
  assert.equal(h.dialogs.filter(dialog => dialog.title === "Notify setup").length, 2);
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
