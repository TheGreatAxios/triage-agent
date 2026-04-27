# migrations — Database Schema Management

**CRITICAL:** Schema mismatches between code and D1 cause runtime failures. Follow this protocol for ANY migration.

## Current Migrations

| File | Purpose |
|------|---------|
| `0001_initial_schema.sql` | Core tables (chats, messages, classifications, drafts, etc.) |
| `0002_chat_approval.sql` | Approval system, pending_approvals, daily_stats, app_config |
| `0003_schema_corrections.sql` | Missing username/reasoning columns (fixes 0002 bug) |

## Tables

**Core:** `chats`, `chat_participants`, `active_messages`, `conversation_state`, `summaries`, `classifications`, `drafts`, `escalations`, `linear_links`, `archives`, `timers`

**Approval system:** `pending_approvals`, `chat_membership_history`, `daily_stats`, `app_config`

**MCP Registry:** `mcp_servers`, `mcp_tools`, `tool_executions`

## Schema Change Protocol

### Before Creating Migration

1. **Full SQL Audit** — Search ALL files for queries using affected table(s):
   ```bash
   grep -n "INSERT\|UPDATE\|SELECT" src/lib/persistence.ts src/lib/state.ts src/lib/*.ts
   ```
   - List every column referenced in code
   - Verify each column exists in current schema

2. **Type Alignment** — Check TypeScript interfaces match D1 schema:
   - `src/types/` interfaces must reflect actual columns
   - Nullable columns in DB must be `| null` in types

3. **Impact Analysis** — Document:
   - New columns: default values, nullability, indexes needed
   - Modified columns: backwards compatibility plan
   - Deleted columns: code cleanup required

### Migration File Requirements

4. **Single migration per release** — Combine related changes in one numbered file

5. **Column verification checklist** — Before commit, verify:
   - [ ] Every column in INSERT/UPDATE statements exists in migration
   - [ ] Every column in SELECT statements exists in migration
   - [ ] Every column in migration is used by at least one query
   - [ ] Indexes created for foreign keys and WHERE clauses

### Testing & Deployment

6. **Local validation** — Apply and test before commit:
   ```bash
   bun run db:migrate:local
   bun run dev  # Verify zero SQL errors
   ```

7. **Production deployment** — Migrations run BEFORE code deploy:
   ```bash
   bun run db:migrate:remote  # Apply schema first
   bun run deploy            # Then deploy code
   ```

### Example: Adding a Column

```sql
-- migrations/0004_add_user_preferences.sql
ALTER TABLE chats ADD COLUMN user_preferences TEXT;
CREATE INDEX idx_chats_preferences ON chats(user_preferences)
  WHERE user_preferences IS NOT NULL;
```

Then update code:
```typescript
// persistence.ts - add to SELECT and INSERT
await db.prepare(
  `INSERT INTO chats (telegram_chat_id, type, title, user_preferences)
   VALUES (?, ?, ?, ?)`
).bind(chatId, type, title, prefs);
```

## MCP Tables (Runtime Config)

The `mcp_servers` and `tool_executions` tables are **runtime configuration** — no migration needed to add new MCPs. Insert rows directly via SQL. See `src/lib/AGENTS.md` for details.

## Commands

```bash
bun run db:migrate:local   # Apply migrations locally
bun run db:migrate:remote  # Apply migrations to production
npx wrangler d1 execute telegram-agent-db --local --command "SELECT * FROM chats LIMIT 1"   # Local query
npx wrangler d1 execute telegram-agent-db --remote --command "SELECT * FROM chats LIMIT 1"  # Remote query
npx wrangler d1 export telegram-agent-db --remote --output backup.sql                        # Export backup
```

## See Also

- `src/types/AGENTS.md` — Type definitions that must stay in sync with schema
- `src/lib/AGENTS.md` — MCP registry system details
