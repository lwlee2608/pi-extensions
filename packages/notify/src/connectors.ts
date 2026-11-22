import { spawn } from "node:child_process";
import type { CommandConnector, TelegramConnector } from "./config.ts";

export const SEND_TIMEOUT_MS = 10_000;

export function sendCommand(connector: CommandConnector, text: string, signal?: AbortSignal, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failure = () => new Error("Command send failed (process error or timeout).");
    if (signal?.aborted) { reject(failure()); return; }
    const child = spawn(connector.run, {
      shell: true, cwd, env: { ...process.env, PI_NOTIFY_TEXT: text },
      stdio: "ignore", detached: process.platform !== "win32",
    });
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = () => {
      // Kill the shell's process group too; do not wait indefinitely for an exit event.
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Process may already have exited. */ }
      child.unref();
      finish(failure());
    };
    const timer = setTimeout(cancel, SEND_TIMEOUT_MS);
    signal?.addEventListener("abort", cancel, { once: true });
    child.once("error", () => finish(failure()));
    child.once("exit", code => finish(code === 0 ? undefined : failure()));
  });
}

export async function sendTelegram(connector: TelegramConnector, text: string, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(SEND_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.telegram.org/bot${connector.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: connector.chatId, text }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
    const body: unknown = await response.json();
    if (!response.ok || typeof body !== "object" || body === null || !("ok" in body) || body.ok !== true) {
      throw new Error("Rejected");
    }
  } catch {
    // Fetch errors and Telegram responses can contain the bot token or message.
    throw new Error("Telegram send failed (request rejected, network error, or timeout).");
  }
}

export interface TelegramChat { id: string; name: string }

function chatName(chat: Record<string, unknown>): string {
  const person = [chat.first_name, chat.last_name].filter(part => typeof part === "string").join(" ");
  const name = typeof chat.title === "string" ? chat.title : person || "Chat";
  return typeof chat.username === "string" ? `${name} (@${chat.username})` : name;
}

export async function telegramChats(botToken: string, signal?: AbortSignal): Promise<TelegramChat[]> {
  const timeout = AbortSignal.timeout(SEND_TIMEOUT_MS);
  let status: number;
  let body: unknown;
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
    status = response.status;
    body = await response.json();
  } catch {
    throw new Error("Cannot reach Telegram. Check your internet connection, then press Enter to try again.");
  }
  const updates = (body as { ok?: unknown; result?: unknown } | null)?.ok === true ? (body as { result: unknown }).result : undefined;
  if (!Array.isArray(updates)) {
    if (status === 401 || status === 404) throw new Error("Telegram did not accept the bot token. Press Esc and add Telegram again with the full token from BotFather.");
    if (status === 409) throw new Error("Setup cannot read this bot's messages because another app receives them. Type the chat ID instead.");
    throw new Error("Telegram did not answer. Press Enter to try again.");
  }
  const chats = new Map<string, string>();
  for (const update of updates.reverse()) {
    for (const value of Object.values(update ?? {})) {
      const chat = (value as { chat?: Record<string, unknown> } | null)?.chat;
      if (typeof chat?.id === "number" && !chats.has(String(chat.id))) chats.set(String(chat.id), chatName(chat));
    }
  }
  return [...chats].map(([id, name]) => ({ id, name }));
}
