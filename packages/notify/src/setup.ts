import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { loadDraft, parseConfig, saveDraft, validBotTokenEntry, validChatIdEntry, variableEntry, type Draft } from "./config.ts";
import { TextInput, type TextInputOptions } from "./text-input.ts";

export interface SetupResult { draft: Draft; valid: boolean }

const ADD = "Add connector";
const SAVE = "Save";
const CANCEL = "Cancel";
const TELEGRAM = "Telegram";
const COMMAND = "Shell command";
const EDIT = "Edit";
const REMOVE = "Remove";
const OPTIONS = { onPrompt: "Notify when waiting for input", nerdFont: "Nerd Font status icon" };

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ") : "(invalid)";
}

function shownChatId(value: unknown): string | undefined {
  return typeof value === "string" && validChatIdEntry(value) ? value : undefined;
}

function connectorLabel(connector: unknown, index: number): string {
  const { type, chatId, run } = (connector ?? {}) as Record<string, unknown>;
  const body = type === "telegram" ? `Telegram ${shownChatId(chatId) ?? "(invalid)"}` : type === "command" ? `Command ${text(run)}` : "Unsupported connector";
  return `${index + 1}. ${body}`;
}

function optionLabel(draft: Draft, key: keyof typeof OPTIONS): string {
  return `${OPTIONS[key]}: ${draft[key] === true ? "on" : "off"}`;
}

async function ask(ui: ExtensionUIContext, options: TextInputOptions, problem: (value: string) => string | undefined): Promise<string | undefined> {
  let initial = options.initial ?? "";
  for (;;) {
    const value = await ui.custom<string | undefined>((_tui, theme, _keys, done) => new TextInput({ ...options, initial }, theme, done));
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    const message = problem(trimmed);
    if (!message) return trimmed;
    ui.notify(message, "warning");
    if (!options.mask) initial = value;
  }
}

async function askTelegram(ui: ExtensionUIContext, stored: Record<string, unknown> = {}): Promise<object | undefined> {
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

async function askCommand(ui: ExtensionUIContext, stored: Record<string, unknown> = {}): Promise<object | undefined> {
  const initial = typeof stored.run === "string" ? stored.run : undefined;
  const run = await ask(ui, {
    title: "Shell command",
    hint: "Runs in the session directory with the message in $PI_NOTIFY_TEXT. Only use commands you trust.",
    initial,
  }, value => value ? undefined : "The command cannot be empty.");
  return run === undefined ? undefined : { ...stored, type: "command", run: run === initial?.trim() ? initial : run };
}

async function addConnector(ui: ExtensionUIContext): Promise<object | undefined> {
  const type = await ui.select("Connector type", [TELEGRAM, COMMAND]);
  if (type === TELEGRAM) return askTelegram(ui);
  if (type === COMMAND) return askCommand(ui);
  return undefined;
}

async function changeConnector(ui: ExtensionUIContext, draft: Draft, index: number, label: string): Promise<void> {
  const stored = (draft.connectors[index] ?? {}) as Record<string, unknown>;
  const multiLine = stored.type === "command" && typeof stored.run === "string" && text(stored.run) !== stored.run;
  const editable = (stored.type === "telegram" || stored.type === "command") && !multiLine;
  const action = await ui.select(multiLine ? `${label} (multi-line: edit it in pi-notify/config.json)` : label, editable ? [EDIT, REMOVE] : [REMOVE]);
  if (action === REMOVE) draft.connectors.splice(index, 1);
  if (action !== EDIT) return;
  const edited = await (stored.type === "telegram" ? askTelegram : askCommand)(ui, stored);
  if (edited) draft.connectors[index] = edited;
}

async function save(ui: ExtensionUIContext, path: string, draft: Draft): Promise<SetupResult | undefined> {
  if (draft.connectors.length === 0) {
    ui.notify("Add a connector before saving.", "warning");
    return undefined;
  }
  let valid = true;
  try { parseConfig(draft); }
  catch (error) {
    valid = false;
    const message = `${(error as Error).message} All notifications stay refused until it is fixed.`;
    if (!await ui.confirm("Save this invalid config?", message)) return undefined;
  }
  try { await saveDraft(path, draft); }
  catch {
    ui.notify("Cannot save pi-notify/config.json.", "warning");
    return undefined;
  }
  return { draft, valid };
}

export async function runSetup(ui: ExtensionUIContext, path: string): Promise<SetupResult | undefined> {
  let draft: Draft;
  try { draft = await loadDraft(path); }
  catch (error) {
    ui.notify((error as Error).message, "warning");
    return undefined;
  }
  const keys = Object.keys(OPTIONS) as (keyof typeof OPTIONS)[];
  for (;;) {
    const labels = draft.connectors.map(connectorLabel);
    const choice = await ui.select("Notify setup", [
      ...labels, ADD, ...keys.map(key => optionLabel(draft, key)), SAVE, CANCEL,
    ]);
    const option = keys.find(key => optionLabel(draft, key) === choice);
    if (choice === undefined || choice === CANCEL) return undefined;
    if (choice === ADD) {
      const connector = await addConnector(ui);
      if (connector) draft.connectors.push(connector);
    } else if (choice === SAVE) {
      const result = await save(ui, path, draft);
      if (result) return result;
    } else if (option) {
      draft[option] = draft[option] !== true;
    } else {
      await changeConnector(ui, draft, labels.indexOf(choice), choice);
    }
  }
}
