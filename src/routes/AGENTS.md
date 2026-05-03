# Routes — Webhook & Health Endpoints

## Files

- `webhook.ts` — POST `/webhook/telegram` — verify, rate-limit, ingest via `waitUntil`
- `health.ts` — GET `/health` — liveness check
- `slack.ts` — Slack interaction endpoints (approvals, batch operations, slash commands)

## Webhook Handler Flow

```
Request → verify secret → parse Telegram update → rate-limit check → ingestUpdate() via waitUntil → 200 OK
```

**Critical:** Always return 200 to Telegram immediately. All processing is async via `ctx.waitUntil()`.

## Design Decisions

### Security Middleware (`index.ts`)

A `/*` middleware in `index.ts` blocks all requests to undefined routes with a 404. Only explicitly allowed routes pass through. This prevents reconnaissance.

**Adding a new route:** Add it to the `allowedRoutes` array in `index.ts` AND create the Hono route handler.

### Rate Limiting (`webhook.ts`)

Rate limiting uses `checkRateLimit()` which counts messages in `active_messages` for the chat within the last 60 seconds. Rate-limited requests still return 200 (Telegram expects this).

**Important:** `checkRateLimit()` receives the Telegram chat ID (e.g., `-5156915457`), not the internal D1 ID. It maps via a subquery: `(SELECT id FROM chats WHERE telegram_chat_id = ?)`.

### Slack Interactions (`slack.ts`)

**Signature verification:** Every Slack request is verified with HMAC-SHA256 using `SLACK_SIGNING_SECRET`. Requests older than 5 minutes are rejected.

**Modal pattern:** Batch operations use Slack modals (views.open API). The interaction flow:
1. Slash command or button click → open modal
2. User selects items → modal submission
3. `view_submission` handler → batch process via `waitUntil`
4. Return `response_action: "clear"` to close modal

**Action routing:** Block actions are routed by `action.action_id`:
- `approve_chat` / `reject_chat` / `unblacklist_chat` — approval decisions
- `open_batch_modal` — opens batch modal
- `refresh_pending` — refreshes pending list
- `notion_link_project` / `notion_create_project` / `notion_skip_project` — Notion linking

## Telegram Webhook Setup

### Prerequisites

- Telegram account
- Bot token from @BotFather
- Cloudflare Worker deployed with webhook endpoint

### Create Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`, follow prompts
3. Save the token (`123456789:ABCdefGHI...`)
4. Set secret: `bunx wrangler secret put TELEGRAM_BOT_TOKEN`

### Generate & Set Webhook Secret

```bash
openssl rand -hex 32
bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

### Deploy & Set Webhook URL

```bash
bun run deploy

export BOT_TOKEN="your-bot-token"
export WORKER_URL="https://triage-agent.YOUR_SUBDOMAIN.workers.dev"
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
| "Unauthorized" (401) | Secret mismatch | `wrangler secret put TELEGRAM_WEBHOOK_SECRET`, update Telegram webhook |
| "Bad Request: bad webhook" | URL not HTTPS | Test with `curl -I "${WORKER_URL}/webhook/telegram"` |
| Pending updates piling up | Worker not responding or slow | Check `wrangler tail`, reset with `deleteWebhook` + `setWebhook` |
| Not receiving messages | Bot privacy mode | Disable privacy via @BotFather `/setprivacy` |
| Slack signature invalid | Clock drift or wrong secret | Verify `SLACK_SIGNING_SECRET` matches Slack app config |

## Security Checklist

- [ ] `TELEGRAM_WEBHOOK_SECRET` > 32 characters
- [ ] Webhook URL uses HTTPS (Cloudflare default)
- [ ] Secret verified in `src/lib/telegram.ts`
- [ ] Bot token stored as wrangler secret, not in code
- [ ] Webhook endpoint returns 200 quickly (uses `waitUntil`)
- [ ] `SLACK_SIGNING_SECRET` matches Slack app config
- [ ] Undefined routes return 404 (security middleware)

## See Also

- `src/lib/telegram.ts` — Webhook secret verification
- `src/lib/rate-limiter.ts` — Per-chat rate limiting
- `src/pipeline/ingest.ts` — Event ingestion pipeline
- `src/lib/slack.ts` — Slack API helpers
