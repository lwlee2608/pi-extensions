import type { TelegramConnector } from "./config.ts";

export const SEND_TIMEOUT_MS = 10_000;

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
