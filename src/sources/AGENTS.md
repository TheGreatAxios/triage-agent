# Sources — Message Source Adapters

The system uses a **source-adapter pattern** to normalize messages from different platforms into a unified `InternalEvent`.

## Current State

**Only Telegram is implemented.** The normalizer is in `src/lib/normalizer.ts` (not yet extracted to `src/sources/telegram.ts`). The `types.ts` file defines the adapter interface for future sources.

## Files

- `types.ts` — `SourceAdapter` interface + `SourceRegistry`

## Adapter Interface

```typescript
interface SourceAdapter<T> {
  name: string;
  normalize(payload: T): InternalEvent | null;
  verify?(request: Request, secret: string): boolean;
  resolveEventType(payload: T, isMention: boolean): MessageEventType;
}
```

## Adding a New Source

### Step 1: Add Source to Type Union

Edit `src/types/events.ts`:
```typescript
export type Source = "telegram" | "discord" | "email" | "slack" | "api";
```

### Step 2: Create the Adapter

Create `src/sources/discord.ts` implementing `SourceAdapter`.

### Step 3: Add Webhook Route

Edit `src/routes/webhook.ts` — add a new POST handler for the source.

### Step 4: Handle Source-Specific Responses

Add a responder in `src/pipeline/respond.ts` if the source supports sending messages back.

### Step 5: Add Secrets & Env

```bash
bunx wrangler secret put DISCORD_BOT_TOKEN
```

Update `src/types/env.ts`.

## ID Mapping

Some sources (Discord, Slack) use string IDs. The current schema uses `INTEGER` for `telegram_chat_id` and `telegram_message_id`. Options for new sources:

1. **Hash to number** (simple, may collide)
2. **Store mapping table** (recommended):
   ```sql
   CREATE TABLE source_mappings (
     source TEXT NOT NULL,
     external_id TEXT NOT NULL,
     internal_id INTEGER PRIMARY KEY AUTOINCREMENT,
     UNIQUE(source, external_id)
   );
   ```
3. **Use string IDs throughout** (requires schema change)

## Design Decisions

### Why normalizer.ts isn't in sources/

Historical reasons — it was created before the source-adapter pattern was designed. It should be extracted to `src/sources/telegram.ts` when adding a second source. The TODO is in the file.

### Source field in active_messages

Every message has a `source` column (default `'telegram'`). This allows querying by source when multiple adapters exist.

## See Also

- `src/types/events.ts` — `InternalEvent` structure
- `src/lib/normalizer.ts` — Current Telegram normalizer
- `src/routes/AGENTS.md` — Webhook route setup
