-- Notion integration tables (single-DB, child-block model)

-- Audit trail of Notion block appends
CREATE TABLE IF NOT EXISTS notion_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  notion_page_id TEXT NOT NULL,
  notion_page_url TEXT NOT NULL,
  page_type TEXT NOT NULL DEFAULT 'block_triage',  -- 'block_triage' | 'block_summary' | 'project'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (chat_id) REFERENCES chats(id)
);

CREATE INDEX IF NOT EXISTS idx_notion_links_chat ON notion_links(chat_id);
CREATE INDEX IF NOT EXISTS idx_notion_links_page ON notion_links(notion_page_id);

-- Chat → Project page mapping (caches the confirmed mapping for auto-append)
CREATE TABLE IF NOT EXISTS notion_project_map (
  chat_id INTEGER NOT NULL PRIMARY KEY,
  notion_page_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (chat_id) REFERENCES chats(id)
);
