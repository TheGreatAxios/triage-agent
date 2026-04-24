# Skill: Adding a New Triage Source

Add support for a new message source (Discord, Email, Slack, API, etc.) to the Telegram Triage Agent.

## Architecture Overview

The system uses a **source-adapter pattern**:

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Source    │────▶│   Adapter    │────▶│  InternalEvent  │
│ (Discord,   │     │ (normalize,  │     │  (universal)    │
│  Email, etc)│     │  verify)     │     │                 │
└─────────────┘     └──────────────┘     └─────────────────┘
                                                   │
                          ┌────────────────────────┼────────────────────────┐
                          ▼                        ▼                        ▼
                   ┌─────────────┐          ┌─────────────┐          ┌─────────────┐
                   │  Classify   │          │    Draft    │          │   Respond   │
                   │  (label)    │          │  (generate) │          │  (action)   │
                   └─────────────┘          └─────────────┘          └─────────────┘
```

The **core pipeline** (`ingest.ts`, `classifier.ts`, `respond.ts`) is source-agnostic. You only need to:
1. Create an adapter that converts source payloads to `InternalEvent`
2. Add a webhook route that uses your adapter
3. (Optional) Implement source-specific response sending

## Files You'll Touch

| File | Purpose |
|------|---------|
| `src/sources/{name}.ts` | New adapter implementation |
| `src/sources/types.ts` | Register adapter in registry |
| `src/routes/webhook.ts` | Add route for new source |
| `src/types/events.ts` | Add source to `Source` union type |
| `wrangler.jsonc` | Add secrets/bindings if needed |

## Step-by-Step Guide

### Step 1: Add Source to Type Union

Edit `src/types/events.ts`:

```typescript
export type Source = "telegram" | "email" | "slack" | "api" | "discord";
```

### Step 2: Create the Adapter

Create `src/sources/discord.ts` (example for Discord):

```typescript
import type { SourceAdapter } from "./types";
import type { InternalEvent, MessageEventType } from "../types/events";

// Define your source-specific payload type
interface DiscordMessage {
  id: string;
  channel_id: string;
  author: {
    id: string;
    username: string;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  mentions: Array<{ id: string }>;
}

export const discordAdapter: SourceAdapter<DiscordMessage> = {
  name: "discord",

  normalize(payload: DiscordMessage): InternalEvent | null {
    // Skip non-text messages
    if (!payload.content) return null;

    const isMention = payload.mentions.some(
      (m) => m.id === process.env.DISCORD_BOT_USER_ID
    );

    return {
      id: parseInt(payload.id), // or use hash if ID is string
      source: "discord",
      type: this.resolveEventType(payload, isMention),
      chatId: parseInt(payload.channel_id),
      messageId: parseInt(payload.id),
      sender: {
        id: parseInt(payload.author.id),
        isBot: payload.author.bot ?? false,
        name: payload.author.username,
      },
      text: payload.content,
      isMention,
      timestamp: payload.timestamp,
    };
  },

  verify(request: Request, secret: string): boolean {
    // Discord verifies via signature header
    const signature = request.headers.get("X-Signature-Ed25519");
    // ... verification logic
    return true; // implement actual verification
  },

  resolveEventType(payload: DiscordMessage, isMention: boolean): MessageEventType {
    if (payload.content.startsWith("!")) return "command";
    if (isMention) return "mention";
    return "message";
  },
};
```

### Step 3: Register the Adapter

Edit `src/sources/types.ts`:

```typescript
import { discordAdapter } from "./discord";

export const sourceRegistry = new SourceRegistry();

// Register all adapters
sourceRegistry.register(discordAdapter);
```

### Step 4: Add Webhook Route

Edit `src/routes/webhook.ts`:

```typescript
import { sourceRegistry } from "../sources/types";

// Add new route
webhook.post("/discord", async (c) => {
  const adapter = sourceRegistry.get("discord");
  if (!adapter) {
    return c.json({ error: "Adapter not found" }, 500);
  }

  // Verify if adapter has verification
  if (adapter.verify) {
    const secret = c.env.DISCORD_WEBHOOK_SECRET;
    const isValid = adapter.verify(c.req.raw, secret);
    if (!isValid) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  const payload = await c.req.json();
  const event = adapter.normalize(payload);

  if (!event) {
    return c.json({ ok: true }); // Skip non-processable
  }

  // Rate limit by chat
  const allowed = await checkRateLimit(c.env.DB, event.chatId);
  if (!allowed) {
    return c.json({ ok: true });
  }

  // Process async
  c.executionCtx.waitUntil(
    ingestEvent(c.env, event).catch((err) => {
      logger.error("Discord ingestion error", { error: err.message });
    })
  );

  return c.json({ ok: true });
});
```

### Step 5: Handle Source-Specific Responses (Optional)

If the source supports sending responses (Discord, Slack), create a responder:

Create `src/responders/discord.ts`:

```typescript
export interface Responder {
  name: string;
  send(chatId: string, text: string): Promise<boolean>;
}

export const discordResponder: Responder = {
  name: "discord",

  async send(channelId: string, text: string): Promise<boolean> {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: text }),
      }
    );
    return response.ok;
  },
};
```

Update `src/pipeline/respond.ts` to route by source:

```typescript
import { discordResponder } from "../responders/discord";

async function sendResponseBySource(
  env: Env,
  source: Source,
  chatId: number,
  text: string
): Promise<boolean> {
  switch (source) {
    case "telegram":
      return sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, text);
    case "discord":
      return discordResponder.send(String(chatId), text);
    default:
      logger.warn("No responder for source", { source });
      return false;
  }
}
```

### Step 6: Add Secrets

Set required secrets:

```bash
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_WEBHOOK_SECRET
```

Update `src/types/env.ts`:

```typescript
export interface Env {
  // ... existing bindings ...
  DISCORD_BOT_TOKEN?: string;
  DISCORD_WEBHOOK_SECRET?: string;
}
```

### Step 7: Configure Webhook

Set the webhook URL with your source provider:

```bash
# Discord example
curl -X POST "https://discord.com/api/v10/applications/{app_id}/commands" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": 1,
    "name": "Interactions Endpoint URL",
    "url": "https://your-worker.workers.dev/webhook/discord"
  }'
```

## Adapter Implementation Checklist

- [ ] Define source-specific payload interface
- [ ] Implement `normalize()` returning `InternalEvent | null`
- [ ] Implement `verify()` if source requires webhook verification
- [ ] Handle ID mapping (source IDs may be strings, InternalEvent uses numbers)
- [ ] Map source "mention" concept to `isMention` boolean
- [ ] Handle bot detection (set `sender.isBot`)
- [ ] Parse timestamps to ISO format
- [ ] Add source to `Source` union type
- [ ] Register adapter in `SourceRegistry`
- [ ] Add webhook route
- [ ] Add responder if source supports sending messages
- [ ] Set required secrets
- [ ] Configure webhook URL with provider
- [ ] Test end-to-end

## Common Patterns

### ID Mapping

Some sources (Discord, Slack) use string IDs. Options:

1. **Hash to number** (simple, may collide):
   ```typescript
   id: payload.id.split('').reduce((a,b)=>a+b.charCodeAt(0),0)
   ```

2. **Store mapping table** (recommended):
   Add `source_mappings` table:
   ```sql
   CREATE TABLE source_mappings (
     source TEXT NOT NULL,
     external_id TEXT NOT NULL,
     internal_id INTEGER PRIMARY KEY AUTOINCREMENT,
     UNIQUE(source, external_id)
   );
   ```

3. **Use string IDs throughout** (requires schema change):
   Change `InternalEvent.chatId` from `number` to `string`.

### Rate Limiting

Rate limits should be per-chat per-source:

```typescript
// In rate-limiter.ts
async function checkRateLimit(
  db: D1Database,
  chatId: number,
  source: Source
): Promise<boolean> {
  // Query includes source filter
  const count = await db
    .prepare("SELECT COUNT(*) FROM active_messages WHERE chat_id = ? AND source = ? AND created_at > datetime('now', '-1 minute')")
    .bind(chatId, source)
    .first<number>();
  return count < RATE_LIMIT;
}
```

### Message Threading

If your source supports threads (Discord threads, Slack threads):

```typescript
interface InternalEvent {
  // ... existing fields ...
  threadId?: number; // Add to track conversation threads
}
```

Update schema:
```sql
ALTER TABLE active_messages ADD COLUMN thread_id INTEGER;
```

## Testing

### Unit Test Adapter

```typescript
// tests/sources/discord.test.ts
import { discordAdapter } from "../../src/sources/discord";

describe("discordAdapter", () => {
  it("normalizes a mention", () => {
    const payload = {
      id: "123456789",
      channel_id: "987654321",
      author: { id: "111", username: "testuser" },
      content: "Hello @bot",
      timestamp: "2024-01-01T00:00:00.000Z",
      mentions: [{ id: process.env.DISCORD_BOT_USER_ID }],
    };

    const event = discordAdapter.normalize(payload);

    expect(event).toMatchObject({
      source: "discord",
      isMention: true,
      type: "mention",
    });
  });
});
```

### Integration Test

```bash
# Send test webhook
curl -X POST "http://localhost:8787/webhook/discord" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "123",
    "channel_id": "456",
    "author": {"id": "789", "username": "test"},
    "content": "Test message",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "mentions": []
  }'
```

## Examples by Source Type

### Email (Cloudflare Email Workers)

```typescript
export const emailAdapter: SourceAdapter<EmailMessage> = {
  name: "email",

  normalize(payload: EmailMessage): InternalEvent | null {
    // Email doesn't have "mentions" — use subject line triggers
    const isMention = payload.subject.toLowerCase().includes("[support]");

    return {
      id: hashString(payload.messageId),
      source: "email",
      type: "message",
      chatId: hashString(payload.from), // Thread by sender
      messageId: hashString(payload.messageId),
      sender: {
        id: hashString(payload.from),
        isBot: false,
        name: payload.fromName || payload.from,
      },
      text: `Subject: ${payload.subject}\n\n${payload.text}`,
      isMention,
      timestamp: new Date().toISOString(),
    };
  },

  // No verification needed — handled by Cloudflare Email Routing
};
```

### Slack

```typescript
export const slackAdapter: SourceAdapter<SlackEvent> = {
  name: "slack",

  normalize(payload: SlackEvent): InternalEvent | null {
    // Skip bot messages
    if (payload.event.bot_id) return null;

    const isMention = payload.event.text.includes(`<@${process.env.SLACK_BOT_USER_ID}>`);

    return {
      id: parseInt(payload.event.ts.replace('.', '')),
      source: "slack",
      type: payload.event.text.startsWith('!') ? 'command' : isMention ? 'mention' : 'message',
      chatId: hashString(payload.event.channel),
      messageId: parseInt(payload.event.ts.replace('.', '')),
      sender: {
        id: hashString(payload.event.user),
        isBot: false,
        name: payload.event.user, // Fetch user info separately
      },
      text: payload.event.text,
      isMention,
      timestamp: new Date(parseFloat(payload.event.ts) * 1000).toISOString(),
    };
  },

  verify(request: Request, secret: string): boolean {
    // Slack signs requests with X-Slack-Signature
    const signature = request.headers.get("X-Slack-Signature");
    // ... HMAC verification
    return true;
  },
};
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| IDs overflow | Use string IDs or hash function |
| Verification fails | Check secret encoding, header names |
| Messages not processing | Ensure `normalize()` returns non-null |
| Rate limits hit | Add per-source rate limiting |
| Responses not sending | Check responder implementation |

## See Also

- `src/sources/types.ts` — Adapter interface definition
- `src/sources/telegram.ts` (future) — Reference adapter implementation
- `src/types/events.ts` — InternalEvent structure
- `src/pipeline/ingest.ts` — How events flow through the system
