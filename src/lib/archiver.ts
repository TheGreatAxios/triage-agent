import type { Env } from "../types/env";
import { getConfig } from "./config";
import { logger } from "./logger";
import { getOverflowingChats, getMessagesForArchival } from "./queries";

/** Maximum number of chats to archive concurrently. */
const ARCHIVE_CONCURRENCY = 3;

/**
 * Archive old messages from D1 to R2 for chats exceeding maxHotMessages.
 * For each overflowing chat, the oldest messages beyond the hot window are
 * written to R2 as JSONL, a pointer is saved in the archives table, and
 * the archived rows are deleted from active_messages.
 *
 * Processes chats with controlled concurrency to balance speed with resource usage.
 */
export async function archiveOldMessages(env: Env): Promise<number> {
  const config = getConfig();
  const { maxHotMessages } = config;

  // Use centralized query to find overflowing chats
  const overflows = await getOverflowingChats(env.DB, maxHotMessages);

  if (overflows.length === 0) return 0;

  logger.info("Starting archival run", {
    chatCount: overflows.length,
    concurrency: ARCHIVE_CONCURRENCY,
  });

  // Process chats with limited concurrency
  let totalArchived = 0;
  const queue = [...overflows];

  while (queue.length > 0) {
    // Take up to ARCHIVE_CONCURRENCY chats from the queue
    const batch = queue.splice(0, ARCHIVE_CONCURRENCY);

    // Process batch concurrently
    const results = await Promise.allSettled(
      batch.map(({ chat_id, msg_count }) =>
        archiveChat(env, chat_id, msg_count, maxHotMessages)
      )
    );

    // Aggregate results and log failures
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const { chat_id } = batch[i];

      if (result.status === "fulfilled") {
        totalArchived += result.value;
      } else {
        logger.error("Failed to archive chat", {
          chatId: chat_id,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  logger.info("Archival run complete", {
    chatsProcessed: overflows.length,
    totalMessagesArchived: totalArchived,
  });

  return totalArchived;
}

async function archiveChat(
  env: Env,
  chatId: number,
  msgCount: number,
  maxHot: number
): Promise<number> {
  const toArchive = msgCount - maxHot;

  // Use centralized query to fetch messages for archival
  const messages = await getMessagesForArchival(env.DB, chatId, toArchive);

  if (messages.length === 0) return 0;

  const windowStart = messages[0].created_at;
  const windowEnd = messages[messages.length - 1].created_at;

  const lines = messages.map((m) =>
    JSON.stringify({
      messageId: m.telegram_message_id,
      senderId: m.sender_id,
      senderName: m.display_name,
      text: m.text,
      eventType: m.event_type,
      isMention: m.is_mention === 1,
      createdAt: m.created_at,
    })
  );

  const r2Key = buildR2Key(chatId, windowStart, windowEnd);

  await env.ARCHIVE.put(r2Key, lines.join("\n"), {
    httpMetadata: { contentType: "application/jsonl" },
    customMetadata: {
      chatId: String(chatId),
      messageCount: String(messages.length),
    },
  });

  await env.DB.prepare(
    `INSERT INTO archives (chat_id, r2_key, window_start, window_end, message_count)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(chatId, r2Key, windowStart, windowEnd, messages.length)
    .run();

  const ids = messages.map((m) => m.id);
  const placeholders = ids.map(() => "?").join(",");
  await env.DB.prepare(
    `DELETE FROM active_messages WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .run();

  logger.info("Chat archived", {
    chatId,
    messageCount: messages.length,
    r2Key,
  });

  return messages.length;
}

function buildR2Key(
  chatId: number,
  windowStart: string,
  windowEnd: string
): string {
  const start = new Date(windowStart);
  const yyyy = start.getUTCFullYear();
  const mm = String(start.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(start.getUTCDate()).padStart(2, "0");

  const startSlug = slugifyTimestamp(windowStart);
  const endSlug = slugifyTimestamp(windowEnd);

  return `telegram/${chatId}/${yyyy}/${mm}/${dd}/${startSlug}_${endSlug}.jsonl`;
}

function slugifyTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
}
