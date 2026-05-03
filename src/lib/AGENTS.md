# lib — Core Library Modules

## Files

| File | Purpose |
|------|---------|
| `ai.ts` | AI provider routing — multi-tier fallback per task |
| `archiver.ts` | Archive overflow messages to R2, prune from D1 |
| `classifier.ts` | Single-call triage via `generateObject` + Zod schema |
| `config.ts` | App config (delays, thresholds, limits) |
| `counters.ts` | Counter management (re-exports from `counters/`) |
| `drafter.ts` | Draft persistence + Telegram send + draft lifecycle |
| `errors.ts` | Typed error hierarchy (`DatabaseError`, `AIError`, `APIError`, etc.) |
| `escalation.ts` | Slack webhook escalation + escalation persistence |
| `linear.ts` | Linear GraphQL API — triage issue creation + D1 link persistence |
| `logger.ts` | Structured JSON logger (debug/info/warn/error) |
| `metrics.ts` | Pipeline timing + model usage structured logging |
| `mcp/` | MCP server registry, tool executor, R2 caching |
| `normalizer.ts` | TelegramUpdate → InternalEvent |
| `notion.ts` | Notion project matching, child-block append model |
| `persistence.ts` | D1 upsert for chats, participants, messages + approval queries |
| `queries.ts` | Centralized message retrieval with sender info |
| `rate-limiter.ts` | Per-chat rate limiting via active_messages COUNT |
| `safety.ts` | Output content moderation + triage audit trail |
| `sanitize.ts` | Prompt injection prevention for AI inputs |
| `slack.ts` | Slack Bot API helpers (signature verify, modals, summaries, stale alerts) |
| `slack-blocks.ts` | Slack Block Kit builders for approval flows |
| `state.ts` | Conversation state + timer management |
| `summary.ts` | Chat summary generation (plain-text concatenation, AI placeholder) |
| `team.ts` | Team member detection, response metrics, stale chat alerts, idempotency |
| `telegram-api.ts` | Telegram Bot API helpers (getMe, sendMessage, leaveChat, etc.) |
| `telegram.ts` | Webhook secret verification |
| `timeout.ts` | `withTimeout` + `fireAndForget` utilities |
| `approval.ts` | Chat approval flow with adaptive complexity scoring |

## Subdirectories

- `counters/` — Counter reconciliation and rollup
- `mcp/` — MCP registry, executor (see below)

---

## Design Decisions

### AI Provider Routing (`ai.ts`)

**Multi-tier fallback per task.** Each `AITask` has 3 model tiers. `resolveModel()` is called per-tier so failed tiers actually advance the model — no global state mutation.

```
Tier 1: Workers AI (Llama 3.1 8B) — fast, free, built-in
Tier 2: Workers AI (Mistral 7B) — fallback within same provider
Tier 3: OpenRouter (free model) — cross-provider fallback
```

**Adding providers:** Add to `AIProvider` type union, add case to `resolveModel()`, add API key to `src/types/env.ts`.

**Switching models:** Edit `TASK_MODELS` in `ai.ts`. No code changes elsewhere.

**`getTracedModel()` vs `getModel()`:** Currently identical — PostHog telemetry was removed but the function signature remains for future re-addition.

### Config (`config.ts`)

| Setting | Default | Purpose |
|---------|---------|---------|
| `noResponseDelaySeconds` | 60 | Timer delay before auto-draft |
| `maxHotMessages` | 50 | Per-chat message limit before R2 archival |
| `summaryMaxAgeMinutes` | 5 | Summary cache TTL |

**Note:** `config.ts` no longer contains `evaluateResponsePolicy()` or threshold constants. Response policy is now enforced inline in `respond.ts` via `evaluateSafety()`.

### Draft Persistence (`drafter.ts`)

**Schema dependency:** `persistDraft()` inserts 11 columns into `drafts`. The 7 non-original columns (`response_confidence`, `tools_used`, `tool_results`, `classification_label`, `classification_confidence`, `reasoning`, `method`) are added by migration 0011. **If this migration hasn't been applied, every triage will fail with `DatabaseError: Failed to persist draft`.**

**Draft lifecycle:**
```
pending → sent (via markDraftSent)
pending → escalated (when action is "escalate")
```

**ID retrieval pattern:** INSERT then SELECT by `chat_id + ORDER BY created_at DESC`. This avoids needing `RETURNING` which D1 doesn't fully support.

### Escalation (`escalation.ts`)

**Idempotency:** `escalateToSlack()` skips if an escalation for the same chat exists within the last 5 minutes. This prevents duplicate Slack messages during webhook redeliveries.

**Dual `getTelegramChatId`:** Both `escalation.ts` and `persistence.ts` export `getTelegramChatId()`. They do the same thing — query `chats.telegram_chat_id` by internal ID. This is a known duplication but harmless.

### Team Detection (`team.ts`)

**First response time calculation:** `recordTeamTouch()` uses a two-step approach — first reads `first_customer_message_at` from `chat_metrics`, calculates the response time in JS, then upserts with the pre-calculated value. This is necessary because SQLite/D1 doesn't allow referencing existing row values within `VALUES()` or binding them as params.

**Stale alert idempotency:** Responsibility is split:
1. `getStaleChats()` — SQL `NOT EXISTS` filter excludes already-alerted chats
2. `recordStaleAlert()` in `timer.ts` — inserts idempotency row
3. `sendStaleAlert()` in `slack.ts` — sends webhook only, does NOT write to DB

**Daily summary idempotency:** Similarly split:
1. `checkDuplicateSummary()` — queries `daily_summary_sent`
2. `sendDailySummaryWebhook()` — sends webhook only, does NOT write to DB
3. `recordSummarySent()` — inserts idempotency row

### Safety (`safety.ts`)

**Two separate tables:**
- `content_safety_log` — Per-draft moderation results (flagged categories, scores)
- `triage_decisions` — Full audit trail of every triage outcome

Both are fire-and-forget — failures are logged but don't block the pipeline.

### Counters (`counters.ts`, `counters/`)

**Why counters exist:** At scale, `COUNT(*)` and `GROUP BY` queries become expensive. The counter module maintains running totals (`chat_message_counts`, `daily_stats_optimized`) so reads are O(1).

**Counter drift:** Counters can drift due to failed transactions or race conditions. The weekly reconciliation job (`reconcileCounters`) verifies and fixes drift.

### MCP Registry (`mcp/`)

**Architecture:**
```
D1 (mcp_servers) → loadMCPServers() → executeTools() → R2 (KNOWLEDGE_CACHE)
```

**Adding MCPs:** Insert directly into D1 via SQL. No migration required. Use `addMCPServer()` helper or raw SQL.

**Quality assessment:** Tool results are graded high/medium/low/none based on length and error content. Low-quality results are included but flagged.

### Notion Integration (`notion.ts`)

**Single-database model:** One Notion DB (`NOTION_PROJECTS_DB_ID`) with one page per Telegram chat. Triage items and summaries are appended as child blocks.

**Project matching flow:**
1. Check D1 cache (`notion_project_map`) → auto-append if cached
2. Search Notion DB → return `NotionProjectSuggestion` for Slack confirmation
3. On confirm/create → cache mapping + append blocks

---

## Common Pitfalls

| Pitfall | Where | Why |
|---------|-------|-----|
| Missing migration columns | `drafter.ts` | `persistDraft` inserts columns that must exist in D1 |
| `first_response_seconds` always NULL | `team.ts` | Must pre-read `first_customer_message_at` before upsert |
| Double idempotency writes | `slack.ts` + `timer.ts` | Each module must only handle its part (query vs write vs send) |
| `KNOWLEDGE_CACHE` optional chaining | `mcp/executor.ts` | R2 binding is required in Env type but used with `?.` |
| Non-parameterized SQL | Any file | Always use `.prepare().bind()` — never string-concat SQL |

## See Also

- `src/pipeline/AGENTS.md` — Pipeline flow and response policy
- `src/routes/AGENTS.md` — Webhook setup & troubleshooting
- `src/types/AGENTS.md` — Type system guide
- `migrations/AGENTS.md` — Schema change protocol
