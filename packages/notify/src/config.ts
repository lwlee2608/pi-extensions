import { randomUUID } from "node:crypto";
import { mkdir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

export interface TelegramConnector { type: "telegram"; botToken: string; chatId: string }
export interface CommandConnector { type: "command"; run: string }
export interface Config { onPrompt: boolean; nerdFont: boolean; connectors: (TelegramConnector | CommandConnector)[] }
export type Draft = Record<string, unknown> & { connectors: unknown[] };

const VARIABLE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const BOT_TOKEN = /^\d+:[A-Za-z0-9_-]+$/;
const CHAT_ID = /^(?:-?\d+|@[A-Za-z0-9_]+)$/;

export const validBotTokenEntry = (value: string) => VARIABLE.test(value) || BOT_TOKEN.test(value);
export const validChatIdEntry = (value: string) => VARIABLE.test(value) || CHAT_ID.test(value);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConfig(value: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  if (!object(value) || (value.onPrompt !== undefined && typeof value.onPrompt !== "boolean") ||
      (value.nerdFont !== undefined && typeof value.nerdFont !== "boolean") ||
      !Array.isArray(value.connectors) || value.connectors.length === 0) {
    throw new Error("Notify config needs a non-empty connectors array and optional boolean onPrompt and nerdFont.");
  }
  function resolve(value: unknown, field: string): string {
    if (typeof value !== "string") throw new Error(`Notify config needs a string ${field}.`);
    const match = VARIABLE.exec(value);
    const resolved = match ? env[match[1]] : value;
    if (!resolved?.trim()) throw new Error(`Notify config has an empty or unresolved ${field}.`);
    return resolved;
  }
  return {
    onPrompt: value.onPrompt ?? false,
    nerdFont: value.nerdFont ?? false,
    connectors: value.connectors.map(connector => {
      if (!object(connector)) throw new Error("Notify config needs connector objects.");
      if (connector.type === "command") return { type: "command", run: resolve(connector.run, "run") };
      if (connector.type !== "telegram") throw new Error("Notify supports telegram and command connectors only.");
      const botToken = resolve(connector.botToken, "botToken");
      const chatId = resolve(connector.chatId, "chatId");
      if (!BOT_TOKEN.test(botToken)) throw new Error("Notify config has an invalid botToken.");
      if (!CHAT_ID.test(chatId)) throw new Error("Notify config has an invalid chatId.");
      return { type: "telegram", botToken, chatId };
    }),
  };
}

export async function loadConfig(path: string): Promise<Config> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch { throw new Error("Cannot read pi-notify/config.json; configure a telegram or command connector first."); }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Notify config is not valid JSON."); }
  return parseConfig(value);
}

export async function loadDraft(path: string): Promise<Draft> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { connectors: [] };
    throw new Error("Cannot read pi-notify/config.json; fix it by hand before running setup.");
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Notify config is not valid JSON; fix it by hand before running setup."); }
  if (!object(value) || (value.connectors !== undefined && !Array.isArray(value.connectors))) {
    throw new Error("Notify config needs an object with a connectors array; fix it by hand before running setup.");
  }
  return { ...value, connectors: (value.connectors ?? []) as unknown[] };
}

async function followSymlinks(path: string): Promise<string> {
  for (let hops = 0; hops < 40; hops++) {
    let link: string;
    try { link = await readlink(path); }
    catch { return path; }
    path = resolvePath(await realpath(dirname(path)), link);
  }
  throw new Error("Too many symlinks.");
}

export async function saveDraft(path: string, draft: Draft): Promise<void> {
  const target = await followSymlinks(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
