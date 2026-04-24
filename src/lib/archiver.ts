import type { Env } from "../types/env";
import { getConfig } from "./config";
import { logger } from "./logger";

interface ArchivableMessage {
  id: number;
  telegram_message_id: number;
  sender_id: number;
  display_name: string;
  text: string | null;
  event_type: string;
  is_mention: number;
  created_at: string;
}

interface ChatOverflow {
  chat_id: number;
  msg_count: number;
}

/**
 * Archive old messages from D1 to R2 for chats exceeding maxHotMessages.
 * For each overflowing chat, the oldest messages beyond the hot window are
 * written to R2 as JSONL, a pointer is saved in the archives table, and
 * the archived rows are deleted from active_messages.
 */
export async function archiveOldMessages(env: Env): Promise<number> {
  const config = getConfig();
  const { maxHotMessages } = config;

  const { results: overflows } = await env.DB.prepare(
    `SELECT chat_id, COUNT(*) as msg_count
     FROM active_messages
     GROUP BY chat_id
     HAVING msg_count > ?`
  )
    .bind(maxHotMessages)
    .all<ChatOverflow>();

  if (overflows.length === 0) return 0;

  let totalArchived = 0;

  for (const { chat_id, msg_count } of overflows) {
    try {
      const archived = await archiveChat(env, chat_id, msg_count, maxHotMessages);
      totalArchived += archived;
    } catch (err) {
      logger.error("Failed to archive chat", {
        chatId: chat_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return totalArchived;
}

async function archiveChat(
  env: Env,
  chatId: number,
  msgCount: number,
  maxHot: number
): Promise<number> {
  const toArchive = msgCount - maxHot;

  const { results } = await env.DB.prepare(
    `SELECT am.id, am.telegram_message_id, am.sender_id,
            cp.display_name, am.text, am.event_type, am.is_mention, am.created_at
     FROM active_messages am
     JOIN chat_participants cp ON cp.id = am.sender_id
     WHERE am.chat_id = ?
     ORDER BY am.created_at ASC
     LIMIT ?`
  )
    .bind(chatId, toArchive)
    .all<ArchivableMessage>();

  if (results.length === 0) return 0;

  const windowStart = results[0].created_at;
  const windowEnd = results[results.length - 1].created_at;

  const lines = results.map((m) =>
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
      messageCount: String(results.length),
    },
  });

  await env.DB.prepare(
    `INSERT INTO archives (chat_id, r2_key, window_start, window_end, message_count)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(chatId, r2Key, windowStart, windowEnd, results.length)
    .run();

  const ids = results.map((m) => m.id);
  const placeholders = ids.map(() => "?").join(",");
  await env.DB.prepare(
    `DELETE FROM active_messages WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .run();

  logger.info("Chat archived", {
    chatId,
    messageCount: results.length,
    r2Key,
  });

  return results.length;
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
