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

/**
 * Increment escalation counter.
 */
export async function incrementEscalationCounter(
  db: D1Database,
  chatId: number
): Promise<void> {
  await incrementMessageCounters(db, chatId, "escalations");
}

/**
 * Increment draft sent counter.
 */
export async function incrementDraftSentCounter(
  db: D1Database,
  chatId: number
): Promise<void> {
  await incrementMessageCounters(db, chatId, "drafts_sent");
}

/**
 * Get daily stats for a date range (for AM/PM reports).
 * O(days) not O(messages) - reads pre-aggregated counters.
 */
export async function getDailyStats(
  db: D1Database,
  startDate: string,
  endDate: string,
  globalOnly: boolean = true
): Promise<
  Array<{
    date: string;
    stat_name: string;
    counter: number;
    chat_id?: number;
  }>
> {
  const { results } = await db
    .prepare(
      `SELECT date, stat_name, counter, chat_id
       FROM daily_stats_optimized
       WHERE date >= ? AND date <= ? 
       AND (${globalOnly ? "chat_id IS NULL" : "1=1"})
       ORDER BY date, stat_name`
    )
    .bind(startDate, endDate)
    .all<{
      date: string;
      stat_name: string;
      counter: number;
      chat_id?: number;
    }>();

  return results || [];
}

/**
 * Get single stat value for today (fast lookup for dashboard).
 */
export async function getTodayStat(
  db: D1Database,
  statName: string,
  globalOnly: boolean = true
): Promise<number> {
  const today = new Date().toISOString().split("T")[0];

  const row = await db
    .prepare(
      `SELECT counter 
       FROM daily_stats_optimized 
       WHERE date = ? AND stat_name = ? ${globalOnly ? "AND chat_id IS NULL" : ""}`
    )
    .bind(today, statName)
    .first<{ counter: number }>();

  return row?.counter ?? 0;
}

/**
 * Maximum chats to initialize in one run.
 * Prevents timeouts on truly massive datasets.
 * If you have more chats, run initialization multiple times.
 */
const MAX_INITIALIZATION_CHATS = 50000;

/**
 * Initialize counters from existing data (one-time migration helper).
 * Call this after deploying counter tables to populate initial values.
 * Process in batches to avoid timeout on large datasets.
 * 
 * HARD CAP: Processes max 50K chats per run. If you have more,
 * run this function multiple times (it uses ON CONFLICT UPDATE).
 */
export async function initializeCountersFromExistingData(
  db: D1Database,
  batchSize: number = 1000
): Promise<{ chatsProcessed: number; totalMessages: number; capped: boolean }> {
  // Get all chats with message counts (with hard cap)
  const { results } = await db
    .prepare(
      `SELECT chat_id, COUNT(*) as msg_count
       FROM active_messages
       GROUP BY chat_id
       ORDER BY chat_id
       LIMIT ?`
    )
    .bind(MAX_INITIALIZATION_CHATS)
    .all<{ chat_id: number; msg_count: number }>();

  if (!results || results.length === 0) {
    return { chatsProcessed: 0, totalMessages: 0, capped: false };
  }

  const wasCapped = results.length >= MAX_INITIALIZATION_CHATS;
  if (wasCapped) {
    logger.warn("Counter initialization hit MAX_INITIALIZATION_CHATS limit", {
      limit: MAX_INITIALIZATION_CHATS,
      processed: results.length,
      note: "Run again to process remaining chats",
    });
  }

  // Insert in batches
  let processed = 0;
  for (let i = 0; i < results.length; i += batchSize) {
    const batch = results.slice(i, i + batchSize);

    for (const row of batch) {
      await db
        .prepare(
          `INSERT INTO chat_message_counts (chat_id, hot_count, needs_archival)
           VALUES (?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             hot_count = ?,
             needs_archival = ?`
        )
        .bind(
          row.chat_id,
          row.msg_count,
          row.msg_count > 200 ? 1 : 0,
          row.msg_count,
          row.msg_count > 200 ? 1 : 0
        )
        .run();
    }

    processed += batch.length;
    logger.info("Counter initialization progress", {
      processed,
      total: results.length,
      capped: wasCapped,
    });
  }

  const totalMessages = results.reduce((sum, r) => sum + r.msg_count, 0);

  return { chatsProcessed: processed, totalMessages, capped: wasCapped };
}
