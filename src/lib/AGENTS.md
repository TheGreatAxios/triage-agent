# lib — Core Library Modules

## Files

| File | Purpose |
|------|---------|
| `ai.ts` | AI provider routing — `TASK_MODELS` maps tasks to providers/models |
| `archiver.ts` | Archive overflow messages to R2, prune from D1 |
| `classifier.ts` | Rule-first classification + AI SDK model fallback |
| `config.ts` | App config + `evaluateResponsePolicy()` |
| `counters.ts` | Counter management (re-exports from `counters/`) |
| `drafter.ts` | AI draft generation + Telegram send + draft persistence |
| `escalation.ts` | Slack webhook escalation + escalation persistence |
| `linear.ts` | Linear GraphQL API — triage issue creation + D1 link persistence |
| `logger.ts` | Structured JSON logger (debug/info/warn/error) |
| `metrics.ts` | Pipeline timing + model usage structured logging |
| `normalizer.ts` | TelegramUpdate → InternalEvent |
| `persistence.ts` | D1 upsert for chats, participants, messages, classifications |
| `rate-limiter.ts` | Per-chat rate limiting via active_messages COUNT |
| `state.ts` | Conversation state + timer management |
| `summary.ts` | Chat summary generation (plain-text, AI placeholder) |
| `telegram.ts` | Webhook secret verification |
| `telegram-api.ts` | Telegram Bot API helpers |
| `approval.ts` | Chat approval system |
| `links.ts` | Link extraction utilities |
| `sanitize.ts` | Text sanitization |
| `errors.ts` | Error types |
| `slack.ts` | Slack notification helpers |
| `slack-blocks.ts` | Slack Block Kit builders |
| `team.ts` | Team management |
| `queries.ts` | D1 query helpers |

## Subdirectories

- `agent/` — Agent state management (archive, debounce, unified agent)
- `counters/` — Counter reconciliation and rollup
- `mcp/` — MCP registry, executor (see below)

## AI Provider Routing (`ai.ts`)

The `TASK_MODELS` map assigns each AI task to a provider + model:

```typescript
const TASK_MODELS: Record<AITask, ModelConfig> = {
  classify: { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
  draft:    { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
  summarize:{ provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
};
```

### Available Providers

| Provider | Setup Required | Best For |
|----------|---------------|----------|
| `workers-ai` | None (built-in) | Fast, cheap, no API key |
| `nvidia` | `NVIDIA_API_KEY` | High-quality drafts (free credits at build.nvidia.com) |
| `openai` | `OPENAI_API_KEY` | GPT-4 for complex classification |

### Switching Providers

Edit `TASK_MODELS` in `src/lib/ai.ts`. Set the corresponding secret:

```bash
npx wrangler secret put NVIDIA_API_KEY    # or OPENAI_API_KEY
```

### Common Routing Strategies

**Cost-optimized (default):** Workers AI for everything.
**Quality-optimized drafts:** Use NVIDIA/OpenAI for `draft` task, Workers AI for `classify` and `summarize`.
**Fallback chain:** Try cheap provider first, fallback to expensive on failure.

### Adding a New Provider

1. Add to `AIProvider` type union in `ai.ts`
2. Add case to `resolveModel()` with API config
3. Add secret to `src/types/env.ts` and set via `wrangler secret put`
4. Use in `TASK_MODELS`

**Provider-specific models:**
- Workers AI: `@cf/meta/llama-3.1-8b-instruct`, `@cf/meta/llama-3.3-70b-instruct`
- NVIDIA: `meta/llama-3.3-70b-instruct`, `meta/llama-3.1-405b-instruct`
- OpenAI: `gpt-4o`, `gpt-4o-mini`

### Monitoring

Model selection is logged automatically. Check via `wrangler tail`.

## Config (`config.ts`)

| Setting | Value | Purpose |
|---------|-------|---------|
| `noResponseDelaySeconds` | 30 | Timer delay before auto-draft |
| `escalationThreshold` | 0.4 | Below this → escalate to Slack |
| `autoSendThreshold` | 0.85 | Above this → auto-send if label in `autoSendLabels` |
| `maxHotMessages` | 200 | Per-chat message limit before R2 archival |
| `summaryMaxAgeMinutes` | 30 | Summary cache TTL |
| `autoSendLabels` | `["normal"]` | Only "normal" messages auto-send |

## MCP Registry (`mcp/`)

Dynamic MCP server registry for tool execution. D1-backed configuration with R2-cached results.

### Architecture

```
D1 (mcp_servers, mcp_tools) → MCP Loader → Tool Executor → R2 (24h cache)
```

### Adding MCPs via SQL

No migration required — insert directly into D1:

```sql
INSERT INTO mcp_servers (project_id, name, transport, connection_config, auth_config, enabled)
VALUES ('default', 'my-api', 'http', '{"baseUrl":"https://api.example.com","timeoutMs":30000}', NULL, 1);

INSERT INTO mcp_tools (server_id, name, description, parameters_schema, enabled)
SELECT id, 'search', 'Search the API', '{"type":"object","properties":{"q":{"type":"string"}}}', 1
FROM mcp_servers WHERE name = 'my-api';
```

### Tool Execution Flow

1. Classifier detects tool need
2. Drafter calls `MCPRegistry.executeTool(projectId, toolName, params)`
3. Check R2 cache (SHA-256 key), execute HTTP if miss
4. Retry: 3 attempts, exponential backoff (100ms, 200ms, 400ms)
5. Cache result in R2 (24h TTL) + log to `tool_executions`

### Tool Quality Assessment

| Quality | Criteria | Usage |
|---------|----------|-------|
| **high** | Result > 500 chars, no errors | Full confidence |
| **medium** | Result 50-500 chars, no errors | Standard confidence |
| **low** | Result < 50 chars or contains "error" | Reduced confidence |
| **none** | No result or execution failed | Don't include in AI context |

### Connection Config

```json
{ "baseUrl": "https://api.example.com", "timeoutMs": 30000, "headers": {} }
```

### Auth Config

```json
// Bearer token from env var
{"type": "bearer", "token_env": "API_TOKEN"}
// Static header
{"type": "header", "header_name": "X-API-Key", "value_env": "API_KEY"}
```

## See Also

- `src/pipeline/AGENTS.md` — Pipeline flow, response policy, debugging
- `src/routes/AGENTS.md` — Webhook setup & troubleshooting
- `src/types/AGENTS.md` — Type system guide
