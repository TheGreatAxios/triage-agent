# Pipeline — Message Processing Pipeline

The pipeline processes messages from ingestion to response. All stages are source-agnostic — they operate on `InternalEvent`.

## Files

- `ingest.ts` — Full pipeline: normalize → persist → state → classify → respond
- `respond.ts` — Safety eval → draft persistence → auto_send/escalate/draft_only + Linear + Notion
- `triage.ts` — Build context → LLM triage → persist classification → handle result
- `timer.ts` — Process fired timers via scheduled cron + stale alerts + daily summaries

## Pipeline Flow

```
Message received → normalize → persist → approval gate → team check → update state → triage
                                                                                          ↓
                                                                            draft → safety eval → policy
                                                                            ↓         ↓         ↓
                                                                       auto_send  escalate  draft_only
                                                                            ↓
                                                                     Slack + Linear + Notion
```

## Design Decisions

### Inline Triage (Not Timer-Based)

Workers AI calls complete in 1–3s, well within the 30s `waitUntil` limit. Triage runs inline in `ingestUpdate()` instead of scheduling a timer and waiting. Timers are only used for the legacy `no_response` path.

### Approval Gate

Messages from unapproved chats are silently dropped in `ingest.ts`. The chat must have `approval_status = 'approved'` in the `chats` table. This prevents the bot from processing messages in random groups it was added to without admin approval.

### Team Member Short-Circuit

If the sender is a detected team member (via `team_members` table), the pipeline:
1. Records the team touch (for metrics)
2. Cancels any pending timers
3. Returns immediately — **no AI triage, no draft, no escalation**

This prevents the bot from responding to its own team's messages.

### Response Policy (Inline in `respond.ts`)

The `evaluateSafety()` function enforces code-level thresholds AFTER the LLM decides. The LLM can suggest but the code enforces:

| Check | Threshold | Override Action |
|-------|-----------|-----------------|
| No draft content | N/A | Skip |
| Content safety blocked | Score > 0.5 | Escalate |
| Classification confidence | < 0.4 | Escalate |
| Draft confidence | < 0.6 | Escalate |
| Sensitive label (bug/request) draft confidence | < 0.8 | Escalate |

**Effective actions:** The LLM's action can be overridden by safety evaluation. For example, the LLM says `auto_send` but if draft confidence < 0.6, the code changes it to `escalate`.

### Escalate Path

When action is `escalate`:
1. Persist draft with status `escalated`
2. Send draft to Telegram user (if safety passed) — user gets immediate response
3. Send Slack escalation with full context — human reviews
4. If label is `bug` or `request`: create Linear issue + push to Notion

### Idempotency Points

| Stage | Mechanism | Location |
|-------|-----------|----------|
| Webhook delivery | `ON CONFLICT DO NOTHING` on `(chat_id, telegram_message_id)` | `persistence.ts` |
| Pipeline re-entry | Check `active_messages` for existing message before processing | `ingest.ts` |
| Draft persist | Always inserts (allows multiple drafts per chat) | `drafter.ts` |
| Slack escalation | Skip if escalation exists within 5 min for same chat | `escalation.ts` |
| Timer processing | `processed_timers` table + `isTimerProcessed()` | `team.ts` |
| Daily summary | `daily_summary_sent` table + `checkDuplicateSummary()` | `team.ts` |
| Stale alerts | `stale_alert_sent` table + `NOT EXISTS` filter | `team.ts` |

### Error Escalation

When triage fails (all AI tiers exhausted, DB error, etc.):
1. `sendErrorAlert()` sends a formatted error to Slack with stack trace
2. Error is re-thrown to propagate to the top-level `waitUntil` handler
3. Message is still persisted in D1 — no data loss

## File-Specific Notes

### `ingest.ts`

**Idempotency check:** Before persisting, queries `active_messages` joined with `chats` to check if the exact `(telegram_message_id, telegram_chat_id)` pair already exists. This prevents duplicate processing from Telegram webhook redeliveries.

**AI binding guard:** If `env.AI` is not available, logs error and escalates to Slack. Messages are persisted but not triaged.

### `triage.ts`

**Context building:** Fetches up to 10 recent messages with sender names, plus the latest summary if not stale. Context is built via `buildMessageContext()` which includes relative timestamps.

**Error handling:** All 3 AI tiers must fail before the error is thrown. Each tier failure is logged with provider/model details.

### `respond.ts`

**Dual Notion push:** Both triage items and summaries are pushed to Notion in parallel. The triage push is awaited; the summary push is fire-and-forget.

**Linear + Notion gating:** Only runs for `bug` and `request` labels. Linear uses a 15s timeout.

### `timer.ts`

**Timer processing:** Fires every 5 minutes via scheduled handler. For each fired timer:
1. Look up latest classification for the chat
2. Run `handleTriageResult` (always escalates for timer path)
3. Mark timer as fired + record in `processed_timers`

**Stale chat alerts:** After timer processing, checks for chats with no team response in 4+ hours. Idempotency via `stale_alert_sent` table.

**Daily summaries:** Sent at 16:00 UTC (morning) and 00:00 UTC (evening). Two parallel paths:
1. `sendDailySummaryWebhook()` — team KPI summary via webhook
2. `sendDailySummaryIfScheduled()` — approval stats via Bot API

## Debugging

### Quick Diagnostic

```bash
# Check live logs
bunx wrangler tail --search "error"

# Check pipeline metrics
bunx wrangler d1 execute triage-agent-db --remote --command "
  SELECT stage, COUNT(*), AVG(durationMs), MAX(durationMs)
  FROM (SELECT json_extract(source, '$.stage') as stage, json_extract(source, '$.durationMs') as durationMs
        FROM logs WHERE source LIKE '%pipeline_metric%')
  GROUP BY stage"

# Check triage decisions
bunx wrangler d1 execute triage-agent-db --remote --command "
  SELECT label, action, overall_decision, COUNT(*)
  FROM triage_decisions
  WHERE created_at > datetime('now', '-24 hours')
  GROUP BY label, action, overall_decision"
```

### Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `DatabaseError: Failed to persist draft` | Missing drafts columns | Apply migration 0011 |
| `No available model for task: triage` | All AI tiers failed | Check `env.AI` binding + `OPENROUTER_API_KEY` |
| Draft not sent to user | Safety threshold blocked | Check `triage_decisions` for `blocked_by_threshold` |
| Duplicate Slack escalations | Idempotency window too short | 5-min window in `escalateToSlack` — increase if needed |
| Timer not firing | `processed_timers` stale data | Old records auto-cleaned after 24h |

## See Also

- `src/lib/AGENTS.md` — Library module details
- `src/lib/config.ts` — Config values
- `src/lib/classifier.ts` — LLM triage implementation
- `src/lib/drafter.ts` — Draft persistence
- `src/lib/safety.ts` — Safety evaluation
- `src/lib/metrics.ts` — Pipeline timing
