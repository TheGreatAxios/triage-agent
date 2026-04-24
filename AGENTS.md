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

- **auto_send:** confidence ≥ 0.85 AND label in `autoSendLabels`
- **escalate:** confidence < 0.4 OR label is "unknown"
- **draft_only:** everything in between

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

## Commands

```bash
bun run dev              # Local development
bun run deploy           # Deploy to Cloudflare
bun run db:migrate:local # Apply D1 migrations locally
bun run db:migrate:remote # Apply D1 migrations to production
npx tsc --noEmit         # Type check
```
