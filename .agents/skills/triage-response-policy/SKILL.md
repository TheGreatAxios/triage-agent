# Skill: Triage Response Policy

Tune the classification → response pipeline: thresholds, auto-send rules, and custom policy logic.

## Overview

The response policy determines what happens after a message is classified:

```
Classification (label + confidence)
           │
           ▼
    ┌──────────────┐
    │ Policy Engine │
    └──────────────┘
           │
     ┌─────┼─────┐
     ▼     ▼     ▼
 auto_send  draft_only  escalate
    │         │          │
    ▼         ▼          ▼
 Telegram   D1 only    Slack + draft
```

## Configuration File

All policy settings are in `src/lib/config.ts`:

```typescript
export interface AppConfig {
  noResponseDelaySeconds: number;  // Timer before auto-draft
  escalationThreshold: number;      // Below this → escalate
  autoSendThreshold: number;        // Above this → auto-send
  maxHotMessages: number;           // Per-chat message limit
  summaryMaxAgeMinutes: number;       // Summary cache TTL
  autoSendLabels: ClassificationLabel[];  // Labels safe for auto-send
}
```

## Current Defaults

```typescript
{
  noResponseDelaySeconds: 30,    // Wait 30s before drafting if no human responds
  escalationThreshold: 0.4,      // <40% confidence → escalate to Slack
  autoSendThreshold: 0.85,       // ≥85% confidence → consider auto-send
  maxHotMessages: 200,           // Keep 200 messages in D1 per chat
  summaryMaxAgeMinutes: 30,      // Refresh summary every 30 min
  autoSendLabels: ["normal"],    // Only "normal" messages auto-send
}
```

## Policy Decision Logic

From `src/lib/config.ts`:

```typescript
if (label === "unknown" || confidence < escalationThreshold) {
  return { action: "escalate", ... };
}

if (confidence >= autoSendThreshold && autoSendLabels.includes(label)) {
  return { action: "auto_send", ... };
}

return { action: "draft_only", ... };
```

## Common Tuning Scenarios

### Scenario 1: More Aggressive Auto-Send

Lower the threshold and add more labels:

```typescript
export const defaultConfig: AppConfig = {
  ...
  autoSendThreshold: 0.75,              // Was 0.85
  autoSendLabels: ["normal", "request"], // Added "request"
};
```

**Risk:** More false positives. Monitor escalation rate.

### Scenario 2: Never Auto-Send (Draft-Only Mode)

Remove all auto-send labels:

```typescript
autoSendLabels: [],  // Empty array = never auto-send
```

**Use case:** High-stakes support where every response needs human review.

### Scenario 3: Lower Escalation Threshold

Be more conservative about escalating to Slack:

```typescript
escalationThreshold: 0.25,  // Was 0.4
```

**Effect:** More messages stay in "draft_only" instead of escalating.

### Scenario 4: VIP User Bypass

Add custom logic for specific users:

```typescript
// In src/lib/config.ts
export function evaluateResponsePolicy(
  confidence: number,
  label: ClassificationLabel,
  senderId?: number  // Add optional sender param
): { action: ResponseAction; reason: string } {
  const config = getConfig();

  // VIP users: always escalate regardless of confidence
  const VIP_USER_IDS = [123456789, 987654321];
  if (senderId && VIP_USER_IDS.includes(senderId)) {
    return {
      action: "escalate",
      reason: "VIP user - requires human attention",
    };
  }

  // ... rest of existing logic
}
```

Update call sites in `src/pipeline/respond.ts`:

```typescript
const policy = evaluateResponsePolicy(
  classification.confidence,
  classification.label,
  event.sender.id  // Pass sender ID
);
```

### Scenario 5: Time-Based Policy

Different rules during business hours vs nights/weekends:

```typescript
export function evaluateResponsePolicy(
  confidence: number,
  label: ClassificationLabel
): { action: ResponseAction; reason: string } {
  const config = getConfig();
  const hour = new Date().getUTCHours();
  const isBusinessHours = hour >= 9 && hour < 17;

  // After hours: never auto-send, always draft or escalate
  if (!isBusinessHours && label !== "normal") {
    return {
      action: "escalate",
      reason: "After hours - requires human attention",
    };
  }

  // ... rest of existing logic
}
```

### Scenario 6: Label-Specific Thresholds

Different confidence thresholds per label:

```typescript
const LABEL_THRESHOLDS: Record<ClassificationLabel, number> = {
  bug: 0.9,      // High confidence required for bugs
  request: 0.8,
  normal: 0.75,
  unknown: 1.0,  // Never auto-send unknown
};

export function evaluateResponsePolicy(
  confidence: number,
  label: ClassificationLabel
): { action: ResponseAction; reason: string } {
  const threshold = LABEL_THRESHOLDS[label];

  if (confidence >= threshold && label !== "unknown") {
    return { action: "auto_send", ... };
  }

  // ... rest of logic
}
```

## Adding New Classification Labels

### Step 1: Update Type Definition

Edit `src/types/classification.ts`:

```typescript
export type ClassificationLabel = "bug" | "request" | "normal" | "unknown" | "spam";
```

### Step 2: Add Classification Rules

Edit `src/lib/classifier.ts`:

```typescript
const RULES: Rule[] = [
  // ... existing rules ...
  {
    label: "spam",
    patterns: [
      /\b(buy now|click here|limited time|act now|free money)\b/i,
      /\b(crypto|investment|guaranteed|100% free)\b.*\b(http|www)\b/i,
    ],
    confidence: 0.9,
    reasoning: "Message contains spam indicators",
  },
];
```

### Step 3: Update Model Prompt

Edit `src/lib/classifier.ts`:

```typescript
const CLASSIFICATION_PROMPT = `Classify this message into exactly one category.

Categories:
- bug: Reports of errors, crashes, broken functionality
- request: Feature requests, enhancement suggestions
- normal: General conversation, greetings, questions
- spam: Promotional content, scams, unsolicited links

Respond with ONLY a JSON object...`;
```

### Step 4: Set Policy for New Label

Edit `src/lib/config.ts`:

```typescript
autoSendLabels: ["normal"],  // "spam" not included = never auto-send
```

Or add custom handling:

```typescript
if (label === "spam") {
  return {
    action: "escalate",
    reason: "Potential spam - requires moderation",
  };
}
```

## Monitoring Policy Performance

### Key Metrics to Track

| Metric | How to Check | Target |
|--------|--------------|--------|
| Auto-send rate | `SELECT COUNT(*) FROM drafts WHERE status = 'sent'` | <20% (conservative) |
| Escalation rate | `SELECT COUNT(*) FROM escalations` | <30% |
| Draft-only rate | Remainder | ~50% |
| False positive rate | Manual review of auto-sends | <5% |

### Query Examples

```sql
-- Auto-send rate by day
SELECT 
  date(created_at) as day,
  COUNT(*) as total,
  SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as auto_sent,
  ROUND(100.0 * SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) / COUNT(*), 2) as auto_send_pct
FROM drafts
GROUP BY day
ORDER BY day DESC;

-- Escalation reasons
SELECT reason, COUNT(*) as count
FROM drafts
WHERE status = 'escalated'
GROUP BY reason
ORDER BY count DESC;
```

## Testing Policy Changes

### Unit Test

```typescript
// tests/lib/config.test.ts
import { evaluateResponsePolicy } from "../../src/lib/config";

describe("evaluateResponsePolicy", () => {
  it("escalates low confidence", () => {
    const result = evaluateResponsePolicy(0.3, "normal");
    expect(result.action).toBe("escalate");
  });

  it("auto-sends high confidence normal", () => {
    const result = evaluateResponsePolicy(0.9, "normal");
    expect(result.action).toBe("auto_send");
  });

  it("does not auto-send bugs even with high confidence", () => {
    const result = evaluateResponsePolicy(0.95, "bug");
    expect(result.action).toBe("draft_only");
  });
});
```

### Manual Test

```bash
# Trigger a classification via curl
curl -X POST "http://localhost:8787/webhook/telegram" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  -d '{
    "update_id": 999999,
    "message": {
      "message_id": 123,
      "from": {"id": 456, "is_bot": false, "first_name": "Test"},
      "chat": {"id": 789, "type": "group"},
      "date": '$(date +%s)',
      "text": "This is broken, please fix it",
      "entities": [{"type": "mention", "offset": 0, "length": 4}]
    }
  }'

# Check what action was taken
npx wrangler d1 execute telegram-agent-db --local --command "SELECT * FROM drafts ORDER BY id DESC LIMIT 1"
```

## Rollback Strategy

Policy changes are code changes — rollback by reverting `src/lib/config.ts`:

```bash
git checkout src/lib/config.ts
bun run deploy
```

For dynamic configuration (future enhancement), consider:

```typescript
// Load from environment or D1
export function getConfig(): AppConfig {
  return {
    autoSendThreshold: parseFloat(process.env.AUTO_SEND_THRESHOLD ?? "0.85"),
    // ...
  };
}
```

## See Also

- `src/lib/config.ts` — Policy implementation
- `src/lib/classifier.ts` — Classification rules
- `src/pipeline/respond.ts` — Policy evaluation call site
- `src/types/classification.ts` — Label type definitions
