# Sources — Message Source Adapters

The system uses a **source-adapter pattern** to normalize messages from different platforms into a unified `InternalEvent`:

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Source    │────▶│   Adapter    │────▶│  InternalEvent  │
│ (Telegram,  │     │ (normalize,  │     │  (universal)    │
│  Discord,   │     │  verify)     │     │                 │
│  Email...)  │     │              │     │                 │
└─────────────┘     └──────────────┘     └─────────────────┘
```

The core pipeline (`ingest.ts`, `classifier.ts`, `respond.ts`) is source-agnostic. Each source only needs:
1. An adapter that converts source payloads to `InternalEvent`
2. A webhook route that uses the adapter
3. (Optional) A responder for sending messages back to the source

## Files

- `types.ts` — `SourceAdapter` interface + `SourceRegistry`

## Adding a New Source

### Step 1: Add Source to Type Union

Edit `src/types/events.ts`:

```typescript
export type Source = "telegram" | "email" | "slack" | "api" | "discord";
```

### Step 2: Create the Adapter

Create `src/sources/discord.ts` (example):

```typescript
import type { SourceAdapter } from "./types";
import type { InternalEvent, MessageEventType } from "../types/events";

interface DiscordMessage {
  id: string;
  channel_id: string;
  author: { id: string; username: string; bot?: boolean };
  content: string;
  timestamp: string;
  mentions: Array<{ id: string }>;
}

export const discordAdapter: SourceAdapter<DiscordMessage> = {
  name: "discord",

  normalize(payload: DiscordMessage): InternalEvent | null {
    if (!payload.content) return null;
    const isMention = payload.mentions.some(m => m.id === process.env.DISCORD_BOT_USER_ID);
    return {
      id: parseInt(payload.id),
      source: "discord",
      type: this.resolveEventType(payload, isMention),
      chatId: parseInt(payload.channel_id),
      messageId: parseInt(payload.id),
      sender: { id: parseInt(payload.author.id), isBot: payload.author.bot ?? false, name: payload.author.username },
      text: payload.content,
      isMention,
      timestamp: payload.timestamp,
    };
  },

  verify(request: Request, secret: string): boolean {
    const signature = request.headers.get("X-Signature-Ed25519");
    // ... verification logic
    return true;
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
sourceRegistry.register(discordAdapter);
```

### Step 4: Add Webhook Route

Edit `src/routes/webhook.ts`:

```typescript
webhook.post("/discord", async (c) => {
  const adapter = sourceRegistry.get("discord");
  if (!adapter) return c.json({ error: "Adapter not found" }, 500);

  if (adapter.verify) {
    const isValid = adapter.verify(c.req.raw, c.env.DISCORD_WEBHOOK_SECRET);
    if (!isValid) return c.json({ error: "Unauthorized" }, 401);
  }

  const payload = await c.req.json();
  const event = adapter.normalize(payload);
  if (!event) return c.json({ ok: true });

  const allowed = await checkRateLimit(c.env.DB, event.chatId);
  if (!allowed) return c.json({ ok: true });

  c.executionCtx.waitUntil(ingestEvent(c.env, event));
  return c.json({ ok: true });
});
```

### Step 5: Handle Source-Specific Responses

If the source supports sending responses, add a responder and route by source in `src/pipeline/respond.ts`:

```typescript
async function sendResponseBySource(env: Env, source: Source, chatId: number, text: string): Promise<boolean> {
  switch (source) {
    case "telegram": return sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, text);
    case "discord":  return discordResponder.send(String(chatId), text);
    default:
      logger.warn("No responder for source", { source });
      return false;
  }
}
```

### Step 6: Add Secrets & Env

```bash
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_WEBHOOK_SECRET
```

Update `src/types/env.ts`:
```typescript
DISCORD_BOT_TOKEN?: string;
DISCORD_WEBHOOK_SECRET?: string;
```

## Adapter Implementation Checklist

- [ ] Define source-specific payload interface
- [ ] Implement `normalize()` returning `InternalEvent | null`
- [ ] Implement `verify()` if source requires webhook verification
- [ ] Handle ID mapping (source IDs may be strings; `InternalEvent` uses numbers)
- [ ] Map source "mention" concept to `isMention` boolean
- [ ] Handle bot detection (set `sender.isBot`)
- [ ] Parse timestamps to ISO format
- [ ] Add source to `Source` union type in `src/types/events.ts`
- [ ] Register adapter in `SourceRegistry`
- [ ] Add webhook route in `src/routes/webhook.ts`
- [ ] Add responder if source supports sending messages
- [ ] Set required secrets
- [ ] Configure webhook URL with provider

## ID Mapping Patterns

Some sources (Discord, Slack) use string IDs. Options:

1. **Hash to number** (simple, may collide):
   ```typescript
   id: payload.id.split('').reduce((a,b) => a + b.charCodeAt(0), 0)
   ```
2. **Store mapping table** (recommended):
   ```sql
   CREATE TABLE source_mappings (
     source TEXT NOT NULL,
     external_id TEXT NOT NULL,
     internal_id INTEGER PRIMARY KEY AUTOINCREMENT,
     UNIQUE(source, external_id)
   );
   ```
3. **Use string IDs throughout** (requires schema change to `InternalEvent.chatId`)

## See Also

- `src/sources/types.ts` — Adapter interface definition
- `src/types/events.ts` — `InternalEvent` structure
- `src/pipeline/ingest.ts` — How events flow through the system
- `src/routes/AGENTS.md` — Webhook route setup
