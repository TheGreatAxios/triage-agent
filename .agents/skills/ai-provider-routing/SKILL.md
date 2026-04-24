# Skill: AI Provider Routing

Route AI tasks (classify, draft, summarize) to different providers and models. Mix and match for cost/performance optimization.

## Architecture

The system uses a task-based routing model:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────┐
│   Task      │────▶│  TASK_MODELS│────▶│    Provider     │
│ (classify)  │     │   config     │     │ (Workers AI,    │
│ (draft)     │     │              │     │  OpenAI, etc)   │
│ (summarize) │     │              │     │                 │
└─────────────┘     └─────────────┘     └─────────────────┘
```

## Current Configuration

From `src/lib/ai.ts`:

```typescript
const TASK_MODELS: Record<AITask, ModelConfig> = {
  classify: {
    provider: "workers-ai",
    model: "@cf/meta/llama-3.1-8b-instruct",
  },
  draft: {
    provider: "workers-ai",
    model: "@cf/meta/llama-3.1-8b-instruct",
  },
  summarize: {
    provider: "workers-ai",
    model: "@cf/meta/llama-3.1-8b-instruct",
  },
};
```

## Available Providers

| Provider | Setup Required | Best For |
|----------|---------------|----------|
| `workers-ai` | None (built-in) | Fast, cheap, no API key |
| `nvidia` | `NVIDIA_API_KEY` | High-quality drafts |
| `openai` | `OPENAI_API_KEY` | GPT-4 for complex classification |
| `openrouter` | `OPENROUTER_API_KEY` | Access to many models |

## Common Routing Strategies

### Strategy 1: Cost-Optimized (Default)

Use Workers AI for everything (current setup):

```typescript
const TASK_MODELS: Record<AITask, ModelConfig> = {
  classify: { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
  draft:    { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
  summarize:{ provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
};
```

**Pros:** Free tier, no latency to external APIs, simple
**Cons:** Smaller models, less capable for complex tasks

### Strategy 2: Quality-Optimized Drafts

Use NVIDIA NIM for drafts, Workers AI for the rest:

```typescript
const TASK_MODELS: Record<AITask, ModelConfig> = {
  classify: { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
  draft:    { provider: "nvidia",     model: "meta/llama-3.3-70b-instruct" },
  summarize:{ provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
};
```

**Pros:** Better response quality where it matters
**Cons:** External API latency, NVIDIA credits needed

Set the secret:
```bash
npx wrangler secret put NVIDIA_API_KEY
```

### Strategy 3: Smart Fallback Chain

Try cheap provider first, fallback to expensive on failure:

```typescript
// In src/lib/ai.ts
export async function getModelWithFallback(
  env: Env,
  task: AITask
): Promise<LanguageModel> {
  const config = TASK_MODELS[task];

  try {
    return resolveModel(env, config.provider, config.model);
  } catch (err) {
    logger.warn("Primary provider failed, trying fallback", {
      task,
      primary: config.provider,
      error: err.message,
    });

    // Fallback chain
    const fallbacks: ModelConfig[] = [
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
    ];

    for (const fallback of fallbacks) {
      try {
        return resolveModel(env, fallback.provider, fallback.model);
      } catch (e) {
        continue;
      }
    }

    throw new Error("All AI providers failed");
  }
}
```

### Strategy 4: Task-Specific Models

Different models per task type:

```typescript
const TASK_MODELS: Record<AITask, ModelConfig> = {
  // Fast, cheap classification
  classify: {
    provider: "workers-ai",
    model: "@cf/meta/llama-3.1-8b-instruct",
  },

  // High-quality drafts for user-facing responses
  draft: {
    provider: "openai",
    model: "gpt-4o",  // Best quality
  },

  // Summarization can use smaller model
  summarize: {
    provider: "openai",
    model: "gpt-4o-mini",  // Cheaper, still capable
  },
};
```

### Strategy 5: Dynamic Provider Selection

Choose provider based on message complexity:

```typescript
// In src/lib/ai.ts
export function getModelForTask(
  env: Env,
  task: AITask,
  complexity?: "low" | "medium" | "high"
): LanguageModel {
  // Override based on complexity
  if (task === "draft" && complexity === "high") {
    return resolveModel(env, "openai", "gpt-4o");
  }

  // Default from TASK_MODELS
  const config = TASK_MODELS[task];
  return resolveModel(env, config.provider, config.model);
}
```

Use in `src/lib/drafter.ts`:

```typescript
const complexity = estimateComplexity(context);
const model = getModelForTask(env, "draft", complexity);
```

## Adding a New Provider

### Step 1: Add to AIProvider Type

Edit `src/lib/ai.ts`:

```typescript
export type AIProvider = "workers-ai" | "nvidia" | "openai" | "openrouter" | "groq";
```

### Step 2: Implement Provider Resolution

Add case to `resolveModel()`:

```typescript
case "groq": {
  const groq = createOpenAICompatible({
    name: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
  });
  return groq.chatModel(model);
}
```

### Step 3: Add Secret

Edit `src/types/env.ts`:

```typescript
export interface Env {
  // ... existing secrets ...
  GROQ_API_KEY?: string;
}
```

Set the secret:

```bash
npx wrangler secret put GROQ_API_KEY
```

### Step 4: Use in TASK_MODELS

```typescript
const TASK_MODELS: Record<AITask, ModelConfig> = {
  classify: { provider: "groq", model: "llama-3.1-8b-instant" },
  // ...
};
```

## Provider-Specific Configuration

### Workers AI

No configuration needed — uses `env.AI` binding.

Available models: https://developers.cloudflare.com/workers-ai/models/

Popular choices:
- `@cf/meta/llama-3.1-8b-instruct` — Fast, capable
- `@cf/meta/llama-3.3-70b-instruct` — Larger, slower
- `@cf/mistral/mistral-7b-instruct-v0.2` — Good for classification

### NVIDIA NIM

Get free credits at https://build.nvidia.com

Popular models:
- `meta/llama-3.3-70b-instruct` — High quality
- `meta/llama-3.1-405b-instruct` — Best quality, slower

### OpenAI

Set `OPENAI_API_KEY` via wrangler secret.

Popular models:
- `gpt-4o` — Best quality, expensive
- `gpt-4o-mini` — Good balance
- `gpt-3.5-turbo` — Fast, cheap

### OpenRouter

Set `OPENROUTER_API_KEY`. Access to 100+ models.

Popular models:
- `anthropic/claude-3.5-sonnet` — Best for complex tasks
- `google/gemini-1.5-flash` — Fast, cheap
- `meta-llama/llama-3.3-70b-instruct` — Good open model

## Monitoring Provider Performance

### Track by Provider

Add provider to metrics in `src/lib/ai.ts`:

```typescript
export function getModel(env: Env, task: AITask): LanguageModel {
  const config = TASK_MODELS[task];

  logger.info("AI model selected", {
    task,
    provider: config.provider,
    model: config.model,
  });

  return resolveModel(env, config.provider, config.model);
}
```

### Query Usage by Provider

```sql
-- If you add provider column to metrics table
SELECT provider, task, COUNT(*), AVG(duration_ms)
FROM pipeline_metrics
WHERE stage = 'classify' OR stage = 'draft'
GROUP BY provider, task;
```

## Cost Optimization

### Estimate Costs Per Task

| Provider | Model | Input/1M tokens | Output/1M tokens |
|----------|-------|-----------------|------------------|
| Workers AI | llama-3.1-8b | Free tier | Free tier |
| OpenAI | gpt-4o-mini | $0.15 | $0.60 |
| OpenAI | gpt-4o | $2.50 | $10.00 |
| NVIDIA | llama-3.3-70b | ~$0.20 | ~$0.60 |

### Cost-Aware Routing

Route cheap messages to cheap providers:

```typescript
function selectProviderForMessage(
  env: Env,
  task: AITask,
  messageText: string
): ModelConfig {
  // Short messages → cheap provider
  if (messageText.length < 100) {
    return { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" };
  }

  // Long/complex messages → quality provider
  return TASK_MODELS[task];
}
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Provider timeout | Add timeout wrapper, fallback to Workers AI |
| Rate limited | Implement retry with exponential backoff |
| Model not found | Check model name spelling, provider docs |
| Auth error | Verify secret is set: `wrangler secret list` |
| Unexpected responses | Check prompt formatting for provider |

## Testing Provider Changes

### Manual Test

```bash
# Test classification
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
      "text": "This is a test message for classification",
      "entities": [{"type": "mention", "offset": 0, "length": 4}]
    }
  }'

# Check logs for provider selection
npx wrangler tail
```

## See Also

- `src/lib/ai.ts` — Provider routing implementation
- `src/lib/classifier.ts` — Classification task
- `src/lib/drafter.ts` — Draft generation task
- `src/lib/summary.ts` — Summarization task
