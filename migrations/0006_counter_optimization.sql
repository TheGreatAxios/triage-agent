-- Migration: D1 Row Optimization - Counter Tables and Covering Indexes
-- Created: 2026-04-24
-- Purpose: Eliminate full table scans by maintaining running counters
-- This reduces rows read from millions to single digits per operation

-- ============================================================================
-- COUNTER TABLES
-- ============================================================================

-- Core counter for archiver (MOST CRITICAL - saves full table scans)
-- Tracks message counts per chat to avoid SELECT COUNT(*) GROUP BY queries
CREATE TABLE IF NOT EXISTS chat_message_counts (
  chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  hot_count INTEGER NOT NULL DEFAULT 0,      -- Messages currently in active_messages
  archived_count INTEGER NOT NULL DEFAULT 0, -- Total messages archived to R2
  needs_archival INTEGER NOT NULL DEFAULT 0, -- Boolean: hot_count > 200?
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Covering index for archiver - only reads rows needing archival
-- This turns a 200,000+ row scan into ~10 row lookup
CREATE INDEX idx_chat_counts_needs_archival ON chat_message_counts(needs_archival, chat_id) 
  WHERE needs_archival = 1;

-- Index for rate limiter fast path
CREATE INDEX idx_chat_counts_hot ON chat_message_counts(chat_id, hot_count);

-- Daily stats with optional chat-level granularity
-- Supports both global (chat_id IS NULL) and per-chat stats
CREATE TABLE IF NOT EXISTS daily_stats_optimized (
  date TEXT NOT NULL,                      -- '2026-04-24'
  stat_name TEXT NOT NULL,                 -- Flexible: 'messages', 'escalations', etc.
  chat_id INTEGER,                         -- NULL for global aggregate, set for chat-level
  counter INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, stat_name, chat_id)
);

-- Index for global stats queries (dashboard, AM/PM reports)
CREATE INDEX idx_daily_stats_global ON daily_stats_optimized(date, stat_name) 
  WHERE chat_id IS NULL;

-- Index for chat-level stats queries (per-chat analytics)
CREATE INDEX idx_daily_stats_chat ON daily_stats_optimized(date, stat_name, chat_id) 
  WHERE chat_id IS NOT NULL;

-- Monthly rollup (kept forever, aggregated from daily)
CREATE TABLE IF NOT EXISTS monthly_stats (
  month TEXT NOT NULL,                     -- '2026-04'
  stat_name TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, stat_name)
);

-- Reconciliation audit log (tracks counter drift corrections)
CREATE TABLE IF NOT EXISTS counter_reconciliation_log (
  id INTEGER PRIMARY KEY,
  table_name TEXT NOT NULL,
  chat_id INTEGER,
  stat_name TEXT,
  expected_count INTEGER,
  actual_count INTEGER,
  reconciled_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_reconciliation_log_time ON counter_reconciliation_log(reconciled_at);
CREATE INDEX idx_reconciliation_log_table ON counter_reconciliation_log(table_name, reconciled_at);

-- ============================================================================
-- COVERING INDEXES FOR QUERY OPTIMIZATION
-- ============================================================================

-- Covering index for message retrieval with sender context
-- Eliminates table lookups when fetching message context for AI prompts
-- Partial index WHERE text IS NOT NULL (skips media-only messages)
CREATE INDEX IF NOT EXISTS idx_messages_covering ON active_messages(
  chat_id,           -- Primary filter
  created_at DESC,   -- Sort order for recent messages
  sender_id,         -- For JOIN with chat_participants
  text,              -- Message content
  telegram_message_id, -- External reference
  event_type,        -- Message type
  is_mention         -- Mention flag
) WHERE text IS NOT NULL;

-- Covering index for classification lookups
-- Used when fetching classification history for a chat
CREATE INDEX IF NOT EXISTS idx_classifications_covering ON classifications(
  chat_id,           -- Primary filter
  created_at DESC,    -- Sort order
  label,              -- Classification label
  confidence,         -- Confidence score
  method              -- Rule vs AI
);

-- Covering index for timer queries (scheduled job lookups)
CREATE INDEX IF NOT EXISTS idx_timers_covering ON timers(
  status,             -- Filter: only 'active'
  fires_at,            -- Filter: fires_at <= now
  id, chat_id, type, payload, created_at  -- Covering columns
) WHERE status = 'active';

-- ============================================================================
-- DATA RETENTION & CAPS (enforced by rollup jobs)
-- ============================================================================
--
-- daily_stats_optimized:
--   - Retention: 90 days (rolled up to monthly, then deleted)
--   - Max rows estimate: 90 days × ~20 stat types × (1 global + 1000 chats) = ~1.8M rows
--   - Actually lower since chat-level is optional
--
-- monthly_stats:
--   - Retention: Forever (but only monthly granularity)
--   - Max rows estimate: 12 months × 20 stat types × 10 years = 2,400 rows
--
-- counter_reconciliation_log:
--   - Retention: 90 days (cleaned up weekly after reconciliation)
--   - Max rows estimate: Weekly runs × drift events (should be rare)
--
-- chat_message_counts:
--   - Retention: Row per chat, deleted with chat via CASCADE
--   - Max rows: Equal to number of chats (capped by business growth)
--
-- ============================================================================
-- INITIALIZATION NOTES
-- ============================================================================
-- After applying this migration, initialize counters from existing data:
--
-- INSERT INTO chat_message_counts (chat_id, hot_count, needs_archival)
-- SELECT chat_id, COUNT(*), CASE WHEN COUNT(*) > 200 THEN 1 ELSE 0 END
-- FROM active_messages
-- GROUP BY chat_id;
--
-- This initial population is expensive (full table scan) but done once.
-- After that, counters are maintained incrementally.
