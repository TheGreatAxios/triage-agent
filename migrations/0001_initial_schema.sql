-- Telegram chats being tracked
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY,
  telegram_chat_id INTEGER NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'group',
  title TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chats_telegram_id ON chats(telegram_chat_id);

-- Participants in each chat
CREATE TABLE IF NOT EXISTS chat_participants (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  telegram_user_id INTEGER NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL,
  username TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chat_id, telegram_user_id)
);

CREATE INDEX idx_participants_chat ON chat_participants(chat_id);

-- Recent messages (hot state, pruned on archive)
CREATE TABLE IF NOT EXISTS active_messages (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  telegram_message_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL REFERENCES chat_participants(id),
  text TEXT,
  event_type TEXT NOT NULL DEFAULT 'message',
  is_mention INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chat_id, telegram_message_id)
);

CREATE INDEX idx_messages_chat_time ON active_messages(chat_id, created_at);

-- Per-chat conversation state
CREATE TABLE IF NOT EXISTS conversation_state (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
  last_human_response_at TEXT,
  last_bot_response_at TEXT,
  pending_trigger INTEGER NOT NULL DEFAULT 0,
  trigger_type TEXT,
  trigger_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Chat summaries (cached, refreshed periodically)
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  message_range_start INTEGER,
  message_range_end INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_summaries_chat ON summaries(chat_id);

-- Message classifications
CREATE TABLE IF NOT EXISTS classifications (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES active_messages(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.0,
  method TEXT NOT NULL DEFAULT 'rule',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_classifications_message ON classifications(message_id);
CREATE INDEX idx_classifications_chat ON classifications(chat_id);

-- Draft responses
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.0,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_drafts_chat ON drafts(chat_id);
CREATE INDEX idx_drafts_status ON drafts(status);

-- Slack escalations
CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  draft_id INTEGER REFERENCES drafts(id),
  reason TEXT NOT NULL,
  slack_message_ts TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_escalations_chat ON escalations(chat_id);
CREATE INDEX idx_escalations_status ON escalations(status);

-- Linear issue links
CREATE TABLE IF NOT EXISTS linear_links (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES active_messages(id),
  linear_issue_id TEXT NOT NULL,
  linear_issue_url TEXT NOT NULL,
  issue_type TEXT NOT NULL DEFAULT 'triage',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_linear_links_chat ON linear_links(chat_id);

-- R2 archive pointers
CREATE TABLE IF NOT EXISTS archives (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_archives_chat ON archives(chat_id);

-- Timers for delayed actions (e.g., 30s no-response trigger)
CREATE TABLE IF NOT EXISTS timers (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  fires_at TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_timers_fires_at ON timers(fires_at) WHERE status = 'active';
CREATE INDEX idx_timers_chat ON timers(chat_id);
