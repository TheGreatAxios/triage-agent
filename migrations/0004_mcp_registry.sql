-- Migration: MCP Registry + Dual-Confidence Response + Schema Corrections
-- Combines: Response confidence tracking, MCP server configuration, schema fixes

-- ============================================================================
-- SCHEMA CORRECTIONS (from separate 0004_schema_corrections_drafts.sql)
-- ============================================================================

-- Add missing response_confidence column to drafts table
-- This was causing: "D1_ERROR: no such column: response_confidence"
ALTER TABLE drafts ADD COLUMN response_confidence REAL;

-- Index for analyzing draft quality vs classification confidence
CREATE INDEX idx_drafts_response_confidence ON drafts(response_confidence) WHERE response_confidence IS NOT NULL;

-- ============================================================================
-- MCP REGISTRY TABLES
-- ============================================================================

-- Additional draft columns for tool tracking
ALTER TABLE drafts ADD COLUMN tools_used TEXT; -- JSON array of tool names
ALTER TABLE drafts ADD COLUMN tool_results TEXT; -- JSON: {tool: string, summary: string}[]

-- MCP servers configuration (per-project, no git commits needed)
CREATE TABLE mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT, -- Human-readable description for codemode/AI understanding
  enabled BOOLEAN DEFAULT true,
  config TEXT NOT NULL, -- JSON: {type, url, authEnvVar, timeout, tools}
  for_labels TEXT, -- JSON: ["bug", "request"] or NULL for all
  for_classification_confidence_above REAL DEFAULT 0.0,
  priority INTEGER DEFAULT 100,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, name)
);

-- Tool execution logs (for debugging/auditing)
CREATE TABLE tool_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  mcp_server_id INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  query TEXT NOT NULL,
  result TEXT, -- JSON result or error
  execution_time_ms INTEGER,
  success BOOLEAN,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_id) REFERENCES chats(id),
  FOREIGN KEY (mcp_server_id) REFERENCES mcp_servers(id)
);

-- Pre-seed built-in MCPs (Parallel and Context7 - both work without API keys)
INSERT INTO mcp_servers (name, config, for_labels, priority) VALUES
('parallel', 
 '{"type": "mcp-http", "url": "https://search.parallel.ai/mcp", "authEnvVar": "PARALLEL_API_KEY", "timeout": 5000, "tools": ["web_search", "web_fetch"], "retryAttempts": 2}',
 '["bug", "request"]',
 10),
('context7', 
 '{"type": "mcp-http", "url": "https://mcp.context7.com/mcp", "authEnvVar": "CONTEXT7_API_KEY", "timeout": 5000, "tools": ["resolve-library-id", "query-docs"], "retryAttempts": 2}',
 '["bug", "request"]',
 20);

-- Indexes for faster lookups
CREATE INDEX idx_mcp_servers_project ON mcp_servers(project_id, enabled);
CREATE INDEX idx_tool_executions_chat ON tool_executions(chat_id, created_at);
