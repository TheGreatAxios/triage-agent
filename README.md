# Telegram Triage Agent

An AI-powered Cloudflare Worker that automatically ingests Telegram messages, classifies them (bug/request/normal), drafts AI responses, and escalates to Slack with Linear ticket creation for bugs and feature requests.

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

- **Base config** (`wrangler.jsonc`): Uses placeholder for local development
- **Production environment**: Uses `DATABASE_ID` environment variable
- **Secrets**: Stored via Wrangler (never committed)

Create `.dev.vars` for local development (copy from example):

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your actual secrets
```

For production deployment, you have two options:

**Option A: Environment variable (recommended for CI/CD)**
```bash
# Set the database ID as environment variable
export DATABASE_ID="your-real-database-id-from-step-2"

# Deploy to production environment
bun run deploy --env production
```

**Option B: Direct in config (simpler for manual deploys)**
Edit `wrangler.jsonc` and temporarily replace `${DATABASE_ID}` with your real ID in the `env.production` section, deploy, then revert.

### 4. Apply Database Migrations

```bash
# Apply to production database (use --env production to match deployment)
npx wrangler d1 migrations apply triage-agent-db --remote --env production
```

### 5. Set Environment Variables

Create `.dev.vars` for local development:

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your actual values
```

Set production secrets:

```bash
# Required secrets
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put SLACK_WEBHOOK_URL
npx wrangler secret put LINEAR_API_KEY

# Optional (for alternative AI providers)
npx wrangler secret put NVIDIA_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
```

### 6. Configure Telegram Bot

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Set webhook URL:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://telegram-triage-agent.YOUR_SUBDOMAIN.workers.dev/webhook/telegram",
       "secret_token": "YOUR_WEBHOOK_SECRET"
     }'
   ```
3. Get chat ID and add your bot to the group

### 7. Deploy

```bash
# Type check
npx tsc --noEmit

# Deploy to Cloudflare
bun run deploy
```

### 8. Verify Deployment

```bash
# Check health endpoint
curl https://telegram-triage-agent.YOUR_SUBDOMAIN.workers.dev/health

# View live logs
npx wrangler tail
```

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
  pipeline/
    ingest.ts           # Full ingest pipeline
    respond.ts          # Draft → policy → action
    timer.ts            # Scheduled timer processing
  lib/
    ai.ts               # AI provider routing
    classifier.ts       # Rule + AI classification
    config.ts           # Policy thresholds
    drafter.ts          # Draft generation
    escalation.ts       # Slack escalation
    linear.ts           # Linear issue creation
    persistence.ts      # D1 operations
    archiver.ts         # R2 archival
    state.ts            # Conversation state & timers
    rate-limiter.ts     # Per-chat rate limiting
    telegram.ts         # Bot API helpers
    logger.ts           # Structured logging
    metrics.ts          # Pipeline timing
  types/                # TypeScript types
migrations/             # D1 schema migrations
```

## How It Works

### Message Flow

1. **Webhook** receives Telegram update with secret token verification
2. **Rate limiter** prevents spam (max messages per chat)
3. **Pipeline** processes asynchronously via `waitUntil()`
4. **Classification** runs rule-first, then AI model fallback
5. **Response** follows policy: auto_send / escalate / draft_only
6. **Linear** creates triage issues for bugs and feature requests

### Scheduled Tasks (every minute)

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

| Issue | Solution |
|-------|----------|
| Deploy fails | Check `database_id` is valid in wrangler.jsonc |
| Webhook not receiving | Verify webhook URL and secret token |
| AI not responding | Check Workers AI binding or API keys |
| Slack not receiving | Verify webhook URL is correct |
| Linear issues not created | Check LINEAR_API_KEY and team permissions |

## License

MIT
