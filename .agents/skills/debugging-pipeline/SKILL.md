# Skill: Debugging Pipeline

Trace a message through the triage pipeline. Check D1 tables, read logs, verify webhooks, force reprocess.

## Quick Diagnostic Flow

```
Message not processed?
        │
        ▼
┌───────────────┐
│ 1. Check logs │
└───────┬───────┘
        │
   ┌────┴────┐
   ▼         ▼
Webhook   Pipeline
received?   error?
   │         │
   ▼         ▼
Verify    Check D1
secret    tables
   │         │
   └────┬────┘
        ▼
   Reprocess
   if needed
```

## 1. Check Live Logs

```bash
# Stream logs from production
npx wrangler tail

# Filter for specific chat
npx wrangler tail --search "chatId: 123456789"

# Filter for errors only
npx wrangler tail --search "error"
```

## 2. Verify Webhook Delivery

### Check Telegram Webhook Status

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

Expected response:
```json
{
  "ok": true,
  "result": {
    "url": "https://your-worker.workers.dev/webhook/telegram",
    "has_custom_certificate": false,
    "pending_update_count": 0,
    "last_error_date": null,
    "last_error_message": null
  }
}
```

### Test Webhook Locally

```bash
# Start dev server
bun run dev

# Send test webhook
curl -X POST "http://localhost:8787/webhook/telegram" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  -d '{
    "update_id": 999999,
    "message": {
      "message_id": 123,
      "from": {"id": 456, "is_bot": false, "first_name": "Test"},
      "chat": {"id": 789, "type": "group"},
      "date": '$(date +%s)',
      "text": "Test message for debugging",
      "entities": [{"type": "mention", "offset": 0, "length": 4}]
    }
  }'
```

## 3. Query D1 Tables

### Find a Specific Message

```bash
# By Telegram message ID
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT am.*, c.telegram_chat_id, c.title
  FROM active_messages am
  JOIN chats c ON am.chat_id = c.id
  WHERE am.telegram_message_id = 123456
  ORDER BY am.created_at DESC
  LIMIT 5
"

# By chat and time range
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT * FROM active_messages
  WHERE chat_id = (
    SELECT id FROM chats WHERE telegram_chat_id = 789012345
  )
  AND created_at > datetime('now', '-1 hour')
  ORDER BY created_at DESC
"
```

### Check Classification

```bash
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT 
    am.telegram_message_id,
    am.text,
    c.label,
    c.confidence,
    c.method,
    c.created_at
  FROM classifications c
  JOIN active_messages am ON c.message_id = am.id
  WHERE am.telegram_message_id = 123456
"
```

### Check Drafts

```bash
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT 
    d.id,
    d.content,
    d.confidence,
    d.status,
    d.created_at,
    d.sent_at
  FROM drafts d
  JOIN chats c ON d.chat_id = c.id
  WHERE c.telegram_chat_id = 789012345
  ORDER BY d.created_at DESC
  LIMIT 10
"
```

### Check Escalations

```bash
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT 
    e.*,
    d.content as draft_content
  FROM escalations e
  LEFT JOIN drafts d ON e.draft_id = d.id
  WHERE e.created_at > datetime('now', '-24 hours')
  ORDER BY e.created_at DESC
"
```

### Check Linear Links

```bash
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT 
    ll.*,
    c.telegram_chat_id,
    c.title as chat_title
  FROM linear_links ll
  JOIN chats c ON ll.chat_id = c.id
  WHERE ll.created_at > datetime('now', '-7 days')
"
```

## 4. Verify Pipeline Stages

### Stage 1: Webhook Received?

Check logs for:
```
Received Telegram update { update_id: 999999 }
```

If missing:
- Check Telegram webhook URL is correct
- Verify `TELEGRAM_WEBHOOK_SECRET` matches
- Check Cloudflare Worker is deployed: `npx wrangler deploy`

### Stage 2: Normalized?

Check logs for:
```
Normalized event { id: 999999, chatId: 789, ... }
```

If missing:
- Message may not have text (photos, stickers ignored)
- Check `isProcessableUpdate()` in `src/pipeline/ingest.ts`

### Stage 3: Persisted?

Check D1:
```bash
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT * FROM active_messages WHERE id = (SELECT MAX(id) FROM active_messages)
"
```

If missing:
- Check for SQL errors in logs
- Verify D1 binding in `wrangler.jsonc`
- Check `DB` environment variable is set

### Stage 4: Classified?

Check logs for:
```
Classified by rules { messageId: 123, label: "bug", confidence: 0.8 }
```

Or:
```
Rules inconclusive, using model fallback { messageId: 123 }
```

If missing:
- Check `classifyMessage()` error in logs
- Verify `env.AI` binding (Workers AI) or API keys for external providers

### Stage 5: Response Handled?

Check logs for:
```
Draft saved for review { chatId: 1, draftId: 5, confidence: 0.75 }
```

Or:
```
Draft escalated to Slack { chatId: 1, draftId: 5 }
```

Or:
```
Draft auto-sent { chatId: 1, draftId: 5 }
```

If missing:
- Message may not be a mention (check `isMention` in logs)
- Check `handleResponse()` error in logs
- Verify `SLACK_WEBHOOK_URL` for escalations
- Verify `TELEGRAM_BOT_TOKEN` for auto-send

## 5. Force Reprocess a Message

If a message failed processing, you can reprocess it:

### Option A: Replay Webhook

```bash
curl -X POST "https://your-worker.workers.dev/webhook/telegram" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  -d '{
    "update_id": 999999,
    "message": {
      "message_id": 123,
      "from": {"id": 456, "is_bot": false, "first_name": "Test"},
      "chat": {"id": 789, "type": "group"},
      "date": '$(date +%s)',
      "text": "REPROCESS: original message text"
    }
  }'
```

### Option B: Manual D1 Insert + Trigger

For messages that never hit the webhook:

```bash
# 1. Ensure chat exists
npx wrangler d1 execute telegram-agent-db --remote --command "
  INSERT OR IGNORE INTO chats (telegram_chat_id, type, title)
  VALUES (789012345, 'group', 'Test Chat')
"

# 2. Insert message manually
npx wrangler d1 execute telegram-agent-db --remote --command "
  INSERT INTO active_messages (source, chat_id, telegram_message_id, sender_id, text, event_type, is_mention)
  SELECT 
    'telegram',
    c.id,
    999999,
    p.id,
    'Manual reprocess message',
    'mention',
    1
  FROM chats c
  JOIN chat_participants p ON p.chat_id = c.id
  WHERE c.telegram_chat_id = 789012345
  LIMIT 1
"

# 3. Trigger classification via API (if you add a manual trigger endpoint)
```

### Option C: Add Manual Trigger Endpoint

For future debugging, add to `src/routes/webhook.ts`:

```typescript
import { ingestUpdate } from "../pipeline/ingest";

webhook.post("/reprocess", async (c) => {
  // Admin-only endpoint
  const adminToken = c.req.header("X-Admin-Token");
  if (adminToken !== c.env.ADMIN_TOKEN) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { telegram_chat_id, telegram_message_id } = await c.req.json();

  // Fetch from D1 and reprocess
  const message = await c.env.DB
    .prepare("SELECT * FROM active_messages WHERE telegram_message_id = ?")
    .bind(telegram_message_id)
    .first();

  if (!message) {
    return c.json({ error: "Message not found" }, 404);
  }

  // Trigger reprocessing...

  return c.json({ success: true });
});
```

## 6. Common Issues & Solutions

### Issue: "Unauthorized" on webhook

**Cause:** Secret mismatch
**Fix:**
```bash
# Check current secret
npx wrangler secret list

# Update if needed
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

# Update Telegram webhook with new secret
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://your-worker.workers.dev/webhook/telegram" \
  -d "secret_token=YOUR_NEW_SECRET"
```

### Issue: "Model fallback failed"

**Cause:** AI provider error
**Fix:**
```bash
# Check if Workers AI is available
npx wrangler ai models

# Or switch to backup provider in src/lib/ai.ts
```

### Issue: Drafts not sending to Slack

**Cause:** Invalid webhook URL
**Fix:**
```bash
# Test Slack webhook
curl -X POST "$SLACK_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"text": "Test message"}'

# Update if needed
npx wrangler secret put SLACK_WEBHOOK_URL
```

### Issue: Linear issues not created

**Cause:** Invalid API key or team permissions
**Fix:**
```bash
# Test Linear API
curl -X POST "https://api.linear.app/graphql" \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "query { viewer { id name } }"}'
```

## 7. Performance Debugging

### Check Pipeline Timing

```bash
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT 
    stage,
    COUNT(*) as count,
    AVG(duration_ms) as avg_ms,
    MAX(duration_ms) as max_ms
  FROM pipeline_metrics
  WHERE created_at > datetime('now', '-1 hour')
  GROUP BY stage
"
```

### Slow Classification?

Check if using external provider:
```bash
npx wrangler tail --search "classify"
# Look for provider in logs
```

### Slow Draft Generation?

Large context window causes slow drafts. Check:
```bash
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT 
    c.telegram_chat_id,
    COUNT(am.id) as message_count
  FROM active_messages am
  JOIN chats c ON am.chat_id = c.id
  GROUP BY c.id
  HAVING message_count > 100
"
```

## 8. Export Data for Analysis

### Export Recent Messages

```bash
npx wrangler d1 export telegram-agent-db --remote --output backup.sql
```

### Query Specific Time Window

```bash
npx wrangler d1 execute telegram-agent-db --remote --command "
  SELECT 
    datetime(am.created_at) as time,
    c.title as chat,
    am.text,
    cl.label,
    cl.confidence,
    d.status as response_status
  FROM active_messages am
  JOIN chats c ON am.chat_id = c.id
  LEFT JOIN classifications cl ON cl.message_id = am.id
  LEFT JOIN drafts d ON d.chat_id = am.chat_id AND d.created_at > am.created_at
  WHERE am.created_at > datetime('now', '-24 hours')
  ORDER BY am.created_at DESC
  LIMIT 100
" --json > recent_activity.json
```

## See Also

- `src/lib/logger.ts` — Logging implementation
- `src/lib/metrics.ts` — Pipeline timing metrics
- `src/pipeline/ingest.ts` — Main pipeline stages
- `src/routes/webhook.ts` — Webhook handling
