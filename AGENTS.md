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

Scheduled (every minute):
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
  0001_initial_schema.sql — All D1 tables
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
- `LINEAR_API_KEY` — Linear API key

Optional (enable alternate AI providers):
- `NVIDIA_API_KEY` — NVIDIA NIM API key (free credits at build.nvidia.com)
- `OPENAI_API_KEY` — OpenAI API key

Bindings (wrangler.jsonc):
- `DB` — D1Database
- `AI` — Workers AI binding
- `ARCHIVE` — R2Bucket

## D1 Tables

`chats`, `chat_participants`, `active_messages`, `conversation_state`, `summaries`, `classifications`, `drafts`, `escalations`, `linear_links`, `archives`, `timers`

All schemas in `migrations/0001_initial_schema.sql`.

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

## Commands

```bash
bun run dev              # Local development
bun run deploy           # Deploy to Cloudflare
bun run db:migrate:local # Apply D1 migrations locally
bun run db:migrate:remote # Apply D1 migrations to production
npx tsc --noEmit         # Type check
```
