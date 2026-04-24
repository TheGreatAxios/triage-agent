-- Migration: Schema Corrections - Missing Columns
-- Created: 2026-04-24
-- Purpose: Add columns that were referenced in code but missing from schema

-- ============================================================================
-- CRITICAL FIX: Add missing username column to chats table
-- ============================================================================
-- The approval flow (handleBotAddedToChat) tries to store chat.username but
-- migration 0002 forgot to add this column. This was causing:
-- "D1_ERROR: no such column: username at offset 42: SQLITE_ERROR"
ALTER TABLE chats ADD COLUMN username TEXT;
CREATE INDEX idx_chats_username ON chats(username) WHERE username IS NOT NULL;

-- ============================================================================
-- AUDIT FIX: Add reasoning column to classifications
-- ============================================================================
-- ClassificationResult type includes 'reasoning' field used in Slack payloads,
-- but it was never persisted to database. This adds audit trail capability.
ALTER TABLE classifications ADD COLUMN reasoning TEXT;
CREATE INDEX idx_classifications_chat_created ON classifications(chat_id, created_at DESC);

-- ============================================================================
-- NOTES ON OTHER COLUMNS (verified, no action needed):
-- ============================================================================
-- - linear_links.message_id: EXISTS in schema (0001), will be populated via code fix
-- - chats.left_at: Intentionally unused (reserved for future bot leave tracking)
-- - pending_approvals.rejection_message_sent: Intentionally unused (reserved)
-- - timers.payload: Intentionally nullable (reserved for future timer types)
-- - escalations.slack_message_ts: Partially used (webhooks don't return ts)
