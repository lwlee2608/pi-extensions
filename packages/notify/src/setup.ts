import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { loadDraft, parseConfig, readRaw, saveDraft, validBotTokenEntry, validChatIdEntry, variableEntry, type Draft } from "./config.ts";
import { SetupMenu, type MenuRow, type MenuSection, type RowId, type SetupMenuOptions } from "./setup-menu.ts";
import { TextInput, type TextInputOptions } from "./text-input.ts";

export interface SetupResult { draft: Draft; valid: boolean }

const ADD = "+ Add connector";
const SAVE = "Save and close";
const DISCARD = "Discard and close";
const TELEGRAM = "Telegram";
const COMMAND = "Shell command";
const EDIT = "Edit";
const REMOVE = "Remove";
const OPTIONS = { onPrompt: "Notify when waiting for input", nerdFont: "Nerd Font status icon" };
const VALUE_COLUMN = 33;
const HINT = "↑↓ navigate   enter select   esc discard";

interface Dialogs {
  menu(options: SetupMenuOptions): Promise<RowId | undefined>;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(options: TextInputOptions): Promise<string | undefined>;
  warn(message: string): void;
}

function dialogs(ui: ExtensionUIContext, signal: AbortSignal): Dialogs {
  return {
    menu: async options => signal.aborted ? undefined : ui.custom<RowId | undefined>((_tui, theme, keys, done) => new SetupMenu({ ...options, signal }, theme, keys, done)),
    select: async (title, options) => signal.aborted ? undefined : ui.select(title, options, { signal }),
    confirm: async (title, message) => !signal.aborted && ui.confirm(title, message, { signal }),
    input: async options => signal.aborted ? undefined : ui.custom<string | undefined>((_tui, theme, _keys, done) => new TextInput({ ...options, signal }, theme, done)),
    warn: message => { if (!signal.aborted) ui.notify(message, "warning"); },
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
  const label = known ?? (typeof connector === "object" && connector !== null && !Array.isArray(connector) ? "Unsupported connector" : "Not a connector");
  return { id, label, note: `${connectorValid(connector) ? "" : " (needs fixing)"}${editable(stored) ? "" : " (remove only)"}` };
}

function menuSections(draft: Draft): MenuSection[] {
  const keys = Object.keys(OPTIONS) as (keyof typeof OPTIONS)[];
  return [
    { header: "Connectors", rows: [...draft.connectors.map(connectorRow), { id: ADD, label: ADD }] },
    { header: "Options", rows: keys.map(key => ({ id: key, label: OPTIONS[key].padEnd(VALUE_COLUMN), note: draft[key] === true ? " on " : " off" })) },
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
  const botToken = await ask(ui, {
    title: "Telegram bot token",
    hint: `Get one from Telegram's BotFather, or enter a $VARIABLE from Pi's environment. A literal token stays hidden.${kept ? " Leave empty to keep the stored token." : ""}`,
    mask: true,
    initial: kept && variableEntry(kept) ? kept : undefined,
  }, value => (kept && !value) || validBotTokenEntry(value) ? undefined : "That is not a bot token or $VARIABLE.");
  if (botToken === undefined) return undefined;
  const chatId = await ask(ui, {
    title: "Telegram chat ID",
    hint: "Message your bot, then open https://api.telegram.org/bot<token>/getUpdates and copy chat.id. A @channel name or $VARIABLE also works.",
    initial: shownChatId(stored.chatId),
  }, value => validChatIdEntry(value) ? undefined : "That is not a chat ID, @channel, or $VARIABLE.");
  return chatId === undefined ? undefined : { ...stored, type: "telegram", botToken: botToken || kept, chatId };
}

async function askCommand(ui: Dialogs, stored: Record<string, unknown> = {}): Promise<object | undefined> {
  const initial = typeof stored.run === "string" ? stored.run : undefined;
  const run = await ask(ui, {
    title: "Shell command",
    hint: "Runs in the session directory with the message in $PI_NOTIFY_TEXT. Only use commands you trust.",
    initial,
  }, value => value ? undefined : "The command cannot be empty.");
  return run === undefined ? undefined : { ...stored, type: "command", run: run === initial?.trim() ? initial : run };
}

async function addConnector(ui: Dialogs): Promise<object | undefined> {
  const type = await ui.select("Connector type", [TELEGRAM, COMMAND]);
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
    ui.warn("Add a connector before saving.");
    return undefined;
  }
  let valid = true;
  try { parseConfig(draft); }
  catch (error) {
    valid = false;
    const message = `${(error as Error).message} All notifications stay refused until it is fixed.`;
    if (!await ui.confirm("Save this invalid config?", message)) return undefined;
  }
  if (await readRaw(path) !== opened && !await ui.confirm("Overwrite outside changes?", "pi-notify/config.json changed since setup opened. Saving replaces those changes.")) return undefined;
  if (signal.aborted) return undefined;
  try { await saveDraft(path, draft); }
  catch {
    ui.warn("Cannot save pi-notify/config.json.");
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
    } else {
      draft[choice] = draft[choice] !== true;
    }
  }
}
