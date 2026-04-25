/**
 * Counter Reconciliation Job
 * 
 * Weekly job to verify and fix any counter drift.
 * Runs every Sunday at 3 AM UTC.
 * 
 * This is a safety net - counters should stay accurate due to atomic updates,
 * but edge cases (failed transactions, race conditions) could cause drift.
 * 
 * At massive scale, this is the ONLY full table scan we allow - and it's weekly,
 * not per-request.
 */

import type { Env } from "../../types/env";
import { logger } from "../logger";

export interface ReconciliationResult {
  chatsChecked: number;
  chatsFixed: number;
  totalDrift: number;
}

/**
 * Maximum chats to check in one reconciliation run.
 * Prevents runaway queries if something goes wrong.
 * At 500 chats/batch × 100 batches = 50K chats max per run.
 */
const MAX_RECONCILIATION_CHATS = 50000;

/**
 * Reconcile chat_message_counts against actual active_messages.
 * Finds any drift and fixes it.
 * 
 * Process in batches to avoid timeouts on massive datasets.
 * Hard cap at MAX_RECONCILIATION_CHATS to prevent runaway queries.
 */
export async function reconcileCounters(
  env: Env,
  batchSize: number = 500
): Promise<ReconciliationResult> {
  const db = env.DB;
  let totalChecked = 0;
  let totalFixed = 0;
  let totalDrift = 0;

  logger.info("Starting counter reconciliation");

  // Process chats in batches using offset-based pagination
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    // Get batch of chats to check
    const { results } = await db
      .prepare(
        `SELECT 
          cmc.chat_id,
          cmc.hot_count as expected_count,
          COUNT(am.id) as actual_count
        FROM chat_message_counts cmc
        LEFT JOIN active_messages am ON am.chat_id = cmc.chat_id
        GROUP BY cmc.chat_id
        HAVING cmc.hot_count != COUNT(am.id)
        LIMIT ? OFFSET ?`
      )
      .bind(batchSize, offset)
      .all<{
        chat_id: number;
        expected_count: number;
        actual_count: number;
      }>();

    if (!results || results.length === 0) {
      hasMore = false;
      break;
    }

    // Fix each drifted chat
    for (const row of results) {
      const drift = Math.abs(row.expected_count - row.actual_count);
      
      await db
        .prepare(
          `UPDATE chat_message_counts
           SET hot_count = ?,
               needs_archival = CASE WHEN ? > 200 THEN 1 ELSE 0 END,
               updated_at = datetime('now')
           WHERE chat_id = ?`
        )
        .bind(row.actual_count, row.actual_count, row.chat_id)
        .run();

      // Log for audit
      await db
        .prepare(
          `INSERT INTO counter_reconciliation_log 
           (table_name, chat_id, stat_name, expected_count, actual_count)
           VALUES ('chat_message_counts', ?, 'hot_count', ?, ?)`
        )
        .bind(row.chat_id, row.expected_count, row.actual_count)
        .run();

      totalFixed++;
      totalDrift += drift;

      logger.debug("Fixed counter drift", {
        chatId: row.chat_id,
        expected: row.expected_count,
        actual: row.actual_count,
        drift,
      });
    }

    totalChecked += results.length;
    offset += batchSize;

    logger.info("Reconciliation batch complete", {
      batchChecked: results.length,
      totalChecked,
      totalFixed,
    });

    // Hard cap to prevent runaway queries
    if (offset >= MAX_RECONCILIATION_CHATS) {
      logger.warn("Reconciliation hit MAX_RECONCILIATION_CHATS limit", {
        max: MAX_RECONCILIATION_CHATS,
        processed: totalChecked,
      });
      break;
    }
  }

  logger.info("Counter reconciliation complete", {
    chatsChecked: totalChecked,
    chatsFixed: totalFixed,
    totalDrift,
  });

  return {
    chatsChecked: totalChecked,
    chatsFixed: totalFixed,
    totalDrift,
  };
}

/**
 * Hard cap on reconciliation log retention (days).
 * 90 days is sufficient for audit purposes.
 * 120 days provides buffer if weekly cleanup fails.
 */
const MAX_RECONCILIATION_LOG_DAYS = 120;

/**
 * Clean up old reconciliation logs (> 90 days).
 * Prevents unbounded growth of audit table.
 */
export async function cleanupOldReconciliationLogs(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM counter_reconciliation_log 
     WHERE reconciled_at < datetime('now', '-90 days')`
  ).run();

  const deleted = result.meta.changes ?? 0;

  if (deleted > 0) {
    logger.info("Cleaned up old reconciliation logs", { deleted });
  }

  // Emergency hard cap cleanup (only if > 120 days somehow present)
  const emergencyResult = await env.DB.prepare(
    `DELETE FROM counter_reconciliation_log 
     WHERE reconciled_at < datetime('now', '-${MAX_RECONCILIATION_LOG_DAYS} days')`
  ).run();

  const emergencyDeleted = emergencyResult.meta.changes ?? 0;
  if (emergencyDeleted > deleted) {
    logger.warn("Emergency reconciliation log cleanup triggered", {
      emergencyDeleted: emergencyDeleted - deleted,
    });
  }

  return deleted + (emergencyDeleted - deleted);
}
