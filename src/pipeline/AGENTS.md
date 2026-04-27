# Pipeline — Message Processing Pipeline

The pipeline processes messages from ingestion to response. All stages are source-agnostic — they operate on `InternalEvent`.

## Files

- `ingest.ts` — Full pipeline: normalize → persist → state → classify → respond
- `respond.ts` — Draft generation → policy → auto_send/escalate/draft_only + Linear
- `timer.ts` — Process fired timers via scheduled cron

## Pipeline Flow

```
Message received → normalize → persist → update state → classify → respond
                                                                      ↓
                                                            draft → policy eval
                                                            ↓         ↓         ↓
                                                       auto_send  escalate  draft_only
                                                            ↓
                                                      Slack webhook
                                                  ↓ (if bug/request)
                                                  Linear triage issue
```

## Response Policy

The response policy determines how classified messages are handled. The system uses **dual-confidence evaluation** for sensitive classifications (bugs and feature requests).

### Policy Actions

| Action | Trigger | Behavior |
|--------|---------|----------|
| **auto_send** | Normal: confidence ≥ 0.85 AND label in `autoSendLabels` | Send draft immediately to Telegram |
| **auto_send** | Bug/Request: classification > 0.8 AND response > 0.875 | Send draft immediately (dual-confidence) |
| **escalate** | confidence < 0.4 OR label is "unknown" | Send to Slack for human review |
| **draft_only** | All other cases | Save draft for later review |

### Dual-Confidence System (Bug/Request)

Sensitive classifications require **both** thresholds to auto-send:

```
Classification Confidence > 0.8  AND  Response Confidence > 0.875
       │                                    │
       ▼                                    ▼
"We're sure it's a bug"          "We're sure our answer is correct"
```

**Response Confidence Factors:**
- 0.9-1.0: Exact solution, verified links, very confident
- 0.8-0.9: Good approach, working links, minor uncertainty
- 0.7-0.8: Reasonable but needs verification
- <0.8: Don't auto-send, needs human review

See `src/lib/config.ts` → `evaluateResponsePolicy()` for implementation.

### Common Tuning Scenarios

**More aggressive auto-send:** Lower `autoSendThreshold` and expand `autoSendLabels` in config.
**Draft-only mode:** Set `autoSendLabels: []`.
**Lower escalation threshold:** Reduce `escalationThreshold` below 0.4.

### Adding New Classification Labels

1. Update type in `src/types/classification.ts`
2. Add rules in `src/lib/classifier.ts`
3. Update model prompt in classifier
4. Set policy for new label in `src/lib/config.ts`

### Monitoring Policy Performance

```sql
-- Auto-send rate by day
SELECT date(created_at) as day, COUNT(*) as total,
  SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as auto_sent,
  ROUND(100.0 * SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) / COUNT(*), 2) as pct
FROM drafts GROUP BY day ORDER BY day DESC;
```

### Rollback

Policy changes are code changes — revert `src/lib/config.ts` and redeploy.

## Debugging the Pipeline

### Quick Diagnostic Flow

```
Message not processed?
        │
        ▼
  1. Check logs (wrangler tail)
        │
   ┌────┴────┐
   ▼         ▼
Webhook   Pipeline
received?   error?
   │         │
   ▼         ▼
Verify    Check D1
secret    tables
```

### 1. Check Live Logs

```bash
npx wrangler tail                          # All logs
npx wrangler tail --search "chatId: 123"   # Specific chat
npx wrangler tail --search "error"          # Errors only
```

### 2. Verify Webhook Delivery

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

### 3. Query D1 Tables

```bash
# Find a specific message
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT am.*, c.telegram_chat_id, c.title
  FROM active_messages am JOIN chats c ON am.chat_id = c.id
  WHERE am.telegram_message_id = 123456 ORDER BY am.created_at DESC LIMIT 5"

# Check classification
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT am.telegram_message_id, am.text, c.label, c.confidence, c.method
  FROM classifications c JOIN active_messages am ON c.message_id = am.id
  WHERE am.telegram_message_id = 123456"

# Check drafts
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT d.content, d.confidence, d.status, d.created_at, d.sent_at
  FROM drafts d JOIN chats c ON d.chat_id = c.id
  WHERE c.telegram_chat_id = 789012345 ORDER BY d.created_at DESC LIMIT 10"

# Check escalations (last 24h)
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT e.*, d.content as draft_content
  FROM escalations e LEFT JOIN drafts d ON e.draft_id = d.id
  WHERE e.created_at > datetime('now', '-24 hours') ORDER BY e.created_at DESC"
```

### 4. Verify Pipeline Stages

| Stage | Log to look for | If missing |
|-------|----------------|------------|
| Webhook received | `Received Telegram update` | Check webhook URL + secret |
| Normalized | `Normalized event` | Message may have no text (photo, sticker) |
| Persisted | — | Check for SQL errors, verify D1 binding |
| Classified | `Classified by rules` or `Rules inconclusive` | Check `env.AI` binding or API keys |
| Response handled | `Draft saved` / `Draft escalated` / `Draft auto-sent` | Check `isMention`, `SLACK_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN` |

### 5. Force Reprocess a Message

Replay the webhook:
```bash
curl -X POST "https://your-worker.workers.dev/webhook/telegram" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  -d '{"update_id": 999999, "message": { "message_id": 123, "from": {"id": 456, "is_bot": false, "first_name": "Test"}, "chat": {"id": 789, "type": "group"}, "date": '$(date +%s)', "text": "REPROCESS: original message text" }}'
```

### 6. Performance Debugging

```bash
# Check pipeline timing
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT stage, COUNT(*) as count, AVG(duration_ms) as avg_ms, MAX(duration_ms) as max_ms
  FROM pipeline_metrics WHERE created_at > datetime('now', '-1 hour') GROUP BY stage"

# Find chats with many messages (slow context)
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT c.telegram_chat_id, COUNT(am.id) as message_count
  FROM active_messages am JOIN chats c ON am.chat_id = c.id
  GROUP BY c.id HAVING message_count > 100"
```

### Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| "Unauthorized" on webhook | Secret mismatch | `wrangler secret put TELEGRAM_WEBHOOK_SECRET`, update Telegram webhook |
| "Model fallback failed" | AI provider error | Check `wrangler ai models`, switch provider in `src/lib/ai.ts` |
| Drafts not sending to Slack | Invalid webhook URL | Test with `curl -X POST "$SLACK_WEBHOOK_URL" -d '{"text":"Test"}'` |
| Linear issues not created | Invalid API key | Test with `curl -X POST https://api.linear.app/graphql -H "Authorization: $LINEAR_API_KEY" -d '{"query":"query { viewer { id } }"}'` |

## See Also

- `src/lib/config.ts` — Response policy implementation + app config
- `src/lib/classifier.ts` — Classification rules
- `src/lib/drafter.ts` — Draft generation
- `src/lib/metrics.ts` — Pipeline timing metrics
