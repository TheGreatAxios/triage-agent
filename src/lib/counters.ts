/**
 * Counter Maintenance Module for D1 Row Optimization
 * 
 * This module maintains running counters to eliminate expensive COUNT(*)
 * and GROUP BY queries at massive scale.
 * 
 * Key tables:
 * - chat_message_counts: Tracks per-chat message counts for archiver
 * - daily_stats_optimized: Pre-aggregated daily statistics
 * - monthly_stats: Rolled-up monthly statistics
 * 
 * Pattern: Every write operation increments relevant counters atomically.
 * This turns O(n) read queries into O(1) lookups.
 */

import { logger } from "./logger";

/**
 * Increment message counters after successful message insertion.
 * Updates chat_message_counts (for archiver) and daily_stats_optimized.
 * 
 * Should be called in same transaction as message insert for consistency.
 */
export async function incrementMessageCounters(
  db: D1Database,
  chatId: number,
  statName: string = "messages"
): Promise<void> {
  const today = new Date().toISOString().split("T")[0];

  try {
    await db.batch([
      // 1. Update chat_message_counts (for archiver fast lookup)
      // NOTE: SQLite ON CONFLICT doesn't allow referencing the new value in CASE,
      // so we calculate needs_archival based on the incremented value logic
      db.prepare(`
        INSERT INTO chat_message_counts (chat_id, hot_count, needs_archival, updated_at)
        VALUES (?, 1, 0, datetime('now'))
        ON CONFLICT(chat_id) DO UPDATE SET
          hot_count = chat_message_counts.hot_count + 1,
          needs_archival = CASE 
            WHEN (chat_message_counts.hot_count + 1) > 200 THEN 1 
            ELSE 0 
          END,
          updated_at = datetime('now')
      `).bind(chatId),

      // 2. Update daily stats (global aggregate)
      db.prepare(`
        INSERT INTO daily_stats_optimized (date, stat_name, chat_id, counter)
        VALUES (?, ?, NULL, 1)
        ON CONFLICT(date, stat_name, chat_id) DO UPDATE SET
          counter = counter + 1
      `).bind(today, statName),

      // 3. Update daily stats (chat-level)
      db.prepare(`
        INSERT INTO daily_stats_optimized (date, stat_name, chat_id, counter)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(date, stat_name, chat_id) DO UPDATE SET
          counter = counter + 1
      `).bind(today, statName, chatId),
    ]);
  } catch (err) {
    // Counter failures shouldn't block message processing
    // Log but don't throw - counters can be reconciled weekly
    logger.warn("Failed to increment counters", {
      chatId,
      statName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Decrement hot counter after messages are archived to R2.
 * Updates archived_count and recalculates needs_archival flag.
 */
export async function decrementHotCount(
  db: D1Database,
  chatId: number,
  archivedCount: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE chat_message_counts
       SET hot_count = hot_count - ?,
           archived_count = archived_count + ?,
           needs_archival = CASE WHEN (hot_count - ?) > 200 THEN 1 ELSE 0 END,
           updated_at = datetime('now')
       WHERE chat_id = ?`
    )
    .bind(archivedCount, archivedCount, archivedCount, chatId)
    .run();
}

/**
 * Get chats that need archival (hot_count > 200).
 * O(1) lookup - reads only rows where needs_archival = 1.
 * Replaces expensive GROUP BY query that scanned entire table.
 */
export async function getOverflowingChats(
  db: D1Database
): Promise<Array<{ chat_id: number; hot_count: number }>> {
  const { results } = await db
    .prepare(
      `SELECT chat_id, hot_count 
       FROM chat_message_counts 
       WHERE needs_archival = 1`
    )
    .all<{ chat_id: number; hot_count: number }>();

  return results || [];
}

/**
 * Increment classification counter for analytics.
 * Call after persistClassification with label-specific stat name.
 */
export async function incrementClassificationCounter(
  db: D1Database,
  chatId: number,
  label: string
): Promise<void> {
  const statName = `classification_${label}`;
  await incrementMessageCounters(db, chatId, statName);
}


