-- Migration 0010: Triage Audit & Safety
-- Adds output validation, threshold enforcement, and full audit trail for triage decisions.
--
-- Changes:
--   1. Add columns to drafts for dual-confidence tracking + tool provenance
--   2. Add content_safety table for moderation results
--   3. Create triage_decisions audit table

-- ============================================================================
-- PART 1: Enhance drafts table with dual-confidence and provenance
-- ============================================================================

-- NOTE: The drafts columns below were already applied to the remote DB by
-- earlier schema drift / failed partial migration attempts. SQLite/D1 does not
-- support ALTER TABLE ... ADD COLUMN IF NOT EXISTS, and failed DDL migrations can
-- leave prior ALTER statements committed even when the migration is not recorded.
-- Expected drafts columns for this release:
--   response_confidence REAL
--   reasoning TEXT
--   classification_label TEXT
--   classification_confidence REAL
--   tools_used TEXT
--   tool_results TEXT
--   content_filtered INTEGER NOT NULL DEFAULT 0
--   method TEXT NOT NULL DEFAULT 'model'

CREATE INDEX IF NOT EXISTS idx_drafts_confidence ON drafts(chat_id, response_confidence, status);

-- ============================================================================
-- PART 2: Content safety log (output moderation results)
-- ============================================================================

CREATE TABLE IF NOT EXISTS content_safety_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  draft_id INTEGER REFERENCES drafts(id),
  content TEXT NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0,          -- Was any category flagged?
  categories TEXT,                              -- JSON: which categories were flagged
  scores TEXT,                                  -- JSON: per-category scores
  action_taken TEXT NOT NULL DEFAULT 'pass'     -- 'pass' | 'blocked' | 'rejected'
    CHECK(action_taken IN ('pass', 'blocked', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_safety_chat ON content_safety_log(chat_id);
CREATE INDEX IF NOT EXISTS idx_content_safety_flagged ON content_safety_log(flagged) WHERE flagged = 1;

-- ============================================================================
-- PART 3: Triage decisions audit trail
-- ============================================================================

CREATE TABLE IF NOT EXISTS triage_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES active_messages(id),
  db_message_id INTEGER,                         -- active_messages.id for the triaged message

  -- Classification
  label TEXT NOT NULL,
  classification_confidence REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'model',

  -- Action + draft
  action TEXT NOT NULL CHECK(action IN ('auto_send', 'escalate', 'draft_only', 'defer')),
  draft_content TEXT,
  draft_confidence REAL,

  -- Threshold enforcement results
  classification_threshold_passed INTEGER NOT NULL DEFAULT 0,
  draft_threshold_passed INTEGER NOT NULL DEFAULT 0,
  overall_decision TEXT NOT NULL CHECK(overall_decision IN ('sent', 'blocked_by_threshold', 'blocked_by_content_filter', 'blocked', 'no_draft', 'deferred')),

  -- Content safety
  content_flagged INTEGER NOT NULL DEFAULT 0,
  content_safety_categories TEXT,

  -- Timing
  execution_time_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_triage_decisions_chat ON triage_decisions(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_triage_decisions_label ON triage_decisions(label);
CREATE INDEX IF NOT EXISTS idx_triage_decisions_overall ON triage_decisions(overall_decision);
CREATE INDEX IF NOT EXISTS idx_triage_decisions_message ON triage_decisions(message_id);
