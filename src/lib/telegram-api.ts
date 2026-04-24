/** Telegram Bot API helpers for approval flow operations. */

import type { BotMetadata } from "../types/approval";
import type { TelegramUser, TelegramChat } from "../types/telegram";
import { logger } from "./logger";

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

/**
 * Get bot information from Telegram API.
 * Cached in D1 app_config table to avoid repeated calls.
 */
export async function getBotMetadata(botToken: string): Promise<BotMetadata | null> {
  try {
    const resp = await fetch(`${TELEGRAM_API_BASE}${botToken}/getMe`);
    const data = await resp.json() as TelegramApiResponse<TelegramUser>;

    if (!data.ok || !data.result) {
      logger.error("Failed to fetch bot metadata", {
        error: data.description,
        code: data.error_code,
      });
      return null;
    }

    const user = data.result;
    return {
      id: user.id,
      username: user.username || "UnknownBot",
      firstName: user.first_name,
      canJoinGroups: true, // Default assumptions
      canReadAllGroupMessages: false,
      supportsInlineQueries: false,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.error("Error fetching bot metadata", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Leave a chat (group/channel) via Telegram API.
 */
export async function leaveChat(
  telegramChatId: number,
  botToken: string
): Promise<boolean> {
  try {
    const resp = await fetch(`${TELEGRAM_API_BASE}${botToken}/leaveChat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: telegramChatId }),
    });

    const data = await resp.json() as TelegramApiResponse<boolean>;

    if (!data.ok) {
      logger.error("Failed to leave chat", {
        telegram_chat_id: telegramChatId,
        error: data.description,
        code: data.error_code,
      });
      return false;
    }

    logger.info("Successfully left chat", { telegram_chat_id: telegramChatId });
    return true;
  } catch (err) {
    logger.error("Error leaving chat", {
      telegram_chat_id: telegramChatId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Send a message to a chat via Telegram API.
 */
export async function sendMessage(
  telegramChatId: number,
  text: string,
  botToken: string,
  options?: {
    parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
    disable_notification?: boolean;
  }
): Promise<boolean> {
  try {
    const payload: Record<string, unknown> = {
      chat_id: telegramChatId,
      text,
      ...options,
    };

    const resp = await fetch(`${TELEGRAM_API_BASE}${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await resp.json() as TelegramApiResponse<TelegramMessage>;

    if (!data.ok) {
      logger.error("Failed to send message", {
        telegram_chat_id: telegramChatId,
        error: data.description,
        code: data.error_code,
      });
      return false;
    }

    logger.info("Message sent successfully", { telegram_chat_id: telegramChatId });
    return true;
  } catch (err) {
    logger.error("Error sending message", {
      telegram_chat_id: telegramChatId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Get chat information including member count.
 */
export async function getChat(
  telegramChatId: number,
  botToken: string
): Promise<TelegramChat | null> {
  try {
    const resp = await fetch(`${TELEGRAM_API_BASE}${botToken}/getChat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: telegramChatId }),
    });

    const data = await resp.json() as TelegramApiResponse<TelegramChat>;

    if (!data.ok) {
      logger.warn("Failed to get chat info", {
        telegram_chat_id: telegramChatId,
        error: data.description,
      });
      return null;
    }

    return data.result || null;
  } catch (err) {
    logger.error("Error getting chat info", {
      telegram_chat_id: telegramChatId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Get member count for a chat.
 */
export async function getChatMemberCount(
  telegramChatId: number,
  botToken: string
): Promise<number | null> {
  try {
    const resp = await fetch(`${TELEGRAM_API_BASE}${botToken}/getChatMemberCount`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: telegramChatId }),
    });

    const data = await resp.json() as TelegramApiResponse<number>;

    if (!data.ok) {
      logger.warn("Failed to get member count", {
        telegram_chat_id: telegramChatId,
        error: data.description,
      });
      return null;
    }

    return data.result ?? null;
  } catch (err) {
    logger.error("Error getting member count", {
      telegram_chat_id: telegramChatId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

/**
 * Build rejection message text.
 */
export function buildRejectionMessage(
  chatTitle: string | null,
  botUsername: string,
  decidedBy: string
): string {
  const target = chatTitle ? `"${chatTitle}"` : "This chat";
  return `${target} was denied access from ${botUsername}. Decided by ${decidedBy}.`;
}

/**
 * Build expiration message text.
 */
export function buildExpirationMessage(botUsername: string): string {
  return `Access request for ${botUsername} expired. Leaving chat.`;
}

/**
 * Build activation message text (if NOTIFY_ON_APPROVAL is true).
 */
export function buildActivationMessage(botUsername: string): string {
  return `${botUsername} is now active in this chat. Messages will be monitored and classified.`;
}
