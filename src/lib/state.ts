import type { InternalEvent } from "../types/events";
import { getConfig } from "./config";
import { logger } from "./logger";

export interface ConversationState {
  id: number;
  chatId: number;
  lastHumanResponseAt: string | null;
  lastBotResponseAt: string | null;
  pendingTrigger: boolean;
  triggerType: string | null;
  triggerAt: string | null;
  messageCount: number;
  updatedAt: string;
  // Agent tracking fields (from migration 0007)
  agentDraftPending?: boolean;
  lastDraftSentAt?: string | null;
  lastDraftId?: number | null;
  resolutionStatus?: string;
  solutionAttemptCount?: number;
  threadConfidenceScore?: number;
}

export interface Timer {
  id: number;
  chatId: number;
  type: string;
  firesAt: string;
  payload: string | null;
  status: string;
  createdAt: string;
}

/**
 * Upsert conversation state for a chat after each ingested message.
 * Tracks last human/bot response and increments message count.
 */
export async function updateConversationState(
  db: D1Database,
  chatId: number,
  event: InternalEvent
): Promise<void> {
  const isBot = event.sender.isBot;
  const now = event.timestamp;

  // Upsert: update timestamps conditionally based on sender type
  // CASE expressions: update human timestamp only for human messages, bot timestamp only for bot messages
  // message_count always increments to track conversation length
  await db
    .prepare(
      `INSERT INTO conversation_state (chat_id, last_human_response_at, last_bot_response_at, message_count, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (chat_id) DO UPDATE SET
         last_human_response_at = CASE WHEN ? = 0 THEN ? ELSE conversation_state.last_human_response_at END,
         last_bot_response_at = CASE WHEN ? = 1 THEN ? ELSE conversation_state.last_bot_response_at END,
         message_count = conversation_state.message_count + 1,
         updated_at = ?`
    )
    .bind(
      chatId,
      isBot ? null : now,
      isBot ? now : null,
      now,
      isBot ? 1 : 0,
      now,
      isBot ? 1 : 0,
      now,
      now
    )
    .run();
}

/**
 * Schedule a no-response timer for a chat.
 * Fires after `noResponseDelaySeconds` from now.
 */
export async function scheduleNoResponseTimer(
  db: D1Database,
  chatId: number,
  triggerType: "mention" | "no_response"
): Promise<void> {
  const config = getConfig();
  const firesAt = new Date(
    Date.now() + config.noResponseDelaySeconds * 1000
  ).toISOString();

  await db
    .prepare(
      `INSERT INTO timers (chat_id, type, fires_at, payload, status)
       VALUES (?, ?, ?, ?, 'active')`
    )
    .bind(chatId, triggerType, firesAt, null)
    .run();

  // Mirror timer state to conversation_state for quick lookup
  // Avoids JOIN to timers table when checking if a chat has pending triggers
  await db
    .prepare(
      `UPDATE conversation_state
       SET pending_trigger = 1, trigger_type = ?, trigger_at = ?, updated_at = datetime('now')
       WHERE chat_id = ?`
    )
    .bind(triggerType, firesAt, chatId)
    .run();

  logger.info("Timer scheduled", { chatId, triggerType, firesAt });
}

/**
 * Cancel all active timers for a chat (e.g., when a human responds).
 */
export async function cancelTimers(
  db: D1Database,
  chatId: number
): Promise<number> {
  // Soft-delete: mark timers as cancelled rather than deleting
  // Preserves audit trail of timer lifecycle
  const result = await db
    .prepare(
      `UPDATE timers SET status = 'cancelled' WHERE chat_id = ? AND status = 'active'`
    )
    .bind(chatId)
    .run();

  // Clear the mirrored trigger state in conversation_state
  if (result.meta.changes > 0) {
    await db
      .prepare(
        `UPDATE conversation_state
         SET pending_trigger = 0, trigger_type = NULL, trigger_at = NULL, updated_at = datetime('now')
         WHERE chat_id = ?`
      )
      .bind(chatId)
      .run();

    logger.info("Timers cancelled", {
      chatId,
      count: result.meta.changes,
    });
  }

  return result.meta.changes;
}

/**
 * Get all timers that have fired (fires_at <= now) and are still active.
 */
export async function getFiredTimers(db: D1Database): Promise<Timer[]> {
  const now = new Date().toISOString();

  // Query: Find timers that should have fired by now (fires_at <= current time)
  // Only active timers; cancelled/fired timers are excluded
  // Process oldest timers first for fairness
  const { results } = await db
    .prepare(
      `SELECT id, chat_id, type, fires_at, payload, status, created_at
       FROM timers
       WHERE status = 'active' AND fires_at <= ?
       ORDER BY fires_at ASC`
    )
    .bind(now)
    .all<{
      id: number;
      chat_id: number;
      type: string;
      fires_at: string;
      payload: string | null;
      status: string;
      created_at: string;
    }>();

  return results.map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    type: row.type,
    firesAt: row.fires_at,
    payload: row.payload,
    status: row.status,
    createdAt: row.created_at,
  }));
}

/**
 * Mark a timer as fired after processing.
 */
export async function markTimerFired(
  db: D1Database,
  timerId: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE timers SET status = 'fired' WHERE id = ?`
    )
    .bind(timerId)
    .run();
}

/**
 * Get conversation state for a chat.
 */
export async function getConversationState(
  db: D1Database,
  chatId: number
): Promise<ConversationState | null> {
  const row = await db
    .prepare(
      `SELECT * FROM conversation_state WHERE chat_id = ?`
    )
    .bind(chatId)
    .first<{
      id: number;
      chat_id: number;
      last_human_response_at: string | null;
      last_bot_response_at: string | null;
      pending_trigger: number;
      trigger_type: string | null;
      trigger_at: string | null;
      message_count: number;
      updated_at: string;
    }>();

  if (!row) return null;

  return {
    id: row.id,
    chatId: row.chat_id,
    lastHumanResponseAt: row.last_human_response_at,
    lastBotResponseAt: row.last_bot_response_at,
    pendingTrigger: row.pending_trigger === 1,
    triggerType: row.trigger_type,
    triggerAt: row.trigger_at,
    messageCount: row.message_count,
    updatedAt: row.updated_at,
  };
}
