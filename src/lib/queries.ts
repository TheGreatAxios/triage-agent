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
 * Format a relative time string (e.g. "2m ago", "1h ago") from an ISO timestamp.
 */
function formatRelativeTime(isoTimestamp: string, now: Date): string {
  const then = new Date(isoTimestamp + "Z");
  const diffMs = now.getTime() - then.getTime();

  if (isNaN(diffMs) || diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Get formatted messages for Slack escalation blocks.
 * Returns messages in chronological order with sender names.
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
 * Build a formatted context string from messages for AI prompts.
 * 
 * Each message includes a relative timestamp so the LLM can distinguish
 * separate conversation threads based on time gaps and topic shifts.
 *
 * @param messages - Array of messages with sender info (chronological order)
 * @returns Formatted string for prompt context
 */
export function buildMessageContext(messages: MessageWithSender[]): string {
  if (messages.length === 0) return "(no recent messages)";

  const now = new Date();

  return messages
    .map((m) => {
      const timeAgo = formatRelativeTime(m.created_at, now);
      const text = m.text ?? "";
      return `[${m.display_name} (${timeAgo})]: ${text}`;
    })
    .join("\n");
}
