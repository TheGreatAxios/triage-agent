# types — TypeScript Type Definitions

All complex types are defined here — never inline them in implementation files.

## Files

| File | Key Types | Purpose |
|------|-----------|---------|
| `classification.ts` | `ClassificationLabel`, `ClassificationResult`, `TriageResult`, `TriageAction` | Classification + triage output |
| `draft.ts` | `ResponseAction`, `Draft`, `DraftStatus`, `PolicyDecision` | Draft response lifecycle |
| `env.ts` | `Env` (bindings), `AppEnv` (Hono generic) | Environment bindings & secrets |
| `escalation.ts` | `EscalationStatus`, `Escalation` | Escalation tracking |
| `events.ts` | `InternalEvent`, `MessageEventType`, `Source` | Unified event model |
| `telegram.ts` | `TelegramUpdate`, `TelegramMessage`, etc. | Telegram Bot API subset |
| `approval.ts` | `PendingApproval`, `ApprovalDecision`, `ComplexityFactors`, etc. | Chat approval system |
| `team.ts` | `StaleChat`, team metrics types | Team management |

## Core Types

### InternalEvent

The universal event that all source adapters normalize to. Every pipeline stage operates on this type.

```typescript
interface InternalEvent {
  id: number;           // Source-specific update ID
  source: Source;       // "telegram" | "email" | "slack" | "api"
  type: MessageEventType; // "message" | "edit" | "command" | "mention"
  chatId: number;       // Source-specific chat ID (Telegram: negative for groups)
  messageId: number;    // Source-specific message ID
  sender: {
    id: number;
    isBot: boolean;
    name: string;
    username?: string;  // Optional — not all sources provide this
  };
  text: string;
  isMention: boolean;
  timestamp: string;    // ISO format
}
```

**Important:** `chatId` in `InternalEvent` is the **source-specific** ID (e.g., Telegram's `chat.id`). This is NOT the internal D1 `chats.id`. The mapping happens in `persistEvent()`.

### TriageResult

Single-call triage output from `classifier.ts`. Combines classification + action + draft in one LLM call.

```typescript
interface TriageResult {
  label: ClassificationLabel;  // "bug" | "request" | "normal" | "unknown"
  confidence: number;          // 0–1 classification confidence
  method: ClassificationMethod; // "rule" | "model" | "fallback"
  reasoning: string;
  action: TriageAction;        // "auto_send" | "escalate" | "draft_only" | "defer"
  draft: string | null;        // Null when action is "defer"
  draftConfidence: number | null; // AI self-assessment of draft quality
}
```

### Env

All Cloudflare bindings and secrets. **Keep in sync with `wrangler.jsonc`.**

```typescript
interface Env {
  DB: D1Database;          // Required
  AI: Ai;                  // Required — Workers AI binding
  ARCHIVE: R2Bucket;       // Required — conversation archives
  KNOWLEDGE_CACHE: R2Bucket; // Required — MCP tool result cache
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  SLACK_WEBHOOK_URL: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_APPROVAL_CHANNEL_ID: string;
  SLACK_SUMMARY_CHANNEL_ID: string;
  COMMUNITY_NAME: string;  // Used in AI prompts
  DOCS_URL: string;        // Used in AI prompts
  // ... optional AI provider keys, Linear, Notion, MCP keys
}
```

## Design Decisions

### `Source` type includes unused values

`Source = "telegram" | "email" | "slack" | "api"` — only `telegram` is implemented. The others are placeholder types for future source adapters. See `src/sources/AGENTS.md` for the adapter pattern.

### `ClassificationMethod` includes `"rule"` but rules are removed

The old rule-based classifier was replaced by the single-call triage model. The `"rule"` and `"fallback"` values still exist in the type for backward compatibility with existing D1 rows.

### `TriageAction` includes `"defer"`

The LLM can return `"defer"` to skip draft generation entirely (for acknowledgments, test messages, etc.). The code checks for this and skips the draft entirely.

## Type Alignment with D1

TypeScript interfaces must reflect actual D1 column types:
- Nullable columns → `field: type | null` in TypeScript
- New columns → Must update both migration AND type definition
- Column removals → Update type AND all queries referencing it
- Integer booleans → D1 uses `INTEGER` (0/1), TypeScript uses `boolean` — convert with `=== 1`

**After changing `wrangler.jsonc` bindings:** Run `wrangler types` to regenerate TypeScript bindings. Keep `Env` in sync.

## Conventions

- **Never inline complex types** — Define them here
- **Import from `src/types/`** — `import type { X } from "../types/y"`
- **Keep in sync with D1** — See `migrations/AGENTS.md` for schema change protocol
- **Use `type` imports** — `import type { X }` for type-only imports

## See Also

- `migrations/AGENTS.md` — Schema change protocol
- `src/lib/AGENTS.md` — Library modules that consume these types
