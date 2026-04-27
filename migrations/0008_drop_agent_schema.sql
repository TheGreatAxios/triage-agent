-- Migration 0008: Drop unused agent schema
-- The autonomous agent module was removed. All tables/columns from migration 0007
-- are dead — zero code reads or writes them.
--
-- Note: We can't simply delete 0007 because it was already applied to production.
-- This migration reverses it by dropping everything 0007 created.

-- ============================================================================
-- PART 1: Drop agent tables
-- ============================================================================

DROP TABLE IF EXISTS agent_human_transitions;
DROP TABLE IF EXISTS agent_archives;
DROP TABLE IF EXISTS agent_debounces;
DROP TABLE IF EXISTS solution_confidence_snapshots;
DROP TABLE IF EXISTS agent_follow_ups;
DROP TABLE IF EXISTS agent_decisions;

-- ============================================================================
-- PART 2: Drop agent columns from conversation_state
-- ============================================================================

DROP INDEX IF EXISTS idx_conversation_state_agent;
DROP INDEX IF EXISTS idx_conversation_state_resolution;

ALTER TABLE conversation_state DROP COLUMN agent_draft_pending;
ALTER TABLE conversation_state DROP COLUMN last_draft_sent_at;
ALTER TABLE conversation_state DROP COLUMN last_draft_id;
ALTER TABLE conversation_state DROP COLUMN resolution_status;
ALTER TABLE conversation_state DROP COLUMN solution_attempt_count;
ALTER TABLE conversation_state DROP COLUMN thread_confidence_score;

-- ============================================================================
-- PART 3: Drop agent columns from chat_metrics
-- ============================================================================

ALTER TABLE chat_metrics DROP COLUMN agent_resolution_attempts;
ALTER TABLE chat_metrics DROP COLUMN agent_resolutions_successful;
ALTER TABLE chat_metrics DROP COLUMN agent_escalations;
ALTER TABLE chat_metrics DROP COLUMN agent_avg_time_to_ack_seconds;
ALTER TABLE chat_metrics DROP COLUMN agent_avg_time_to_resolution_seconds;
ALTER TABLE chat_metrics DROP COLUMN human_response_after_escalation_seconds;

-- ============================================================================
-- PART 4: Drop agent columns from daily_stats
-- ============================================================================

ALTER TABLE daily_stats DROP COLUMN agent_attempts;
ALTER TABLE daily_stats DROP COLUMN agent_resolutions;
ALTER TABLE daily_stats DROP COLUMN agent_escalations;
ALTER TABLE daily_stats DROP COLUMN agent_timeouts;
ALTER TABLE daily_stats DROP COLUMN agent_avg_execution_time_ms;
ALTER TABLE daily_stats DROP COLUMN deflection_rate;
