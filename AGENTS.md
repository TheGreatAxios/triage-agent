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
  index.ts              — Hono app export + scheduled handler
  routes/               — Webhook & health endpoints → see src/routes/AGENTS.md
  pipeline/             — Message processing pipeline → see src/pipeline/AGENTS.md
  sources/              — Source adapters (Telegram, future: Discord, Email) → see src/sources/AGENTS.md
  lib/                  — Core library modules (AI routing, config, persistence, MCP) → see src/lib/AGENTS.md
  types/                — TypeScript type definitions → see src/types/AGENTS.md
migrations/             — D1 schema migrations → see migrations/AGENTS.md
```

## Nested AGENTS.md Guides

Each subdirectory has its own `AGENTS.md` with detailed instructions:

| Location | Covers |
|----------|--------|
| `src/routes/AGENTS.md` | Webhook setup, Telegram bot config, troubleshooting, local testing |
| `src/pipeline/AGENTS.md` | Pipeline flow, response policy, dual-confidence, debugging, D1 queries |
| `src/sources/AGENTS.md` | Adding new message sources (Discord, Email, Slack), adapter pattern |
| `src/lib/AGENTS.md` | AI provider routing, config settings, MCP registry system |
| `src/types/AGENTS.md` | Type system guide, InternalEvent, Env bindings, D1 type alignment |
| `migrations/AGENTS.md` | Schema change protocol, migration checklist, deployment order |

## Environment Variables

Required (set in `.dev.vars` locally, `wrangler secret put` in prod):
- `TELEGRAM_BOT_TOKEN` — Telegram Bot API token
- `TELEGRAM_WEBHOOK_SECRET` — Webhook verification secret
- `SLACK_WEBHOOK_URL` — Slack incoming webhook

Linear Integration:
- `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, `LINEAR_TRIAGE_STATE_ID` — Required for Linear triage
- `LINEAR_PROJECT_ID` — (Optional) Leave unset to avoid GitHub sync
- `LINEAR_LABEL_BUG`, `LINEAR_LABEL_REQUEST` — (Optional) Label UUIDs

Optional AI providers:
- `NVIDIA_API_KEY`, `OPENAI_API_KEY`

Bindings (`wrangler.jsonc`):
- `DB` — D1Database, `AI` — Workers AI, `ARCHIVE` — R2Bucket

## Conventions

- **Queries:** Always parameterized D1 prepared statements. Never string-concat SQL.
- **Idempotency:** `ON CONFLICT` clauses on all upserts.
- **Logging:** Use `logger` from `src/lib/logger.ts`. Always structured JSON.
- **Error handling:** try/catch each pipeline stage independently. Log and continue.
- **Types:** Defined in `src/types/`. Never inline complex types.
- **Secrets:** `.dev.vars` locally, `wrangler secret put` in prod. Never hardcode.
- **Async work:** Use `ctx.waitUntil()` for non-blocking pipeline processing.
- **Webhook:** Always return 200 to Telegram immediately. Process async.
- **AI calls:** Always go through `src/lib/ai.ts` — never call `env.AI.run()` directly.
- **File editing:** Never use sed/awk. Use the Edit tool. Read files before editing.
- **Database schema changes:** See `migrations/AGENTS.md` for mandatory validation steps.

## Agent Instructions

### DO NOT Output Reports

**NEVER** create markdown reports, validation documents, or summary files in the project directory.

### Auto-Create Skills Instead

If you develop a reusable pattern, create a skill in `~/.agents/skills/<skill-name>/`:
- `SKILL.md` must be self-contained and actionable
- Include code examples, not just theory
- No project-specific details (keep it generic)

## Commands

```bash
bun run dev              # Local development
bun run deploy           # Deploy to Cloudflare
bun run db:migrate:local # Apply D1 migrations locally
bun run db:migrate:remote # Apply D1 migrations to production
npx tsc --noEmit         # Type check
```
