# types — TypeScript Type Definitions

All complex types are defined here — never inline them in implementation files.

## Files

| File | Key Types | Purpose |
|------|-----------|---------|
| `classification.ts` | `ClassificationLabel`, `ClassificationResult` | Message classification output |
| `draft.ts` | `ResponseAction`, `Draft`, `DraftStatus`, `PolicyDecision` | Draft response lifecycle |
| `env.ts` | `Env` (bindings), `AppEnv` (Hono generic) | Environment bindings & secrets |
| `escalation.ts` | `EscalationStatus`, `Escalation` | Escalation tracking |
| `events.ts` | `InternalEvent`, `MessageEventType`, `Source` | Unified event model (source-agnostic) |
| `telegram.ts` | `TelegramUpdate`, `TelegramMessage`, etc. | Telegram Bot API subset |
| `agent.ts` | Agent-related types | Agent state management |
| `approval.ts` | Approval types | Chat approval system |
| `team.ts` | Team types | Team management |

## Core Type: InternalEvent

The universal event type that all source adapters normalize to:

```typescript
interface InternalEvent {
  id: number;
  source: Source;          // "telegram" | "discord" | "email" | ...
  type: MessageEventType;  // "message" | "mention" | "command" | "edited"
  chatId: number;
  messageId: number;
  sender: {
    id: number;
    isBot: boolean;
    name: string;
  };
  text: string;
  isMention: boolean;
  timestamp: string;       // ISO format
}
```

## Core Type: ClassificationLabel

```typescript
type ClassificationLabel = "bug" | "request" | "normal" | "unknown";
```

To add a new label:
1. Update this type
2. Add rules in `src/lib/classifier.ts`
3. Update model prompt
4. Set policy in `src/lib/config.ts`

## Core Type: ResponseAction

```typescript
type ResponseAction = "auto_send" | "escalate" | "draft_only";
```

Determined by `evaluateResponsePolicy()` in `src/lib/config.ts`.

## Core Type: Env

All bindings and secrets. Update when adding new D1 databases, R2 buckets, secrets, or bindings:

```typescript
interface Env {
  DB: D1Database;
  AI: any;                    // Workers AI binding
  ARCHIVE: R2Bucket;
  KNOWLEDGE_CACHE: R2Bucket;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  SLACK_WEBHOOK_URL: string;
  // Slack Approval Flow
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_APPROVAL_CHANNEL_ID: string;
  SLACK_SUMMARY_CHANNEL_ID: string;
  // Linear
  LINEAR_API_KEY: string;
  LINEAR_TEAM_ID: string;
  LINEAR_PROJECT_ID?: string;
  LINEAR_TRIAGE_STATE_ID: string;
  LINEAR_LABEL_BUG?: string;
  LINEAR_LABEL_REQUEST?: string;
  // Optional AI providers
  NVIDIA_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  GROQ_API_KEY?: string;
  XAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  // Observability
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  // MCP Tools
  PARALLEL_API_KEY?: string;
  CONTEXT7_API_KEY?: string;
}
```

**Important:** After changing `wrangler.jsonc` bindings, run `wrangler types` to regenerate TypeScript bindings. Keep `Env` in sync.

## Type Alignment with D1

TypeScript interfaces must reflect actual D1 column types:
- Nullable columns → `field: type | null` in TypeScript
- New columns → Must update both migration AND type definition
- Column removals → Update type AND all queries referencing it

## Conventions

- **Never inline complex types** — Define them in the appropriate file here
- **Import from `src/types/`** — `import type { ClassificationLabel } from "../types/classification"`
- **Keep in sync with D1** — See `migrations/AGENTS.md` for schema change protocol
