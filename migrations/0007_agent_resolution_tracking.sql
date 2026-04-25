-- Migration 0007: Agent Resolution Tracking
-- Adds agent tracking columns and tables for autonomous support loop management

-- ============================================================================
-- PART 1: Extend conversation_state with agent tracking
-- ============================================================================

-- Add agent tracking columns to conversation_state
ALTER TABLE conversation_state ADD COLUMN agent_draft_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_state ADD COLUMN last_draft_sent_at TEXT;
ALTER TABLE conversation_state ADD COLUMN last_draft_id INTEGER;
ALTER TABLE conversation_state ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'na' CHECK(resolution_status IN ('na', 'awaiting', 'resolved', 'unresolved', 'escalated'));
ALTER TABLE conversation_state ADD COLUMN solution_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_state ADD COLUMN thread_confidence_score REAL DEFAULT 0.0;

-- Create index for agent status queries
CREATE INDEX idx_conversation_state_agent ON conversation_state(agent_draft_pending, resolution_status);
CREATE INDEX idx_conversation_state_resolution ON conversation_state(resolution_status, solution_attempt_count);

-- ============================================================================
-- PART 2: Extend chat_metrics with agent performance metrics
-- ============================================================================

ALTER TABLE chat_metrics ADD COLUMN agent_resolution_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_metrics ADD COLUMN agent_resolutions_successful INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_metrics ADD COLUMN agent_escalations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_metrics ADD COLUMN agent_avg_time_to_ack_seconds REAL;
ALTER TABLE chat_metrics ADD COLUMN agent_avg_time_to_resolution_seconds REAL;
ALTER TABLE chat_metrics ADD COLUMN human_response_after_escalation_seconds REAL;

-- ============================================================================
-- PART 3: Create agent_decisions table (trace logging)
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_decisions (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES active_messages(id),
  action TEXT NOT NULL CHECK(action IN ('respond', 'escalate', 'debounced', 'ignore')),
  content TEXT,  -- Response text if action=respond
  reasoning TEXT NOT NULL,  -- Agent's reasoning for this decision
  confidence REAL NOT NULL DEFAULT 0.0,  -- Agent's confidence in decision
  resolution_signal TEXT CHECK(resolution_signal IN ('resolved', 'acknowledgment', 'unresolved', 'neutral', 'follow_up_needed', 'none')),
  tools_used TEXT,  -- JSON array of tool names used
  execution_time_ms INTEGER,  -- Time taken for agent execution
  is_retry INTEGER NOT NULL DEFAULT 0,  -- Was this a retry after timeout?
  trace_key TEXT,  -- R2 key for full trace archive
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_agent_decisions_chat ON agent_decisions(chat_id, created_at);
CREATE INDEX idx_agent_decisions_action ON agent_decisions(action, resolution_signal);
CREATE INDEX idx_agent_decisions_trace ON agent_decisions(trace_key) WHERE trace_key IS NOT NULL;

-- ============================================================================
-- PART 4: Create agent_follow_ups table (track bump messages and responses)
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_follow_ups (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  draft_id INTEGER REFERENCES drafts(id),
  scheduled_at TEXT NOT NULL,  -- When to send follow-up
  sent_at TEXT,  -- When actually sent
  response_received_at TEXT,  -- When user responded
  follow_up_number INTEGER NOT NULL DEFAULT 1,  -- 1st, 2nd, 3rd follow-up
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'responded', 'expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_agent_follow_ups_chat ON agent_follow_ups(chat_id, status);
CREATE INDEX idx_agent_follow_ups_scheduled ON agent_follow_ups(scheduled_at, status) WHERE status = 'pending';

-- ============================================================================
-- PART 5: Create solution_confidence_snapshots table
-- ============================================================================

CREATE TABLE IF NOT EXISTS solution_confidence_snapshots (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  solution_number INTEGER NOT NULL,  -- Which attempt (1, 2, 3)
  classification_confidence REAL NOT NULL,
  response_confidence REAL NOT NULL,
  combined_confidence REAL NOT NULL,  -- Weighted average
  user_feedback_signal TEXT CHECK(user_feedback_signal IN ('positive', 'negative', 'neutral', 'none')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_solution_confidence_chat ON solution_confidence_snapshots(chat_id, solution_number);

-- ============================================================================
-- PART 6: Create agent_debounces table for message batching
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_debounces (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
  first_message_at TEXT NOT NULL,  -- When first message arrived
  last_message_at TEXT NOT NULL,   -- When most recent message arrived
  message_count INTEGER NOT NULL DEFAULT 1,  -- How many messages batched
  triggered_at TEXT,  -- When agent was actually triggered
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'triggered', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_agent_debounces_active ON agent_debounces(status, last_message_at) WHERE status = 'active';

-- ============================================================================
-- PART 7: Create agent_archives table for R2 trace references
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_archives (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,  -- Full R2 key
  archive_type TEXT NOT NULL CHECK(archive_type IN ('trace', 'conversation', 'kpi')),
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  message_count INTEGER,
  execution_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_agent_archives_chat ON agent_archives(chat_id, archive_type, created_at);
CREATE INDEX idx_agent_archives_r2 ON agent_archives(r2_key);

-- ============================================================================
-- PART 8: Create agent_human_transitions table for handoffs
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_human_transitions (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  escalation_id INTEGER REFERENCES escalations(id),
  agent_decision_id INTEGER REFERENCES agent_decisions(id),
  escalated_at TEXT NOT NULL,
  human_responded_at TEXT,
  response_time_seconds INTEGER,
  resolution_outcome TEXT CHECK(resolution_outcome IN ('agent_success', 'human_resolved', 'human_escalated', 'unresolved')),
  agent_confidence_at_handoff REAL,
  human_confidence_at_resolution REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_agent_human_transitions_chat ON agent_human_transitions(chat_id, escalated_at);
CREATE INDEX idx_agent_human_transitions_outcome ON agent_human_transitions(resolution_outcome);

-- ============================================================================
-- PART 9: Update daily_stats with agent metrics
-- ============================================================================

ALTER TABLE daily_stats ADD COLUMN agent_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN agent_resolutions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN agent_escalations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN agent_timeouts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_stats ADD COLUMN agent_avg_execution_time_ms INTEGER;
ALTER TABLE daily_stats ADD COLUMN deflection_rate REAL;  -- % resolved by agent without human
