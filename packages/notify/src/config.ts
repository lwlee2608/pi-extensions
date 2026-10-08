import { readFile } from "node:fs/promises";

export interface TelegramConnector { type: "telegram"; botToken: string; chatId: string }
export interface CommandConnector { type: "command"; run: string }
export interface Config { onPrompt: boolean; nerdFont: boolean; connectors: (TelegramConnector | CommandConnector)[] }

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
    const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
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
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error("Notify config has an invalid botToken.");
      if (!/^(?:-?\d+|@[A-Za-z0-9_]+)$/.test(chatId)) throw new Error("Notify config has an invalid chatId.");
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
