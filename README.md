# Triage Agent

An AI-powered Cloudflare Worker that automatically ingests Telegram messages, classifies them (bug/request/normal), drafts AI responses, and escalates to Slack with Linear ticket creation for bugs and feature requests.

## ✨ Key Features

- **🔐 Chat Approval Flow**: All groups and DMs require manual Slack approval before the bot responds
- **⏱️ 72-Hour Auto-Expiration**: Pending approvals expire with automatic chat departure
- **🚫 Blacklist**: Rejected chats are blacklisted and auto-rejected if re-added
- **📊 Daily Summaries**: Morning (8 AM PST) and evening (4 PM PST) activity reports
- **🤖 AI Classification**: Rule-based + AI model fallback for message classification
- **📝 Linear Integration**: Automatic triage issue creation for bugs and feature requests

## ⚡ Quick Start Checklist

Before diving into full setup, here's the critical path:

1. **Get Bot Token** → Message [@BotFather](https://t.me/BotFather), create bot, copy token
2. **Generate Secret** → `openssl rand -hex 16` (save this value!)
3. **Deploy Worker** → `bun run deploy` (creates D1, R2 automatically)
4. **Apply Migrations** → `bun run db:migrate:remote` (sets up approval tables)
5. **Set Secrets** → `wrangler secret put TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` (use SAME secret from step 2)
6. **Set Webhook** → Tell Telegram your worker URL + secret (must match step 4 exactly)
7. **Configure Slack** → Create Slack app, set up webhooks and slash commands (see [Slack Setup](#slack-setup) below)
8. **Test** → `wrangler tail` then add bot to a group (should trigger approval request)

**⚠️ Most common failure:** Webhook secret in Cloudflare ≠ Webhook secret sent to Telegram. These must match exactly.

## What It Does

When someone mentions your bot in a Telegram chat:

1. **Ingests** the message via webhook
2. **Classifies** it as `bug`, `request`, `normal`, or `unknown` using rule-based + AI classification
3. **Generates** an AI draft response
4. **Evaluates** response policy:
   - **Auto-send** (≥85% confidence + "normal" label): Sends response immediately
   - **Escalate** (<40% confidence or "unknown"): Sends to Slack with context
   - **Draft-only** (middle confidence): Saves draft for human review
5. **Creates** Linear triage issues for bugs and feature requests

## Architecture

```
┌─────────────┐     ┌──────────┐     ┌─────────────┐
│   Telegram  │────▶│ Webhook  │────▶│ Rate Limit  │
└─────────────┘     └──────────┘     └─────────────┘
                                              │
                                              ▼
┌─────────────────────────────────────────────────────┐
│                    Ingest Pipeline                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │Normalize │─▶│ Persist  │─▶│ Classify │─▶│Respond │ │
│  └──────────┘  └──────────┘  └──────────┘  └────────┘ │
└─────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   ┌─────────┐        ┌───────────┐       ┌──────────┐
   │Telegram │        │  Slack    │       │  Linear  │
   │(auto)   │        │(escalate) │       │(bug/req) │
   └─────────┘        └───────────┘       └──────────┘
```

## Tech Stack

- **Runtime:** Cloudflare Workers
- **Framework:** Hono
- **Database:** Cloudflare D1 (SQLite)
- **Storage:** Cloudflare R2 (archived messages)
- **AI:** Vercel AI SDK with multi-provider routing (Workers AI, NVIDIA NIM, OpenAI, OpenRouter)
- **Language:** TypeScript

## Prerequisites

- Node.js 18+ or Bun
- Cloudflare account
- Telegram Bot (via @BotFather)
- Slack incoming webhook URL
- Linear API key

## Setup

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_USERNAME/telegram-triage-agent.git
cd telegram-triage-agent
bun install
```

### 2. Create Cloudflare Resources

```bash
# Login to Cloudflare
npx wrangler login

# Create D1 database
npx wrangler d1 create triage-agent-db
# Copy the database_id from output (you'll need it for deployment)

# Create R2 bucket
npx wrangler r2 bucket create triage-agent-archive
```

### 3. Configure Environment

The project uses a hybrid approach for managing resource IDs:

### 3. Configure Environment Variables

The project uses environment variable substitution in `wrangler.jsonc`:
- `DATABASE_ID`: Your D1 database ID from step 2

**For Cloudflare Dashboard (GitHub integration):**
1. Go to your Worker in Cloudflare Dashboard
2. Settings → Environment Variables
3. Add: `DATABASE_ID` = `your-real-database-id-from-step-2`

**For local deployment:**
```bash
export DATABASE_ID="your-real-database-id-from-step-2"
bun run deploy
```

**For local development:**
```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your actual secrets (local only)
```

**Note:** `.dev.vars` is only for local dev. Production secrets must be set via `wrangler secret put` and must match your Telegram webhook configuration.

### 4. Apply Database Migrations

```bash
# Apply to production database
npx wrangler d1 migrations apply triage-agent-db --remote
```

### 5. Set Secrets (Critical - Read Carefully)

**⚠️ The webhook secret must match between Cloudflare AND Telegram. If they don't match, you'll get 401 Unauthorized and no messages will process.**

#### Step 5a: Generate a Webhook Secret

Generate a random secret (or use any strong password):
```bash
openssl rand -hex 16
# Example output: a3f5c8e9d2b1a7f4e6c9d8b3a1f2e5c7
```

#### Step 5b: Set Secrets in Cloudflare

**Important:** Use the SAME webhook secret value in both commands below.

```bash
# Required - your bot token from @BotFather
npx wrangler secret put TELEGRAM_BOT_TOKEN

# Required - use the value you generated above
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

# Required for Slack escalation (existing feature)
npx wrangler secret put SLACK_WEBHOOK_URL

# Required for Slack approval flow (3 separate channels)
npx wrangler secret put SLACK_APPROVAL_WEBHOOK_URL    # Approval requests channel
npx wrangler secret put SLACK_SUMMARY_WEBHOOK_URL     # Daily summaries channel
npx wrangler secret put SLACK_SIGNING_SECRET          # From Slack app Basic Info
npx wrangler secret put SLACK_BOT_TOKEN               # xoxb- token from OAuth

# Optional: Enable activation notifications (default: silent)
npx wrangler secret put NOTIFY_ON_APPROVAL            # Set to "true" to notify

# Required for Linear integration
npx wrangler secret put LINEAR_API_KEY
npx wrangler secret put LINEAR_TEAM_ID
npx wrangler secret put LINEAR_TRIAGE_STATE_ID

# Optional (for alternative AI providers)
npx wrangler secret put NVIDIA_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
```

**Verify secrets are set:**
```bash
npx wrangler secret list
```

### 6. Configure Telegram Bot & Deploy

1. **Create a bot** via [@BotFather](https://t.me/BotFather) and copy the bot token

2. **Get your worker URL** (run `npx wrangler whoami` to see your account subdomain):
   ```
   https://triage-agent.<your-subdomain>.workers.dev
   ```

3. **Set Telegram webhook** (use the SAME secret you set in Step 5b):
   ```bash
   export TELEGRAM_BOT_TOKEN="your-bot-token-from-botfather"
   export TELEGRAM_WEBHOOK_SECRET="same-secret-from-step-5b"

   curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
     -H "Content-Type: application/json" \
     -d "{\"url\":\"https://triage-agent.YOUR_SUBDOMAIN.workers.dev/webhook/telegram\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\"}"
   ```

   **Expected response:** `{"ok":true,"result":true,"description":"Webhook was set"}`

   **Verify webhook is set:**
   ```bash
   curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
   ```

4. **Deploy to Cloudflare:**
   ```bash
   # Type check
   npx tsc --noEmit

   # Deploy
   bun run deploy
   ```

5. **Add your bot to a Telegram group** (or message it directly)

### 6b. Slack Setup (Approval Flow)

The approval flow requires a Slack app with interactive components. This enables manual approval of chats before the bot responds.

#### Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App**
2. Choose "From scratch" → Name it "TriageBot Approvals" → Select your workspace

#### Configure OAuth Scopes

1. Go to **OAuth & Permissions**
2. Add these **Bot Token Scopes**:
   - `chat:write` - Post messages
   - `commands` - Slash commands
   - `users:read` - Resolve user mentions
3. **Install to Workspace** and copy the **Bot User OAuth Token** (starts with `xoxb-`)
4. Set this as `SLACK_BOT_TOKEN` in wrangler secrets

#### Get Signing Secret

1. Go to **Basic Information**
2. Copy **Signing Secret** (under App Credentials)
3. Set this as `SLACK_SIGNING_SECRET` in wrangler secrets

#### Configure Interactivity

1. Go to **Interactivity & Shortcuts** → Enable
2. Set **Request URL**: `https://triage-agent.YOUR_SUBDOMAIN.workers.dev/webhook/slack/interactions`
3. Save Changes

#### Create Slash Commands

Go to **Slash Commands** → Create New Command for each:

| Command | Request URL | Description |
|---------|-------------|-------------|
| `/pending-chats` | `https://triage-agent.YOUR_SUBDOMAIN.workers.dev/webhook/slack/commands` | List pending approvals |
| `/batch-approve` | Same as above | Batch approve multiple chats |
| `/batch-reject` | Same as above | Batch reject multiple chats |
| `/rejected-chats` | Same as above | View blacklisted chats |

#### Set Up Webhook Channels

Create three Slack channels (or use existing ones):

1. **#triage-escalations** - For message escalations (existing `SLACK_WEBHOOK_URL`)
2. **#triage-approvals** - For approval requests (`SLACK_APPROVAL_WEBHOOK_URL`)
3. **#triage-summaries** - For daily stats (`SLACK_SUMMARY_WEBHOOK_URL`)

Get webhook URLs:
1. In each channel: `/add apps` → Add **Incoming Webhooks**
2. Or use Slack app → **Incoming Webhooks** → Add New Webhook to Workspace
3. Copy each webhook URL and set as corresponding secret

### 7. Verify Deployment

```bash
# Check health endpoint
curl https://telegram-triage-agent.YOUR_SUBDOMAIN.workers.dev/health

# View live logs
npx wrangler tail
```

## Approval Flow System

The approval flow ensures the bot only operates in explicitly approved chats. This prevents unauthorized usage and gives you control over where the bot is active.

### How It Works

```
Bot Added to Chat
       ↓
Check Blacklist ──Blacklisted?──→ Auto-reject & Leave
       ↓ No
Check Existing ──Approved?──→ Silent activation
       ↓ No
Create Pending Approval
       ↓
Send Slack Request (minimal or rich view)
       ↓
Wait for Admin Decision (72 hours max)
       ↓
   ┌──────────┬──────────┬──────────┐
   ▼          ▼          ▼          ▼
 Approved   Rejected   Expired   Unblacklist
   ↓          ↓          ↓          ↓
 Activate  Blacklist   Leave    New request
+ Notify?   + Leave    + Notify
```

### Adaptive Context Views

The approval request uses **complexity scoring** to determine view richness:

| Factor | Weight | Threshold |
|--------|--------|-----------|
| Member count | 30% | >10 triggers rich view |
| Message density | 25% | >5 msg/hour adds weight |
| Urgency signals | 25% | Keywords like "urgent", "broken" |
| Questions | 10% | Presence of `?` |
| Code/links | 10% | Code blocks or URLs |
| Prior summary | +15% boost | Previous chat history |

**Rich view** (>0.6 complexity, >10 members, or prior summary):
- Shows recent messages (max 5, token-aware)
- Displays prior chat summary if available
- Lists complexity factors

**Minimal view** (low complexity):
- Basic metadata only
- Faster to scan for batch operations

### Slack Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `/pending-chats` | `/pending-chats [filter]` | List pending approvals. Filters: `all`, `groups`, `dms`, `recent`, `rich` |
| `/batch-approve` | `/batch-approve` | Open modal to approve multiple chats at once |
| `/batch-reject` | `/batch-reject` | Open modal to reject multiple chats at once |
| `/rejected-chats` | `/rejected-chats [all]` | View blacklisted chats. Use `all` to see more than 10 |

### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `NOTIFY_ON_APPROVAL` | `false` | Send Telegram message when approved (`true`/`false`) |
| Approval expiration | 72 hours | Hard-coded, sends warning before leaving |

### Database Schema

The approval system uses these tables (see `migrations/0002_chat_approval.sql`):

- `chats` - Added `approval_status`, `is_blacklisted`, timestamps
- `pending_approvals` - Queue with complexity scores and expiration
- `chat_membership_history` - Audit log of add/remove/approve/reject events
- `daily_stats` - Aggregated statistics for summaries
- `app_config` - Bot metadata cache

## Configuration

### Response Policy Thresholds (src/lib/config.ts)

| Setting | Default | Description |
|---------|---------|-------------|
| `escalationThreshold` | 0.4 | Below this → escalate to Slack |
| `autoSendThreshold` | 0.85 | Above this → auto-send if label is "normal" |
| `autoSendLabels` | `["normal"]` | Labels eligible for auto-send |
| `noResponseDelaySeconds` | 30 | Timer delay before auto-draft if no human responds |
| `maxHotMessages` | 200 | Per-chat message limit before R2 archival |

### AI Provider Routing (src/lib/ai.ts)

Edit `TASK_MODELS` to change providers/models per task:

```typescript
const TASK_MODELS: Record<AITask, ModelConfig> = {
  classify: { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
  draft:    { provider: "nvidia",     model: "meta/llama-3.3-70b-instruct" },
  summarize:{ provider: "openai",     model: "gpt-4o-mini" },
};
```

Available providers: `workers-ai`, `nvidia`, `openai`, `openrouter`.

## Development

```bash
# Start local dev server
bun run dev

# Type check
npx tsc --noEmit

# Apply local migrations
bun run db:migrate:local
```

## Project Structure

```
src/
  index.ts              # Hono app + scheduled handler
  routes/
    webhook.ts          # POST /webhook/telegram
    health.ts           # GET /health
    slack.ts            # Slack interactions & slash commands
  pipeline/
    ingest.ts           # Full ingest pipeline (with approval gate)
    respond.ts          # Draft → policy → action
    timer.ts            # Scheduled timer + approval expiration + daily summaries
  lib/
    ai.ts               # AI provider routing
    approval.ts         # Core approval flow logic
    classifier.ts       # Rule + AI classification
    config.ts           # Policy thresholds
    drafter.ts          # Draft generation
    escalation.ts       # Slack escalation
    linear.ts           # Linear issue creation
    persistence.ts      # D1 operations (includes approval queries)
    archiver.ts         # R2 archival
    slack.ts            # Slack API + verification
    slack-blocks.ts     # Block Kit UI builders
    state.ts            # Conversation state & timers
    telegram-api.ts     # Telegram Bot API helpers
    rate-limiter.ts     # Per-chat rate limiting
    telegram.ts         # Webhook verification
    logger.ts           # Structured logging
    metrics.ts          # Pipeline timing
  types/                # TypeScript types
    approval.ts         # Approval flow types
    classification.ts   # Classification types
    draft.ts            # Draft/response types
    env.ts              # Environment bindings
    escalation.ts       # Escalation types
    events.ts           # Internal event types
    telegram.ts         # Telegram API types
migrations/             # D1 schema migrations
  0001_initial_schema.sql
  0002_chat_approval.sql
```

## How It Works

### Message Flow

1. **Webhook** receives Telegram update with secret token verification
2. **Rate limiter** prevents spam (max messages per chat)
3. **Pipeline** processes asynchronously via `waitUntil()`
4. **Classification** runs rule-first, then AI model fallback
5. **Response** follows policy: auto_send / escalate / draft_only
6. **Linear** creates triage issues for bugs and feature requests

### Scheduled Tasks (every 5 minutes)

- **Timer processing**: Handle expired "no response" timers
- **Archival**: Move old messages to R2, prune from D1

## Classification Labels

| Label | Description | Action |
|-------|-------------|--------|
| `bug` | Bug report | Escalate + Linear issue |
| `request` | Feature request | Escalate + Linear issue |
| `normal` | General message | Draft response (auto-send if high confidence) |
| `unknown` | Unclear intent | Escalate to Slack |

## Secrets & Security

- Never commit `.dev.vars` or secrets
- All API keys stored via `wrangler secret put`
- Webhook secret verifies Telegram payloads
- SQL queries use parameterized statements

## Troubleshooting

### Critical: Webhook Secret Mismatch

**Symptoms:** No logs appear when sending Telegram messages, or you see `{"error":"Unauthorized"}`

**Root cause:** The `TELEGRAM_WEBHOOK_SECRET` in Cloudflare doesn't match what Telegram is sending.

**Fix:**
```bash
# 1. Check what secret is in Cloudflare
npx wrangler secret get TELEGRAM_WEBHOOK_SECRET

# 2. Export that exact value locally
export TELEGRAM_WEBHOOK_SECRET="the-exact-value-from-above"

# 3. Re-set the Telegram webhook with the same secret
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://triage-agent.YOUR_SUBDOMAIN.workers.dev/webhook/telegram\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\"}"
```

### Debug Checklist

| Issue | Solution |
|-------|----------|
| Deploy fails | Check `database_id` is valid in wrangler.jsonc |
| No logs at all | Run `wrangler tail` first, then test. Check observability is enabled in wrangler.jsonc |
| Webhook 401 Unauthorized | Secret mismatch - see above fix |
| Webhook not receiving | Verify `getWebhookInfo` shows correct URL. Check `pending_update_count` is 0 |
| AI not responding | Check Workers AI binding or API keys |
| Slack not receiving | Verify webhook URL is correct |
| Linear issues not created | Check LINEAR_API_KEY and team permissions |

### Testing Webhook Locally

```bash
# Watch logs
npx wrangler tail

# In another terminal, test with curl (use your actual secret)
curl -X POST "https://triage-agent.YOUR_SUBDOMAIN.workers.dev/webhook/telegram" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: ${TELEGRAM_WEBHOOK_SECRET}" \
  -d '{"update_id":123,"message":{"message_id":1,"from":{"id":123,"is_bot":false,"first_name":"Test"},"chat":{"id":123,"type":"private"},"date":1710000000,"text":"test"}}'
```

**Expected:** `{"ok":true}` and logs appear in `wrangler tail`

### Approval Flow Troubleshooting

| Issue | Solution |
|-------|----------|
| No approval request in Slack | Check `SLACK_APPROVAL_WEBHOOK_URL` is set. Verify bot was added to group (not just messaged directly). Check `wrangler tail` for errors. |
| Slack signature invalid | Ensure `SLACK_SIGNING_SECRET` matches your Slack app's Basic Info → Signing Secret. |
| Slash commands not working | Verify Request URL in Slack app points to `/webhook/slack/commands`. Check command is installed to workspace. |
| Can't approve/reject | Ensure `SLACK_BOT_TOKEN` has `chat:write` scope and is installed to the correct workspace. |
| Bot not leaving rejected chats | Check `TELEGRAM_BOT_TOKEN` is correct. Bot must be admin to leave groups. |
| Daily summaries not sending | Verify `SLACK_SUMMARY_WEBHOOK_URL`. Check cron triggers are configured in `wrangler.jsonc`. |

## License

This project is currently **unlicensed** and considered **experimental**. While the source code is publicly available:

- **Not free to sell** — This code may not be sold or commercially redistributed without explicit permission
- **Subject to change** — The API, architecture, and functionality may change at any time without notice
- **Use at your own risk** — No warranties or guarantees are provided. Use in production at your own discretion

You are welcome to use, explore, and learn from this codebase.

For inquiries, permissions, or questions about usage, please connect with me:

- [LinkedIn](https://linkedin.com/in/sawyercutler)
- [X (Twitter)](https://x.com/thegreataxios)
