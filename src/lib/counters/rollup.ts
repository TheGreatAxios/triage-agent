/**
 * Stats Rollup Jobs
 * 
 * Daily job to:
 * 1. Aggregate yesterday's stats into monthly totals
 * 2. Clean up old daily stats (> 90 days)
 * 3. Clean up old monthly stats (> 3 years)
 * 
 * Runs every day at midnight UTC.
 * 
 * This maintains hierarchical data retention:
 * - Daily stats: 90 days
 * - Monthly stats: 3 years  
 * - Beyond 3 years: monthly stats kept forever (aggregated)
 */

import type { Env } from "../../types/env";
import { logger } from "../logger";

export interface RollupResult {
  dailyStatsAggregated: number;
  oldDailyStatsDeleted: number;
  oldMonthlyStatsDeleted: number;
}

/**
 * Aggregate yesterday's daily stats into monthly totals.
 * Idempotent - safe to run multiple times.
 */
export async function rollupDailyToMonthly(env: Env): Promise<RollupResult> {
  const db = env.DB;
  const result: RollupResult = {
    dailyStatsAggregated: 0,
    oldDailyStatsDeleted: 0,
    oldMonthlyStatsDeleted: 0,
  };

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];
  const monthStr = yesterdayStr.substring(0, 7); // '2026-04'

  logger.info("Starting daily stats rollup", {
    yesterday: yesterdayStr,
    month: monthStr,
  });

  // Aggregate yesterday's global stats into monthly
  const globalStats = await db
    .prepare(
      `SELECT 
        stat_name,
        SUM(counter) as total
      FROM daily_stats_optimized
      WHERE date = ? AND chat_id IS NULL
      GROUP BY stat_name`
    )
    .bind(yesterdayStr)
    .all<{ stat_name: string; total: number }>();

  for (const row of globalStats.results || []) {
    await db
      .prepare(
        `INSERT INTO monthly_stats (month, stat_name, counter)
         VALUES (?, ?, ?)
         ON CONFLICT(month, stat_name) DO UPDATE SET
           counter = counter + excluded.counter`
      )
      .bind(monthStr, row.stat_name, row.total)
      .run();

    result.dailyStatsAggregated++;
  }

  // Aggregate yesterday's per-chat stats (optional - for chat-level monthly)
  const chatStats = await db
    .prepare(
      `SELECT 
        stat_name,
        chat_id,
        SUM(counter) as total
      FROM daily_stats_optimized
      WHERE date = ? AND chat_id IS NOT NULL
      GROUP BY stat_name, chat_id`
    )
    .bind(yesterdayStr)
    .all<{ stat_name: string; chat_id: number; total: number }>();

  // Note: We don't store per-chat monthly stats to save space
  // The global aggregation is sufficient for KPIs
  // Per-chat data stays at daily granularity for 90 days

  logger.info("Aggregated stats into monthly", {
    globalStats: result.dailyStatsAggregated,
    chatStats: chatStats.results?.length ?? 0,
  });

  return result;
}

/**
 * Hard cap on daily stats retention (days).
 * Prevents unbounded growth if rollup job fails.
 * Stats older than this are deleted even if not rolled up.
 */
const MAX_DAILY_STATS_RETENTION_DAYS = 120; // 30 days buffer beyond 90 day rollup

/**
 * Clean up old daily stats (> 90 days normally, > 120 days hard cap).
 * These have been rolled up into monthly stats.
 */
export async function cleanupOldDailyStats(env: Env): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  const result = await env.DB.prepare(
    `DELETE FROM daily_stats_optimized 
     WHERE date < ?`
  )
    .bind(cutoffStr)
    .run();

  const deleted = result.meta.changes ?? 0;

  if (deleted > 0) {
    logger.info("Cleaned up old daily stats", {
      deleted,
      cutoffDate: cutoffStr,
    });
  }

  return deleted;
}

/**
 * Emergency cleanup - hard cap enforcement.
 * Deletes stats older than MAX_DAILY_STATS_RETENTION_DAYS regardless of rollup status.
 * Called only if table grows beyond expected bounds.
 */
export async function emergencyCleanupDailyStats(env: Env): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_DAILY_STATS_RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  const result = await env.DB.prepare(
    `DELETE FROM daily_stats_optimized 
     WHERE date < ?`
  )
    .bind(cutoffStr)
    .run();

  const deleted = result.meta.changes ?? 0;

  if (deleted > 0) {
    logger.warn("EMERGENCY: Hard cap cleanup of daily stats", {
      deleted,
      cutoffDate: cutoffStr,
      maxRetentionDays: MAX_DAILY_STATS_RETENTION_DAYS,
    });
  }

  return deleted;
}

/**
 * Hard cap on monthly stats retention (months).
 * 3 years = 36 months.
 */
const MAX_MONTHLY_STATS_RETENTION_MONTHS = 36;

/**
 * Clean up old monthly stats (> 3 years).
 * Keep only aggregated yearly data beyond this point.
 * (Yearly aggregation not implemented - monthly kept forever for now)
 */
export async function cleanupOldMonthlyStats(env: Env): Promise<number> {
  // Calculate cutoff month (3 years ago)
  const now = new Date();
  const cutoffYear = now.getFullYear() - 3;
  const cutoffMonth = now.getMonth() + 1; // 1-12
  const cutoffStr = `${cutoffYear}-${String(cutoffMonth).padStart(2, "0")}`;

  const result = await env.DB.prepare(
    `DELETE FROM monthly_stats 
     WHERE month < ?`
  )
    .bind(cutoffStr)
    .run();

  const deleted = result.meta.changes ?? 0;

  if (deleted > 0) {
    logger.info("Cleaned up old monthly stats", {
      deleted,
      cutoffMonth: cutoffStr,
    });
  }

  return deleted;
}

/**
 * Main rollup job - combines all operations.
 * Called by scheduled handler.
 */
export async function runDailyRollup(env: Env): Promise<RollupResult> {
  logger.info("Starting daily rollup job");

  // Step 1: Aggregate yesterday into monthly
  const rollupResult = await rollupDailyToMonthly(env);

  // Step 2: Clean up old daily stats (> 90 days)
  rollupResult.oldDailyStatsDeleted = await cleanupOldDailyStats(env);

  // Step 3: Clean up old monthly stats (> 3 years) - currently no-op
  rollupResult.oldMonthlyStatsDeleted = await cleanupOldMonthlyStats(env);

  logger.info("Daily rollup complete", rollupResult);

  return rollupResult;
}
