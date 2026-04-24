import type { InternalEvent } from "../types/events";
import type { TelegramChat } from "../types/telegram";
import type { ClassificationResult } from "../types/classification";
import { logger } from "./logger";

export interface PersistResult {
  chatId: number;
  messageId: number;
}

/**
 * Persist an InternalEvent to D1: upsert chat, upsert participant, insert message.
 * Uses INSERT OR IGNORE / ON CONFLICT for idempotency on duplicate delivery.
 * Returns internal DB IDs for downstream use (e.g., classification persistence).
 */
export async function persistEvent(
  db: D1Database,
  event: InternalEvent,
  chatMeta: TelegramChat
): Promise<PersistResult> {
  const chatId = await upsertChat(db, chatMeta);
  const participantId = await upsertParticipant(db, chatId, event);
  const messageId = await insertMessage(db, chatId, participantId, event);
  return { chatId, messageId };
}

async function upsertChat(db: D1Database, chat: TelegramChat): Promise<number> {
  await db
    .prepare(
      `INSERT INTO chats (telegram_chat_id, type, title)
       VALUES (?, ?, ?)
       ON CONFLICT (telegram_chat_id) DO UPDATE SET
         title = excluded.title,
         updated_at = datetime('now')`
    )
    .bind(chat.id, chat.type, chat.title ?? null)
    .run();

  const row = await db
    .prepare(`SELECT id FROM chats WHERE telegram_chat_id = ?`)
    .bind(chat.id)
    .first<{ id: number }>();

  if (!row) throw new Error(`Failed to upsert chat ${chat.id}`);
  return row.id;
}

async function upsertParticipant(
  db: D1Database,
  chatId: number,
  event: InternalEvent
): Promise<number> {
  await db
    .prepare(
      `INSERT INTO chat_participants (chat_id, telegram_user_id, is_bot, display_name, username)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, telegram_user_id) DO UPDATE SET
         display_name = excluded.display_name,
         username = excluded.username,
         last_seen_at = datetime('now')`
    )
    .bind(chatId, event.sender.id, event.sender.isBot ? 1 : 0, event.sender.name, event.sender.username ?? null)
    .run();

  const row = await db
    .prepare(`SELECT id FROM chat_participants WHERE chat_id = ? AND telegram_user_id = ?`)
    .bind(chatId, event.sender.id)
    .first<{ id: number }>();

  if (!row) throw new Error(`Failed to upsert participant ${event.sender.id}`);
  return row.id;
}

async function insertMessage(
  db: D1Database,
  chatId: number,
  senderId: number,
  event: InternalEvent
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO active_messages (chat_id, telegram_message_id, sender_id, text, event_type, is_mention, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, telegram_message_id) DO NOTHING`
    )
    .bind(
      chatId,
      event.messageId,
      senderId,
      event.text,
      event.type,
      event.isMention ? 1 : 0,
      event.timestamp
    )
    .run();

  if (result.meta.changes === 0) {
    logger.info("Duplicate message ignored", {
      chatId,
      messageId: event.messageId,
    });
  }

  const row = await db
    .prepare(
      `SELECT id FROM active_messages WHERE chat_id = ? AND telegram_message_id = ?`
    )
    .bind(chatId, event.messageId)
    .first<{ id: number }>();

  if (!row) throw new Error(`Failed to insert message ${event.messageId}`);
  return row.id;
}

/**
 * Persist a classification result for a message.
 */
export async function persistClassification(
  db: D1Database,
  messageId: number,
  chatId: number,
  result: ClassificationResult
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO classifications (message_id, chat_id, label, confidence, method)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(messageId, chatId, result.label, result.confidence, result.method)
    .run();
}
