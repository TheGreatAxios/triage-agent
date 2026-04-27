# Routes — Webhook & Health Endpoints

## Files

- `webhook.ts` — POST `/webhook/telegram` — verify, rate-limit, ingest via `waitUntil`
- `health.ts` — GET `/health` — liveness check
- `slack.ts` — Slack interaction endpoints

## Webhook Handler Flow

```
Request → verify secret → parse Telegram update → rate-limit check → ingestEvent() via waitUntil → 200 OK
```

**Critical:** Always return 200 to Telegram immediately. All processing is async via `ctx.waitUntil()`.

## Telegram Webhook Setup

### Prerequisites

- Telegram account
- Bot token from @BotFather
- Cloudflare Worker deployed with webhook endpoint

### Create Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`, follow prompts
3. Save the token (`123456789:ABCdefGHI...`)
4. Set secret: `npx wrangler secret put TELEGRAM_BOT_TOKEN`

### Generate & Set Webhook Secret

```bash
openssl rand -hex 32
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

### Deploy & Set Webhook URL

```bash
bun run deploy

export BOT_TOKEN="your-bot-token"
export WORKER_URL="https://telegram-triage-agent.YOUR_SUBDOMAIN.workers.dev"
export WEBHOOK_SECRET="your-webhook-secret"

curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${WORKER_URL}/webhook/telegram\",
    \"secret_token\": \"${WEBHOOK_SECRET}\",
    \"allowed_updates\": [\"message\", \"edited_message\"]
  }"
```

### Verify Webhook

```bash
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

Expected: `pending_update_count: 0`, no `last_error_message`.

### Test with Live Message

1. Add bot to a Telegram group
2. Mention the bot: `@YourBotName hello`
3. Check logs: `npx wrangler tail`
4. Verify in D1: `npx wrangler d1 execute telegram-agent-db --remote --command "SELECT * FROM active_messages ORDER BY id DESC LIMIT 1"`

## Local Development Testing

```bash
bun run dev

curl -X POST "http://localhost:8787/webhook/telegram" \
  -H "X-Telegram-Bot-Api-Secret-Token: ${TELEGRAM_WEBHOOK_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 1,
    "message": {
      "message_id": 1,
      "from": {"id": 123, "is_bot": false, "first_name": "Test"},
      "chat": {"id": 456, "type": "group"},
      "date": '$(date +%s)',
      "text": "Test message @YourBot"
    }
  }'
```

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| "Unauthorized" (401) | Secret mismatch | `wrangler secret put TELEGRAM_WEBHOOK_SECRET`, then update Telegram webhook with matching secret |
| "Bad Request: bad webhook" | URL not HTTPS, cert issues | Test with `curl -I "${WORKER_URL}/webhook/telegram"` |
| Pending updates piling up | Worker not responding or slow | Check `wrangler tail`, reset with `deleteWebhook` + `setWebhook` |
| Not receiving messages | Bot privacy mode, not in group | Disable privacy via @BotFather `/setprivacy`, ensure bot is group member |
| Connection refused | Worker not deployed or wrong URL | Verify deployment + URL |

### Webhook Management Commands

```bash
# Get webhook info
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" | jq

# Delete webhook (stop receiving updates)
curl "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook"

# Get updates manually (if webhook deleted)
curl "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates"
```

## Security Checklist

- [ ] `TELEGRAM_WEBHOOK_SECRET` is set and > 32 characters
- [ ] Webhook URL uses HTTPS (Cloudflare default)
- [ ] Secret verified in `src/lib/telegram.ts`
- [ ] Bot token stored as wrangler secret, not in code
- [ ] Webhook endpoint returns 200 quickly (uses `waitUntil`)

## See Also

- `src/lib/telegram.ts` — Webhook secret verification
- `src/lib/rate-limiter.ts` — Per-chat rate limiting
- `src/pipeline/ingest.ts` — Event ingestion pipeline
