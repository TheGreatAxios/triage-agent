import { getConfig } from "./config";
import { logger } from "./logger";
import { getRecentMessagesWithSenders } from "./queries";

export interface ChatSummary {
  id: number;
  chatId: number;
  content: string;
  messageRangeStart: number | null;
  messageRangeEnd: number | null;
  createdAt: string;
}

interface MessageRow {
  id: number;
  text: string | null;
  display_name: string;
  created_at: string;
}

/**
 * Get the latest summary for a chat, refreshing if stale.
 * Returns null if there are no messages to summarize.
 */
export async function getOrRefreshSummary(
  db: D1Database,
  chatId: number
): Promise<ChatSummary | null> {
  const existing = await getLatestSummary(db, chatId);

  if (existing && !isSummaryStale(existing)) {
    return existing;
  }

  const messages = await getRecentMessages(db, chatId);
  if (messages.length === 0) return existing;

  const content = buildSummaryContent(messages);
  const rangeStart = messages[0].id;
  const rangeEnd = messages[messages.length - 1].id;

  await saveSummary(db, chatId, content, rangeStart, rangeEnd);

  logger.info("Summary refreshed", {
    chatId,
    messageCount: messages.length,
    rangeStart,
    rangeEnd,
  });

  return getLatestSummary(db, chatId);
}

/**
 * Get the most recent summary for a chat.
 */
async function getLatestSummary(
  db: D1Database,
  chatId: number
): Promise<ChatSummary | null> {
  // Get the most recent summary for this chat
  const row = await db
    .prepare(
      `SELECT id, chat_id, content, message_range_start, message_range_end, created_at
       FROM summaries
       WHERE chat_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(chatId)
    .first<{
      id: number;
      chat_id: number;
      content: string;
      message_range_start: number | null;
      message_range_end: number | null;
      created_at: string;
    }>();

  if (!row) return null;

  return {
    id: row.id,
    chatId: row.chat_id,
    content: row.content,
    messageRangeStart: row.message_range_start,
    messageRangeEnd: row.message_range_end,
    createdAt: row.created_at,
  };
}

function isSummaryStale(summary: ChatSummary): boolean {
  const config = getConfig();
  const ageMs = Date.now() - new Date(summary.createdAt).getTime();
  const maxAgeMs = config.summaryMaxAgeMinutes * 60 * 1000;
  return ageMs > maxAgeMs;
}

/**
 * Fetch recent messages for a chat to build a summary from.
 * Uses maxHotMessages config to limit the window.
 * Delegates to centralized query module for consistency.
 */
async function getRecentMessages(
  db: D1Database,
  chatId: number
): Promise<MessageRow[]> {
  const config = getConfig();

  const messages = await getRecentMessagesWithSenders(db, {
    chatId,
    limit: config.maxHotMessages,
    order: "desc",
  });

  // Reverse to chronological order for summary building
  return messages.reverse();
}

/**
 * Build a plain-text summary from messages.
 * This is a simple concatenation for now — will be replaced
 * with AI summarization in a later phase.
 */
function buildSummaryContent(messages: MessageRow[]): string {
  const lines = messages.map(
    (m) => `[${m.display_name}]: ${m.text ?? ""}`
  );
  return lines.join("\n");
}

async function saveSummary(
  db: D1Database,
  chatId: number,
  content: string,
  rangeStart: number,
  rangeEnd: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO summaries (chat_id, content, message_range_start, message_range_end)
       VALUES (?, ?, ?, ?)`
    )
    .bind(chatId, content, rangeStart, rangeEnd)
    .run();
}
