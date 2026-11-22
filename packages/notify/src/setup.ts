import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { telegramBot, telegramChats, TelegramTokenRejected } from "./connectors.ts";
import { loadDraft, parseConfig, readRaw, saveDraft, validBotTokenEntry, validChatIdEntry, variableEntry, type Draft } from "./config.ts";
import { SetupMenu, type MenuRow, type MenuSection, type RowId, type SetupMenuOptions } from "./setup-menu.ts";
import { TextInput, type TextInputOptions } from "./text-input.ts";

export interface SetupResult { draft: Draft; valid: boolean }

const ADD = "+ Add destination";
const SAVE = "Save and close";
const DISCARD = "Discard and close";
const TELEGRAM = "Telegram";
const COMMAND = "Custom command (advanced)";
const EDIT = "Edit";
const REMOVE = "Remove";
const OPTIONS = { onPrompt: "Notify when Pi needs an answer", nerdFont: "Nerd Font bell icon" };
const VALUE_COLUMN = 33;
const HINT = "↑↓ move   enter choose   esc cancel";

interface Dialogs {
  menu(options: SetupMenuOptions): Promise<RowId | undefined>;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(options: TextInputOptions): Promise<string | undefined>;
  warn(message: string): void;
  signal: AbortSignal;
}

function dialogs(ui: ExtensionUIContext, signal: AbortSignal): Dialogs {
  return {
    menu: async options => signal.aborted ? undefined : ui.custom<RowId | undefined>((tui, theme, keys, done) => new SetupMenu({ ...options, signal, rows: () => tui.terminal.rows }, theme, keys, done)),
    select: async (title, options) => signal.aborted ? undefined : ui.select(title, options, { signal }),
    confirm: async (title, message) => !signal.aborted && ui.confirm(title, message, { signal }),
    input: async options => signal.aborted ? undefined : ui.custom<string | undefined>((_tui, theme, _keys, done) => new TextInput({ ...options, signal }, theme, done)),
    warn: message => { if (!signal.aborted) ui.notify(message, "warning"); },
    signal,
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ") : "(invalid)";
}

function shownChatId(value: unknown): string | undefined {
  return typeof value === "string" && validChatIdEntry(value) ? value : undefined;
}

function connectorValid(connector: unknown): boolean {
  try { parseConfig({ connectors: [connector] }); return true; }
  catch { return false; }
}

function fields(connector: unknown): Record<string, unknown> {
  return (connector ?? {}) as Record<string, unknown>;
}

function multiLineRun({ type, run }: Record<string, unknown>): boolean {
  return type === "command" && typeof run === "string" && text(run) !== run;
}

function editable(stored: Record<string, unknown>): boolean {
  return (stored.type === "telegram" || stored.type === "command") && !multiLineRun(stored);
}

function connectorRow(connector: unknown, id: number): MenuRow {
  const stored = fields(connector);
  const { type, chatId, run } = stored;
  const known = type === "telegram" ? `Telegram, chat ${shownChatId(chatId) ?? "(invalid)"}` : type === "command" ? `Command, ${text(run)}` : undefined;
  const label = known ?? (typeof connector === "object" && connector !== null && !Array.isArray(connector) ? "Unknown destination" : "Unknown entry");
  return { id, label, note: `${connectorValid(connector) ? "" : " (needs fixing)"}${editable(stored) ? "" : " (remove only)"}` };
}

function optionRow(draft: Draft, key: keyof typeof OPTIONS): MenuRow {
  const value = () => draft[key] === true ? " on " : " off";
  return { id: key, label: OPTIONS[key].padEnd(VALUE_COLUMN), note: value(), toggle: () => { draft[key] = draft[key] !== true; return value(); } };
}

function menuSections(draft: Draft): MenuSection[] {
  const keys = Object.keys(OPTIONS) as (keyof typeof OPTIONS)[];
  return [
    { header: "Send notifications to", rows: [...draft.connectors.map(connectorRow), { id: ADD, label: ADD }] },
    { header: "Options", rows: keys.map(key => optionRow(draft, key)) },
    { rows: [{ id: SAVE, label: SAVE }, { id: DISCARD, label: DISCARD }] },
  ];
}

async function ask(ui: Dialogs, options: TextInputOptions, problem: (value: string) => string | undefined): Promise<string | undefined> {
  let initial = options.initial ?? "";
  for (;;) {
    const value = await ui.input({ ...options, initial });
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    const message = problem(trimmed);
    if (!message) return trimmed;
    ui.warn(message);
    if (!options.mask) initial = value;
  }
}

async function askTelegram(ui: Dialogs, stored: Record<string, unknown> = {}): Promise<object | undefined> {
  const kept = typeof stored.botToken === "string" && stored.botToken.trim() ? stored.botToken : undefined;
  let token: string;
  let bot: string | undefined;
  for (;;) {
    const botToken = await ask(ui, {
      title: "Telegram bot token",
      hint: `In Telegram, message @BotFather and send /newbot to make a bot. Paste the token it gives you, like 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11. It stays hidden.${kept ? " Leave empty to keep the saved token." : ""} Advanced: $NAME reads an environment variable.`,
      mask: true,
      initial: kept && variableEntry(kept) ? kept : undefined,
    }, value => (kept && !value) || validBotTokenEntry(value) ? undefined : "That does not look like a bot token. Copy the whole token from BotFather.");
    if (botToken === undefined) return undefined;
    token = botToken || kept!;
    const checked = await checkBot(ui, token);
    if (checked !== false) { bot = checked; break; }
  }
  for (;;) {
    const chatId = await ask(ui, {
      title: "Your Telegram chat",
      hint: `Open ${bot ? `@${text(bot)}` : "your bot"} in Telegram, press Start and send it any message. Then press Enter here with this field empty. Advanced: type a chat ID, @channel or $NAME instead.`,
      initial: shownChatId(stored.chatId),
    }, value => !value || validChatIdEntry(value) ? undefined : "That does not look like a chat ID. Leave the field empty and press Enter to find your chat.");
    if (chatId === undefined) return undefined;
    const found = chatId || await detectChat(ui, token);
    if (found) return { ...stored, type: "telegram", botToken: token, chatId: found };
  }
}

function resolveToken(token: string): string | undefined {
  const resolved = variableEntry(token) ? process.env[token.slice(1)]?.trim() : token;
  return resolved && validBotTokenEntry(resolved) ? resolved : undefined;
}

async function checkBot(ui: Dialogs, token: string): Promise<string | undefined | false> {
  const resolved = resolveToken(token);
  if (!resolved && variableEntry(token)) return undefined;
  if (!resolved) {
    ui.warn("The saved bot token does not look right. Paste the token again.");
    return false;
  }
  try { return await telegramBot(resolved, ui.signal); }
  catch (error) {
    ui.warn((error as Error).message);
    return error instanceof TelegramTokenRejected ? false : undefined;
  }
}

async function detectChat(ui: Dialogs, token: string): Promise<string | undefined> {
  const resolved = resolveToken(token);
  if (!resolved) {
    ui.warn(`Set ${token} before starting Pi, or type the chat ID.`);
    return undefined;
  }
  let chats, partial;
  try { ({ chats, partial } = await telegramChats(resolved, ui.signal)); }
  catch (error) {
    ui.warn((error as Error).message);
    return undefined;
  }
  if (chats.length === 0) {
    ui.warn("No messages found. Send your bot a message in Telegram, then press Enter again.");
    return undefined;
  }
  if (partial) ui.warn("This bot has many old messages, so your chat may be missing. If it is not in the list, press Esc and type the chat ID.");
  const labels = chats.map(chat => `${text(chat.name)} · ${chat.id}`);
  const choice = await ui.select("Which chat should get notifications?", labels);
  return chats[labels.indexOf(choice!)]?.id;
}

async function askCommand(ui: Dialogs, stored: Record<string, unknown> = {}): Promise<object | undefined> {
  const initial = typeof stored.run === "string" ? stored.run : undefined;
  const run = await ask(ui, {
    title: "Custom command",
    hint: "Advanced. Pi runs this shell command for each notification, with the message in $PI_NOTIFY_TEXT. Only use commands you trust.",
    initial,
  }, value => value ? undefined : "Enter a command.");
  return run === undefined ? undefined : { ...stored, type: "command", run: run === initial?.trim() ? initial : run };
}

async function addConnector(ui: Dialogs): Promise<object | undefined> {
  const type = await ui.select("Send notifications to", [TELEGRAM, COMMAND]);
  if (type === TELEGRAM) return askTelegram(ui);
  if (type === COMMAND) return askCommand(ui);
  return undefined;
}

async function changeConnector(ui: Dialogs, draft: Draft, index: number): Promise<void> {
  const stored = fields(draft.connectors[index]);
  const { label, note } = connectorRow(draft.connectors[index], index);
  const action = await ui.select(`${label}${note}${multiLineRun(stored) ? " (multi-line: edit it in pi-notify/config.json)" : ""}`, editable(stored) ? [EDIT, REMOVE] : [REMOVE]);
  if (action === REMOVE) draft.connectors.splice(index, 1);
  if (action !== EDIT) return;
  const edited = await (stored.type === "telegram" ? askTelegram : askCommand)(ui, stored);
  if (edited) draft.connectors[index] = edited;
}

async function save(ui: Dialogs, path: string, draft: Draft, opened: string | undefined, signal: AbortSignal): Promise<SetupResult | undefined> {
  if (draft.connectors.length === 0) {
    ui.warn("Add a destination before saving.");
    return undefined;
  }
  let valid = true;
  try { parseConfig(draft); }
  catch (error) {
    valid = false;
    const message = `${(error as Error).message} Notifications stay off until this is fixed.`;
    if (!await ui.confirm("Save with problems?", message)) return undefined;
  }
  if (await readRaw(path) !== opened && !await ui.confirm("Replace changes made outside setup?", "The settings file changed while setup was open. Saving replaces those changes.")) return undefined;
  if (signal.aborted) return undefined;
  try { await saveDraft(path, draft); }
  catch {
    ui.warn("Could not save the settings file (pi-notify/config.json).");
    return undefined;
  }
  return { draft, valid };
}

export async function runSetup(piUi: ExtensionUIContext, path: string, signal: AbortSignal): Promise<SetupResult | undefined> {
  const ui = dialogs(piUi, signal);
  const opened = await readRaw(path);
  let draft: Draft;
  try { draft = await loadDraft(path); }
  catch (error) {
    ui.warn((error as Error).message);
    return undefined;
  }
  let last: RowId = 0;
  for (;;) {
    const { length } = draft.connectors;
    const initial = typeof last !== "number" ? last : length ? Math.min(last, length - 1) : ADD;
    const choice = await ui.menu({ title: "Notify setup", hint: HINT, sections: menuSections(draft), initial });
    if (choice === undefined || choice === DISCARD) return undefined;
    last = choice;
    if (typeof choice === "number") {
      await changeConnector(ui, draft, choice);
    } else if (choice === ADD) {
      const connector = await addConnector(ui);
      if (connector) draft.connectors.push(connector);
    } else if (choice === SAVE) {
      const result = await save(ui, path, draft, opened, signal);
      if (result) return result;
    }
  }
}
