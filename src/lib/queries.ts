/**
 * Centralized D1 query patterns for message retrieval.
 * 
 * This module consolidates common SQL queries to reduce duplication
 * and ensure consistent query patterns across the codebase.
 */

import { logger } from "./logger";

/** Standard message row with sender information. */
export interface MessageWithSender {
  id: number;
  telegram_message_id?: number;
  sender_id?: number;
  text: string | null;
  display_name: string;
  created_at: string;
  event_type?: string;
  is_mention?: number;
}

/** Query options for message retrieval. */
export interface MessageQueryOptions {
  chatId: number;
  limit?: number;
  order?: "asc" | "desc";
}

/**
 * Get recent messages for a chat with sender display names.
 * 
 * This is the primary query for fetching conversation context.
 * Used by: draft generation, escalation context, summary building.
 * 
 * @param db - D1 database instance
 * @param options - Query options (chatId, limit, order)
 * @returns Array of messages with sender information
 */
export async function getRecentMessagesWithSenders(
  db: D1Database,
  options: MessageQueryOptions
): Promise<MessageWithSender[]> {
  const { chatId, limit = 10, order = "desc" } = options;

  // Query: Fetch recent messages with sender display names
  // Uses JOIN to denormalize sender info for performance (avoids N+1 queries)
  const { results } = await db
    .prepare(
      `SELECT
        am.id,              -- Internal message ID (for reference)
        am.text,            -- Message content (may be NULL for media)
        cp.display_name,    -- Participant's display name at time of message
        am.created_at       -- ISO timestamp for chronological ordering
       FROM active_messages am
       JOIN chat_participants cp ON cp.id = am.sender_id
       WHERE am.chat_id = ?
       ORDER BY am.created_at ${order === "asc" ? "ASC" : "DESC"}
       LIMIT ?`
    )
    .bind(chatId, limit)
    .all<MessageWithSender>();

  return results;
}

/**
 * Get recent messages with full details for archival.
 * 
 * Includes additional fields needed for R2 archival (telegram_message_id, sender_id, etc.)
 * 
 * @param db - D1 database instance
 * @param chatId - Internal chat ID
 * @param limit - Maximum messages to fetch
 * @returns Array of messages with full archival details
 */
export async function getMessagesForArchival(
  db: D1Database,
  chatId: number,
  limit: number
): Promise<MessageWithSender[]> {
  // Query: Fetch oldest messages for archival (FIFO - First In, First Out)
  // ASC order preserves "hot" recent messages in D1, archives oldest first
  // JOIN captures point-in-time sender name (may differ from current value)
  const { results } = await db
    .prepare(
      `SELECT
        am.id,
        am.telegram_message_id,
        am.sender_id,
        cp.display_name,
        am.text,
        am.event_type,
        am.is_mention,
        am.created_at
       FROM active_messages am
       JOIN chat_participants cp ON cp.id = am.sender_id
       WHERE am.chat_id = ?
       ORDER BY am.created_at ASC
       LIMIT ?`
    )
    .bind(chatId, limit)
    .all<MessageWithSender>();

  return results;
}

/**
 * Get recent messages formatted for escalation context.
 * 
 * Returns formatted strings like "[Name]: message text" for Slack notifications.
 * 
 * @param db - D1 database instance
 * @param chatId - Internal chat ID
 * @param limit - Maximum messages to include
 * @returns Array of formatted message strings
 */
export async function getFormattedMessagesForEscalation(
  db: D1Database,
  chatId: number,
  limit: number = 5
): Promise<string[]> {
  const messages = await getRecentMessagesWithSenders(db, {
    chatId,
    limit,
    order: "desc",
  });

  // Reverse to get chronological order for display
  return messages.reverse().map((m) => `[${m.display_name}]: ${m.text ?? ""}`);
}

/**
 * Check if a chat has exceeded its message limit.
 * 
 * @param db - D1 database instance
 * @param chatId - Internal chat ID
 * @param maxMessages - Maximum allowed messages
 * @returns Object with overflow status and count
 */
export async function checkChatMessageOverflow(
  db: D1Database,
  chatId: number,
  maxMessages: number
): Promise<{ hasOverflow: boolean; count: number; toArchive: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as cnt
       FROM active_messages
       WHERE chat_id = ?`
    )
    .bind(chatId)
    .first<{ cnt: number }>();

  const count = row?.cnt ?? 0;
  const hasOverflow = count > maxMessages;
  const toArchive = hasOverflow ? count - maxMessages : 0;

  return { hasOverflow, count, toArchive };
}

/**
 * Get all chats that have exceeded their message limit.
 * 
 * @deprecated Use getOverflowingChats from lib/counters.ts instead.
 * This function performs a full table scan and is expensive at scale.
 * The counters-based version reads only rows where needs_archival = 1.
 * 
 * @param db - D1 database instance
 * @param maxMessages - Maximum allowed messages per chat
 * @returns Array of chat IDs with their message counts
 */
export async function getOverflowingChats(
  db: D1Database,
  maxMessages: number
): Promise<Array<{ chat_id: number; msg_count: number }>> {
  // Query: Find all chats exceeding the hot storage limit
  // WARNING: This scans the ENTIRE active_messages table - expensive at scale!
  // HAVING filters post-aggregation (vs WHERE which filters pre-aggregation)
  const { results } = await db
    .prepare(
      `SELECT
        chat_id,
        COUNT(*) as msg_count
       FROM active_messages
       GROUP BY chat_id
       HAVING msg_count > ?`
    )
    .bind(maxMessages)
    .all<{ chat_id: number; msg_count: number }>();

  return results;
}

/**
 * Build a formatted context string from messages for AI prompts.
 * 
 * @param messages - Array of messages with sender info
 * @returns Formatted string for prompt context
 */
export function buildMessageContext(messages: MessageWithSender[]): string {
  return messages.map((m) => `[${m.display_name}]: ${m.text ?? ""}`).join("\n");
}
