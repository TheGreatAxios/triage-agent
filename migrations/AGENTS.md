# migrations — Database Schema Management

**CRITICAL:** Schema mismatches between code and D1 cause runtime failures. Follow this protocol for ANY migration.

## Current Migrations

| File | Purpose |
|------|---------|
| `0001_initial_schema.sql` | Core tables (chats, messages, classifications, drafts, etc.) |
| `0002_chat_approval.sql` | Approval system, pending_approvals, daily_stats, app_config |
| `0003_schema_corrections.sql` | Missing username/reasoning columns (fixes 0002 bug) |
| `0004_mcp_registry.sql` | MCP server/tool registry tables |
| `0005_covering_indexes.sql` | Covering indexes for hot queries |
| `0005_team_and_metrics.sql` | Team member tracking, stale chats, daily summaries, chat_metrics |
| `0006_counter_optimization.sql` | Counter tables for D1 row optimization |
| `0007_agent_resolution_tracking.sql` | Agent tracking (tables/columns now dropped by 0008) |
| `0008_drop_agent_schema.sql` | Drops all unused agent tables and columns from 0007 |
| `0009_notion_links.sql` | Notion page link tracking + project mapping cache |
| `0010_triage_audit_and_safety.sql` | Content safety log + triage decisions audit table |
| `0011_drafts_missing_columns.sql` | Adds missing drafts columns that 0010 assumed existed |

## Tables

**Core:** `chats`, `chat_participants`, `active_messages`, `conversation_state`, `summaries`, `classifications`, `drafts`, `escalations`, `linear_links`, `archives`, `timers`

**Approval system:** `pending_approvals`, `chat_membership_history`, `daily_stats`, `app_config`

**MCP Registry:** `mcp_servers`, `mcp_tools`, `tool_executions`

**Counter optimization:** `chat_message_counts`, `daily_stats_optimized`, `monthly_stats`, `counter_reconciliation_log`

**Team & Metrics:** `team_members`, `chat_metrics`, `team_member_metrics`, `stale_alert_sent`, `daily_summary_sent`, `kpi_calculation_completed`, `processed_timers`

**Safety & Audit:** `content_safety_log`, `triage_decisions`

**Notion:** `notion_links`, `notion_project_map`

**Dropped (0008):** `agent_archives`, `agent_debounces`, `agent_decisions`, `agent_follow_ups`, `agent_human_transitions`, `solution_confidence_snapshots`

## Known Schema Pitfalls

### Migration 0010 Comment Bug (Fixed by 0011)

Migration 0010 has a comment saying the drafts columns "were already applied to the remote DB by earlier schema drift." They weren't. The `ALTER TABLE ADD COLUMN` statements were missing entirely. Migration 0011 adds them:

```sql
ALTER TABLE drafts ADD COLUMN response_confidence REAL;
ALTER TABLE drafts ADD COLUMN tools_used TEXT;
ALTER TABLE drafts ADD COLUMN tool_results TEXT;
ALTER TABLE drafts ADD COLUMN classification_label TEXT;
ALTER TABLE drafts ADD COLUMN classification_confidence REAL;
ALTER TABLE drafts ADD COLUMN reasoning TEXT;
ALTER TABLE drafts ADD COLUMN method TEXT NOT NULL DEFAULT 'model';
ALTER TABLE drafts ADD COLUMN content_filtered INTEGER NOT NULL DEFAULT 0;
```

**Without 0011 applied:** Every triage call fails with `DatabaseError: Failed to persist draft`.

### Duplicate Migration Numbers

Both `0005_covering_indexes.sql` and `0005_team_and_metrics.sql` share the same migration number. This works because D1 applies migrations in filename order within the same number. **Do NOT add more 0005 migrations.**

### Dropped Tables Still in Schema

Migration 0007 created agent tables that migration 0008 dropped. If you see references to `agent_*` tables in code or docs, they're stale.

## Schema Change Protocol

### Before Creating Migration

1. **Full SQL Audit** — Search ALL files for queries using affected table(s):
   ```bash
   grep -n "INSERT\|UPDATE\|SELECT" src/lib/*.ts src/pipeline/*.ts
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
   - [ ] **Never assume columns exist — include ALTER TABLE statements**

6. **No phantom columns** — If a migration needs columns, ADD them. Never comment "already applied" without verifying.

### Testing & Deployment

7. **Local validation** — Apply and test before commit:
   ```bash
   bun run db:migrate:local
   bun run dev  # Verify zero SQL errors
   ```

8. **Production deployment** — Migrations run BEFORE code deploy:
   ```bash
   bun run db:migrate:remote  # Apply schema first
   bun run deploy            # Then deploy code
   ```

### Example: Adding a Column

```sql
-- migrations/0012_add_foo.sql
ALTER TABLE drafts ADD COLUMN foo TEXT;
CREATE INDEX idx_drafts_foo ON drafts(foo) WHERE foo IS NOT NULL;
```

Then update code:
```typescript
// drafter.ts - add to INSERT and SELECT
```

## Commands

```bash
bun run db:migrate:local   # Apply migrations locally
bun run db:migrate:remote  # Apply migrations to production
bunx wrangler d1 execute triage-agent-db --local --command "PRAGMA table_info(drafts)"
bunx wrangler d1 execute triage-agent-db --remote --command "SELECT * FROM chats LIMIT 1"
bunx wrangler d1 export triage-agent-db --remote --output backup.sql
```

## See Also

- `src/types/AGENTS.md` — Type definitions that must stay in sync with schema
- `src/lib/AGENTS.md` — Library modules that query D1
