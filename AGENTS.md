# Telegram Triage Agent

Cloudflare Worker that ingests Telegram webhook events, classifies messages, generates AI draft responses, escalates to Slack, and creates Linear triage issues.

## Tech Stack

- **Runtime:** Cloudflare Workers, Bun
- **Framework:** Hono with typed `AppEnv` bindings
- **Database:** Cloudflare D1 (SQLite) — hot operational state
- **Storage:** Cloudflare R2 — archived conversation transcripts as JSONL
- **AI:** Vercel AI SDK v6 via `src/lib/ai.ts` — multi-provider routing (Workers AI, NVIDIA NIM, OpenAI)
- **Language:** TypeScript, strict mode

## Architecture

```
Telegram → webhook.ts → rate-limit → ingest.ts pipeline:
  normalize → persist → update state → classify → respond
                                                    ↓
                                          draft → policy eval
                                          ↓         ↓         ↓
                                     auto_send  escalate  draft_only
                                                    ↓
                                              Slack webhook
                                          ↓ (if bug/request)
                                          Linear triage issue

Scheduled (every 5 minutes):
  processTimers → classify + respond for fired timers
  archiveOldMessages → R2 JSONL + prune D1
```

## Project Structure

```
src/
  index.ts              — Hono app export + scheduled handler (timers + archival)
  routes/
    webhook.ts          — POST /webhook/telegram — verify, rate-limit, ingest via waitUntil
    health.ts           — GET /health
  pipeline/
    ingest.ts           — Full pipeline: normalize → persist → state → classify → respond
    respond.ts          — Draft generation → policy → auto_send/escalate/draft_only + Linear
    timer.ts            — Process fired timers via scheduled cron
  lib/
    ai.ts               — AI provider routing — TASK_MODELS maps tasks to providers/models
    archiver.ts         — Archive overflow messages to R2, prune from D1
    classifier.ts       — Rule-first classification + AI SDK model fallback
    config.ts           — App config + evaluateResponsePolicy()
    drafter.ts          — AI draft generation + Telegram send + draft persistence
    escalation.ts       — Slack webhook escalation + escalation persistence
    linear.ts           — Linear GraphQL API — triage issue creation + D1 link persistence
    logger.ts           — Structured JSON logger (debug/info/warn/error)
    metrics.ts          — Pipeline timing + model usage structured logging
    normalizer.ts       — TelegramUpdate → InternalEvent
    persistence.ts      — D1 upsert for chats, participants, messages, classifications
    rate-limiter.ts     — Per-chat rate limiting via active_messages COUNT
    state.ts            — Conversation state + timer management
    summary.ts          — Chat summary generation (plain-text, AI placeholder)
    telegram.ts         — Webhook secret verification
  types/
    classification.ts   — ClassificationLabel, ClassificationResult
    draft.ts            — ResponseAction, Draft, DraftStatus, PolicyDecision
    env.ts              — Env (bindings) + AppEnv (Hono generic)
    escalation.ts       — EscalationStatus, Escalation
    events.ts           — InternalEvent, MessageEventType
    telegram.ts         — Telegram Bot API subset types
migrations/
  0001_initial_schema.sql — Core tables (chats, messages, classifications, drafts, etc.)
  0002_chat_approval.sql — Approval system, pending_approvals, daily_stats, app_config
  0003_schema_corrections.sql — Missing username/reasoning columns (fixes 0002 bug)
```

## Key Config (src/lib/config.ts)

| Setting | Value | Purpose |
|---------|-------|---------|
| `noResponseDelaySeconds` | 30 | Timer delay before auto-draft |
| `escalationThreshold` | 0.4 | Below this → escalate to Slack |
| `autoSendThreshold` | 0.85 | Above this → auto-send if label in autoSendLabels |
| `maxHotMessages` | 200 | Per-chat message limit before R2 archival |
| `summaryMaxAgeMinutes` | 30 | Summary cache TTL |
| `autoSendLabels` | `["normal"]` | Only "normal" messages auto-send |

## Response Policy

- **auto_send (normal):** classification confidence ≥ 0.85 AND label in `autoSendLabels` (e.g., "normal")
- **auto_send (bug/request):** classification confidence > 0.8 AND response confidence > 0.875 — bug and feature request classifications can now auto-send if both thresholds are met
- **escalate:** classification confidence < 0.4 OR label is "unknown"
- **draft_only:** everything in between

Dual-confidence thresholds for sensitive classifications (bug, feature_request):
- Classification confidence must be > 0.8 (high certainty of issue type)
- Response confidence must be > 0.875 (very high certainty of response quality)
- Both must be satisfied for auto-send; otherwise escalates to human review

## AI Provider Routing (src/lib/ai.ts)

The `TASK_MODELS` map assigns each AI task to a provider + model. To switch providers:

```ts
const TASK_MODELS: Record<AITask, ModelConfig> = {
  classify: { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
  draft:    { provider: "nvidia",     model: "meta/llama-3.3-70b-instruct" },
  summarize:{ provider: "openai",     model: "gpt-4o-mini" },
};
```

Available providers: `workers-ai` (env.AI binding), `nvidia` (NIM API), `openai`.

## Environment Variables

Required (set in .dev.vars locally, wrangler secrets in prod):
- `TELEGRAM_BOT_TOKEN` — Telegram Bot API token
- `TELEGRAM_WEBHOOK_SECRET` — Webhook verification secret
- `SLACK_WEBHOOK_URL` — Slack incoming webhook

Linear Integration (set via `wrangler secret put`):
- `LINEAR_API_KEY` — Linear personal API key (Settings → API)
- `LINEAR_TEAM_ID` — Team UUID where issues are created
- `LINEAR_TRIAGE_STATE_ID` — Workflow state UUID for triage/backlog
- `LINEAR_PROJECT_ID` — (Optional) **Leave unset** to avoid GitHub sync. If set, issues are assigned to this Linear project; if that project has GitHub sync enabled, triage issues will appear as public GitHub issues.
- `LINEAR_LABEL_BUG` — (Optional) Label UUID for bug classifications
- `LINEAR_LABEL_REQUEST` — (Optional) Label UUID for feature request classifications

Get Linear IDs via GraphQL:
```bash
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: YOUR_LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "query { teams { nodes { id name } } }"}'
```

Optional (enable alternate AI providers):
- `NVIDIA_API_KEY` — NVIDIA NIM API key (free credits at build.nvidia.com)
- `OPENAI_API_KEY` — OpenAI API key

Bindings (wrangler.jsonc):
- `DB` — D1Database
- `AI` — Workers AI binding
- `ARCHIVE` — R2Bucket

## D1 Tables

Core tables: `chats`, `chat_participants`, `active_messages`, `conversation_state`, `summaries`, `classifications`, `drafts`, `escalations`, `linear_links`, `archives`, `timers`

Approval system: `pending_approvals`, `chat_membership_history`, `daily_stats`, `app_config`

MCP Registry: `mcp_servers`, `tool_executions`

All schemas in `migrations/` — check numbered files for full definitions.

## Conventions

- **Queries:** Always parameterized D1 prepared statements. Never string-concat SQL.
- **Idempotency:** `ON CONFLICT` clauses on all upserts.
- **Logging:** Use `logger` from `src/lib/logger.ts`. Always structured JSON.
- **Error handling:** try/catch each pipeline stage independently. Log and continue.
- **Types:** Defined in `src/types/`. Never inline complex types.
- **Secrets:** `.dev.vars` locally, `wrangler secret put` in prod. Never hardcode.
- **Async work:** Use `ctx.waitUntil()` / `c.executionCtx.waitUntil()` for non-blocking pipeline processing.
- **Webhook:** Always return 200 to Telegram immediately. Process async.
- **AI calls:** Always go through `src/lib/ai.ts` — never call `env.AI.run()` directly.
- **File editing:** Never use sed/awk. Use the Edit tool. Read files before editing.
- **Database schema changes:** See **Database Schema Change Protocol** below — mandatory validation steps.

## Database Schema Change Protocol

**CRITICAL:** Schema mismatches between code and D1 cause runtime failures. Follow this protocol for ANY migration:

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

### Testing

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
-- 1. Add column
ALTER TABLE chats ADD COLUMN user_preferences TEXT;
-- 2. Create index if queried by this column
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

### MCP Tables (Runtime Config)

The `mcp_servers` and `tool_executions` tables are **runtime configuration** — no migration needed to add new MCPs. Simply insert rows via SQL:

```sql
-- Add a new MCP server
INSERT INTO mcp_servers (project_id, name, transport, connection_config, auth_config, enabled)
VALUES ('default', 'my-api', 'http', '{"baseUrl":"https://api.example.com"}', NULL, 1);

-- Add tools for the server
INSERT INTO mcp_tools (server_id, name, description, parameters_schema, enabled)
VALUES (last_insert_rowid(), 'search', 'Search the API', '{"type":"object","properties":{"q":{"type":"string"}}}', 1);
```

MCP servers are loaded dynamically at runtime from D1. No code changes or deployments required.

## MCP Registry System

Dynamic MCP (Model Context Protocol) server registry for tool execution. D1-backed configuration with R2-cached results.

### Architecture Overview

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   D1 (Config)   │────▶│  MCP Loader  │────▶│  Tool Executor  │
│  mcp_servers    │     │              │     │                 │
│  mcp_tools      │     │ Loads server │     │ HTTP/SSE calls  │
└─────────────────┘     │ + tool defs  │     │ with retry      │
                        └──────────────┘     └─────────────────┘
                                                       │
                                                       ▼
                                               ┌──────────────┐
                                               │  R2 (Cache)  │
                                               │ SHA-256 key  │
                                               │ 24h TTL      │
                                               └──────────────┘
```

**Key Design Decisions:**
- **D1 for config**: Servers and tools stored as rows; enables runtime registration without code changes
- **Per-project isolation**: `project_id` column allows multi-tenant deployments
- **R2 for results**: Tool execution results cached with hashed keys (SHA-256 of tool+params) to avoid re-execution
- **HTTP transport**: Primary transport; SSE support planned

### Adding MCPs via SQL

No migration required — insert directly into D1:

```sql
-- 1. Register an MCP server
INSERT INTO mcp_servers (
  project_id,           -- 'default' or your project slug
  name,                 -- unique server identifier
  transport,            -- 'http' (only supported currently)
  connection_config,    -- JSON: { baseUrl, timeoutMs, headers }
  auth_config,          -- JSON: { type: 'bearer', token: '...' } or null
  enabled               -- 1 = active, 0 = disabled
) VALUES (
  'default',
  'stripe-api',
  'http',
  '{"baseUrl":"https://api.stripe.com/v1","timeoutMs":30000}',
  '{"type":"bearer","token_env":"STRIPE_SECRET_KEY"}',
  1
);

-- 2. Register tools for the server
INSERT INTO mcp_tools (server_id, name, description, parameters_schema, enabled)
SELECT 
  id,
  'get_customer',
  'Retrieve a Stripe customer by ID',
  '{"type":"object","required":["customer_id"],"properties":{"customer_id":{"type":"string"}}}',
  1
FROM mcp_servers WHERE name = 'stripe-api';
```

**Connection Config Schema:**
```json
{
  "baseUrl": "https://api.example.com",
  "timeoutMs": 30000,
  "headers": { "X-Custom-Header": "value" }
}
```

**Auth Config Schema:**
```json
// Bearer token from env var
{"type": "bearer", "token_env": "API_TOKEN"}

// Static header
{"type": "header", "header_name": "X-API-Key", "value_env": "API_KEY"}
```

### Per-Project Isolation

All MCP tables have `project_id` (default: `'default'`). This enables:
- Multi-tenant deployments (one Worker, many projects)
- Staging vs production separation
- Customer-specific MCP configurations

Query pattern always includes `project_id`:
```typescript
await db.prepare(
  `SELECT * FROM mcp_servers WHERE project_id = ? AND enabled = 1`
).bind(projectId);
```

### Tool Execution Flow

```
1. Classifier detects tool need (e.g., "check customer status")
          │
          ▼
2. Drafter calls MCPRegistry.executeTool(projectId, toolName, params)
          │
          ▼
3. Registry loads server config from D1 (cached in-memory per-request)
          │
          ▼
4. Check R2 cache: SHA256(toolName + canonicalJSON(params))
   ├─ Cache hit → return cached result
   └─ Cache miss → execute HTTP call
          │
          ▼
5. Execute: HTTP POST with retry logic (3 attempts, exponential backoff)
          │
          ▼
6. Persist result to R2 (24h TTL) + log to tool_executions table
          │
          ▼
7. Return result to drafter for inclusion in AI response
```

**Error Handling:**
- Network errors: 3 retries with exponential backoff (100ms, 200ms, 400ms)
- HTTP 4xx/5xx: Logged but not retried (4xx = client error, 5xx = may retry on idempotent)
- Timeouts: `timeoutMs` from connection_config (default 30s)
- All attempts logged to `tool_executions` with `status: 'error'` and error message

### Caching Strategy

**Cache Key Generation:**
```typescript
const cacheKey = `tool:${crypto.subtle.digest('SHA-256', 
  new TextEncoder().encode(`${toolName}:${JSON.stringify(params)}`)
)}`;
```

**Cache Layers:**
1. **R2 (persistent)**: 24h TTL, survives Worker restarts
2. **In-memory (ephemeral)**: Per-request only, no cross-request caching

**Cache Invalidation:**
- Automatic: R2 objects expire after 24h
- Manual: Delete R2 object by key prefix `tool:`
- Tool-specific: Add `cache_ttl_seconds` to mcp_tools row (future enhancement)

**Cache Bypass:**
Add `_skip_cache: true` to params (not yet implemented — planned for v2).

### Tool Execution Logging

Every execution recorded in `tool_executions`:

| Column | Purpose |
|--------|---------|
| `tool_id` | Foreign key to mcp_tools |
| `chat_id` | Context for the execution |
| `parameters` | JSON params (for audit/debug) |
| `result` | JSON result or error payload |
| `status` | 'success', 'error', 'timeout' |
| `execution_time_ms` | Performance metric |
| `cached` | 1 if R2 cache hit |

Query recent executions:
```sql
SELECT t.name, e.status, e.execution_time_ms, e.created_at
FROM tool_executions e
JOIN mcp_tools t ON e.tool_id = t.id
WHERE e.created_at > datetime('now', '-1 hour')
ORDER BY e.created_at DESC;
```

## Commands

```bash
bun run dev              # Local development
bun run deploy           # Deploy to Cloudflare
bun run db:migrate:local # Apply D1 migrations locally
bun run db:migrate:remote # Apply D1 migrations to production
npx tsc --noEmit         # Type check
```
