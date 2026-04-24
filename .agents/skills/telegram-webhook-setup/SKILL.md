# Skill: Telegram Webhook Setup

Configure the Telegram Bot API webhook to deliver messages to your Cloudflare Worker.

## Prerequisites

- Telegram account
- Bot token from @BotFather
- Cloudflare Worker deployed with webhook endpoint

## Step 1: Create Bot (if needed)

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`
3. Follow prompts to name your bot
4. Save the token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

Set the secret:
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

## Step 2: Generate Webhook Secret

Create a random secret for webhook verification:

```bash
# Generate secure random string
openssl rand -hex 32

# Or use uuid
cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen
```

Set the secret:
```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

## Step 3: Deploy Worker

Ensure your Worker is deployed with the webhook endpoint:

```bash
bun run deploy
```

Verify the endpoint exists:
```bash
curl "https://telegram-triage-agent.YOUR_SUBDOMAIN.workers.dev/health"
```

## Step 4: Set Webhook URL

### Using curl

```bash
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

### Using BotFather (alternative)

Not recommended for production, but works for testing:

1. Message @BotFather
2. Send `/setwebhook`
3. Select your bot
4. Enter the webhook URL

**Note:** BotFather method doesn't support `secret_token` — less secure.

## Step 5: Verify Webhook

### Check Webhook Info

```bash
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

Expected response:
```json
{
  "ok": true,
  "result": {
    "url": "https://telegram-triage-agent.YOUR_SUBDOMAIN.workers.dev/webhook/telegram",
    "has_custom_certificate": false,
    "pending_update_count": 0,
    "last_error_date": null,
    "last_error_message": null,
    "max_connections": 40,
    "ip_address": "104.16.0.0"
  }
}
```

### Test with Live Message

1. Add your bot to a Telegram group
2. Mention the bot: `@YourBotName hello`
3. Check logs:
   ```bash
   npx wrangler tail
   ```
4. Verify message appears in D1:
   ```bash
   npx wrangler d1 execute telegram-agent-db --remote --command "SELECT * FROM active_messages ORDER BY id DESC LIMIT 1"
   ```

## Step 6: Troubleshooting

### "Unauthorized" Errors

**Symptom:** Webhook returns 401

**Check:**
```bash
# Verify secret matches
echo $TELEGRAM_WEBHOOK_SECRET
npx wrangler secret list | grep TELEGRAM_WEBHOOK_SECRET
```

**Fix:**
```bash
# Update secret
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

# Update Telegram webhook with new secret
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${WORKER_URL}/webhook/telegram\",
    \"secret_token\": \"NEW_SECRET\"
  }"
```

### "Bad Request: bad webhook"

**Symptom:** Telegram rejects webhook URL

**Common causes:**
- URL not HTTPS
- URL returns non-200 on HEAD request
- Certificate issues

**Fix:**
```bash
# Test URL manually
curl -I "${WORKER_URL}/webhook/telegram"

# Should return 401 (unauthorized) or 200, not 404/500
```

### Pending Updates Piling Up

**Symptom:** `pending_update_count` > 0 in getWebhookInfo

**Cause:** Worker not responding or slow

**Fix:**
```bash
# Check Worker logs
npx wrangler tail

# If needed, delete and reset webhook
curl "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook"
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=${WORKER_URL}/webhook/telegram" \
  -d "secret_token=${WEBHOOK_SECRET}"
```

### Webhook Not Receiving Messages

**Checklist:**

1. Bot added to group?
   - Add bot, then promote to admin (optional but recommended)

2. Bot has privacy mode disabled?
   - Message @BotFather
   - Send `/setprivacy`
   - Select bot
   - Choose "Disable"

3. Group permissions allow bot to read messages?
   - Group Settings → Permissions → Bot Permissions

4. Mention format correct?
   - Use `@BotName` not just `BotName`
   - Or reply to bot's message

### Last Error in getWebhookInfo

```bash
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" | jq '.result.last_error_message'
```

Common errors:
- `"Connection refused"` — Worker not deployed or URL wrong
- `"Connection timeout"` — Worker slow to respond (>60s)
- `"Wrong response from the webhook"` — Worker returned non-200

## Step 7: Advanced Configuration

### Limit Update Types

Only receive message types you process:

```bash
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${WORKER_URL}/webhook/telegram\",
    \"secret_token\": \"${WEBHOOK_SECRET}\",
    \"allowed_updates\": [\"message\", \"edited_message\"]
  }"
```

Available update types: `message`, `edited_message`, `channel_post`, `edited_channel_post`, `inline_query`, `chosen_inline_result`, `callback_query`, `shipping_query`, `pre_checkout_query`, `poll`, `poll_answer`, `my_chat_member`, `chat_member`, `chat_join_request`

### Custom Certificate (rarely needed)

Cloudflare handles SSL — only needed for self-signed:

```bash
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -F "url=${WORKER_URL}/webhook/telegram" \
  -F "secret_token=${WEBHOOK_SECRET}" \
  -F "certificate=@/path/to/cert.pem"
```

### Max Connections

Telegram defaults to 40 concurrent connections. Usually fine, but adjustable:

```bash
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=${WORKER_URL}/webhook/telegram" \
  -d "secret_token=${WEBHOOK_SECRET}" \
  -d "max_connections=20"
```

## Step 8: Local Development Testing

### Using ngrok (deprecated but simple)

```bash
# Install ngrok
brew install ngrok

# Start tunnel
ngrok http 8787

# Set webhook to ngrok URL
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=https://YOUR_NGROK_ID.ngrok.io/webhook/telegram" \
  -d "secret_token=${WEBHOOK_SECRET}"
```

### Using --local-mode (recommended)

For local testing without webhook:

```bash
# Start dev server
bun run dev

# Use test endpoint to simulate webhook
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

## Step 9: Webhook Management Commands

```bash
# Get webhook info
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" | jq

# Delete webhook (stop receiving updates)
curl "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook"

# Set webhook (re-enable)
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=${WORKER_URL}/webhook/telegram" \
  -d "secret_token=${WEBHOOK_SECRET}"

# Get updates manually (if webhook deleted)
curl "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates"
```

## Security Checklist

- [ ] `TELEGRAM_WEBHOOK_SECRET` is set and > 32 characters
- [ ] Webhook URL uses HTTPS (Cloudflare default)
- [ ] Secret token verified in `verifyTelegramWebhook()`
- [ ] Bot token stored as wrangler secret, not in code
- [ ] Webhook endpoint returns 200 quickly (use `waitUntil` for processing)

## See Also

- `src/routes/webhook.ts` — Webhook handler implementation
- `src/lib/telegram.ts` — Verification logic
- [Telegram Bot API Docs](https://core.telegram.org/bots/api#setwebhook)
