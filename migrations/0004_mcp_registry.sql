-- Migration 0004: MCP Registry tables
-- Dynamic MCP server configuration and tool execution logging

-- MCP Servers configuration table
CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  config TEXT NOT NULL, -- JSON: { type, url, timeout, tools, authEnvVar, retryAttempts }
  for_labels TEXT, -- JSON array of classification labels this MCP applies to
  for_classification_confidence_above REAL NOT NULL DEFAULT 0.0,
  priority INTEGER NOT NULL DEFAULT 50,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, name)
);

-- Tool execution logs for observability and debugging
CREATE TABLE IF NOT EXISTS tool_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL DEFAULT 0,
  mcp_server_id INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  query TEXT NOT NULL, -- Truncated query (max 500 chars)
  result TEXT, -- JSON result or null on failure (truncated to 10000 chars)
  execution_time_ms INTEGER NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mcp_server_id) REFERENCES mcp_servers(id)
);

-- Indexes for MCP queries
CREATE INDEX IF NOT EXISTS idx_mcp_servers_project ON mcp_servers(project_id);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);
CREATE INDEX IF NOT EXISTS idx_tool_executions_server ON tool_executions(mcp_server_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_created ON tool_executions(created_at);
CREATE INDEX IF NOT EXISTS idx_tool_executions_chat ON tool_executions(chat_id);
