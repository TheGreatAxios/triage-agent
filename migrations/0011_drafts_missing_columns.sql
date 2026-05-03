-- Migration 0011: Add missing drafts columns
--
-- Columns that already exist (from partial run): response_confidence, tools_used, tool_results
-- Columns still missing: classification_label, classification_confidence, reasoning, method, content_filtered

ALTER TABLE drafts ADD COLUMN classification_label TEXT;
ALTER TABLE drafts ADD COLUMN classification_confidence REAL;
ALTER TABLE drafts ADD COLUMN reasoning TEXT;
ALTER TABLE drafts ADD COLUMN method TEXT NOT NULL DEFAULT 'model';
ALTER TABLE drafts ADD COLUMN content_filtered INTEGER NOT NULL DEFAULT 0;
