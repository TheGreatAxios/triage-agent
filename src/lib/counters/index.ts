/**
 * Counters Module - D1 Row Optimization
 * 
 * Maintains running counters to eliminate expensive COUNT(*) and GROUP BY queries.
 * This is essential for cost-effective operation at massive scale.
 * 
 * Exports:
 * - Counter maintenance functions (increment/decrement)
 * - Fast lookup functions (getOverflowingChats, getTodayStat, etc.)
 * - Scheduled job handlers (reconciliation, rollup)
 */

// Core counter maintenance
export {
  incrementMessageCounters,
  decrementHotCount,
  incrementClassificationCounter,
  incrementEscalationCounter,
  incrementDraftSentCounter,
  getOverflowingChats,
  getDailyStats,
  getTodayStat,
  initializeCountersFromExistingData,
} from "../counters";

// Reconciliation job (weekly)
export {
  reconcileCounters,
  cleanupOldReconciliationLogs,
  type ReconciliationResult,
} from "./reconciliation";

// Rollup job (daily)
export {
  rollupDailyToMonthly,
  cleanupOldDailyStats,
  cleanupOldMonthlyStats,
  runDailyRollup,
  emergencyCleanupDailyStats,
  type RollupResult,
} from "./rollup";
