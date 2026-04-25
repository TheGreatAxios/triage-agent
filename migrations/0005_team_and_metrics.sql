-- Team members table (runtime configurable, starts empty)
CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT DEFAULT 'agent',
  slack_user_id TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Chat response metrics (one row per chat)
CREATE TABLE IF NOT EXISTS chat_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL UNIQUE,
  first_customer_message_at TEXT,
  first_response_at TEXT,
  first_response_seconds INTEGER,
  last_team_touch_at TEXT,
  total_team_touches INTEGER DEFAULT 0,
  team_member_ids TEXT,
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

-- Team member daily metrics aggregation
CREATE TABLE IF NOT EXISTS team_member_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_member_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  chats_responded INTEGER DEFAULT 0,
  messages_sent INTEGER DEFAULT 0,
  avg_first_response_seconds INTEGER,
  bugs_handled INTEGER DEFAULT 0,
  requests_handled INTEGER DEFAULT 0,
  escalations_created INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(team_member_id, date),
  FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE
);

-- Idempotency tracking for daily summaries (prevents duplicate Slack posts)
CREATE TABLE IF NOT EXISTS daily_summary_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  period TEXT NOT NULL,
  sent_at TEXT DEFAULT (datetime('now')),
  slack_channel TEXT,
  slack_message_ts TEXT,
  UNIQUE(date, period)
);

-- Idempotency tracking for stale chat alerts (prevents duplicate @here spam)
CREATE TABLE IF NOT EXISTS stale_alert_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  alert_type TEXT NOT NULL,
  sent_at TEXT DEFAULT (datetime('now')),
  UNIQUE(chat_id, alert_type),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

-- Idempotency tracking for KPI calculations (prevents duplicate daily aggregation)
CREATE TABLE IF NOT EXISTS kpi_calculation_completed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  calculation_type TEXT NOT NULL,
  completed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(date, calculation_type)
);

-- Timer processing idempotency (prevents duplicate timer execution)
CREATE TABLE IF NOT EXISTS processed_timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timer_id INTEGER NOT NULL,
  processed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(timer_id, processed_at)
);
CREATE INDEX idx_processed_timers_timer ON processed_timers(timer_id);
CREATE INDEX idx_processed_timers_at ON processed_timers(processed_at);

-- Indexes for performance
CREATE INDEX idx_chat_metrics_customer_msg ON chat_metrics(first_customer_message_at);
CREATE INDEX idx_chat_metrics_last_touch ON chat_metrics(last_team_touch_at);
CREATE INDEX idx_chat_metrics_resolved ON chat_metrics(resolved_at);
CREATE INDEX idx_team_member_metrics_date ON team_member_metrics(date);
CREATE INDEX idx_daily_summary_date ON daily_summary_sent(date, period);
CREATE INDEX idx_stale_alert_chat ON stale_alert_sent(chat_id);
