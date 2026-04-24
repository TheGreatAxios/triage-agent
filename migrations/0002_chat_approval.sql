-- Migration: Chat Approval System with Blacklist and Daily Stats
-- Created: 2026-04-24
-- Note: SQLite ALTER TABLE doesn't support non-constant defaults, so we use CURRENT_TIMESTAMP

-- Add approval status columns to chats table
-- Note: SQLite ALTER TABLE only allows CONSTANT defaults (literals, not functions like datetime())
ALTER TABLE chats ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE chats ADD COLUMN first_added_at TEXT; -- Nullable, set by app code
ALTER TABLE chats ADD COLUMN approved_at TEXT;
ALTER TABLE chats ADD COLUMN approved_by TEXT;
ALTER TABLE chats ADD COLUMN rejected_at TEXT;
ALTER TABLE chats ADD COLUMN left_at TEXT;
ALTER TABLE chats ADD COLUMN is_blacklisted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN blacklisted_at TEXT;
ALTER TABLE chats ADD COLUMN blacklisted_by TEXT;
ALTER TABLE chats ADD COLUMN blacklisted_reason TEXT;

-- Index for approval status lookups
CREATE INDEX idx_chats_approval_status ON chats(approval_status);
CREATE INDEX idx_chats_blacklisted ON chats(is_blacklisted) WHERE is_blacklisted = 1;

-- Pending approval queue with rich metadata and complexity tracking
-- (CREATE TABLE supports non-constant defaults, only ALTER TABLE is restricted)
CREATE TABLE IF NOT EXISTS pending_approvals (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
  slack_message_ts TEXT,
  slack_channel_id TEXT,
  slack_blocks_type TEXT DEFAULT 'minimal', -- 'minimal' or 'rich'
  requested_by_name TEXT,
  requested_by_username TEXT,
  requested_by_user_id INTEGER,
  chat_type TEXT NOT NULL, -- 'private', 'group', 'supergroup', 'channel'
  chat_title TEXT,
  chat_username TEXT,
  member_count INTEGER,
  complexity_score REAL, -- 0.0 to 1.0 calculated score
  complexity_factors TEXT, -- JSON blob of factors that contributed to score
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'expired'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+72 hours')),
  resolved_at TEXT,
  resolved_by_slack_user_id TEXT,
  resolved_by_slack_user_name TEXT,
  rejection_message_sent INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_pending_approvals_status ON pending_approvals(status);
CREATE INDEX idx_pending_approvals_expires ON pending_approvals(expires_at) WHERE status = 'pending';
CREATE INDEX idx_pending_approvals_created ON pending_approvals(created_at);
CREATE INDEX idx_pending_approvals_chat ON pending_approvals(chat_id);

-- Bot metadata cache (fetched once from Telegram API)
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Insert default bot metadata placeholder
INSERT OR IGNORE INTO app_config (key, value) VALUES ('bot_metadata_initialized', 'false');

-- Daily stats tracking for morning (8am PST) and evening (4pm PST) summaries
CREATE TABLE IF NOT EXISTS daily_stats (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  period TEXT NOT NULL, -- 'morning', 'evening'
  total_chats INTEGER NOT NULL DEFAULT 0,
  approved_chats INTEGER NOT NULL DEFAULT 0,
  pending_chats INTEGER NOT NULL DEFAULT 0,
  rejected_chats INTEGER NOT NULL DEFAULT 0,
  expired_chats INTEGER NOT NULL DEFAULT 0,
  blacklisted_chats INTEGER NOT NULL DEFAULT 0,
  total_messages INTEGER NOT NULL DEFAULT 0,
  unique_users INTEGER NOT NULL DEFAULT 0,
  active_chats INTEGER NOT NULL DEFAULT 0, -- Chats with messages in this period
  approval_decisions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, period)
);

CREATE INDEX idx_daily_stats_date ON daily_stats(date);
CREATE INDEX idx_daily_stats_period ON daily_stats(period);

-- Table to track chat membership history (for prior summary lookups)
CREATE TABLE IF NOT EXISTS chat_membership_history (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, -- 'added', 'removed', 'approved', 'rejected', 'expired'
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  performed_by TEXT, -- Slack user who performed action (if applicable)
  metadata TEXT -- JSON blob with additional context
);

CREATE INDEX idx_membership_history_chat ON chat_membership_history(chat_id);
CREATE INDEX idx_membership_history_event ON chat_membership_history(event_type);

-- Add index for efficient recent message lookups (for complexity calculation)
CREATE INDEX IF NOT EXISTS idx_active_messages_chat_time_desc ON active_messages(chat_id, created_at DESC);
