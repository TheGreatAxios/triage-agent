import { logger } from "./logger";

/**
 * Check if a chat is within its rate limit by counting recent messages.
 * Returns true if the chat may proceed, false if rate-limited.
 */
export async function checkRateLimit(
  db: D1Database,
  chatId: number,
  limit = 30,
  windowSeconds = 60
): Promise<boolean> {
  const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();

  // Subquery: map Telegram chat ID to internal chat ID
  // Only count messages within the rate limit window
  const row = await db
    .prepare(
      `SELECT COUNT(*) as cnt
       FROM active_messages
       WHERE chat_id = (SELECT id FROM chats WHERE telegram_chat_id = ?)
         AND created_at >= ?`
    )
    .bind(chatId, cutoff)
    .first<{ cnt: number }>();

  const count = row?.cnt ?? 0;

  if (count >= limit) {
    logger.warn("Rate limit exceeded", { chatId, count, limit, windowSeconds });
    return false;
  }

  return true;
}
