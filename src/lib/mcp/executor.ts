/**
 * MCP Tool Executor - Parallel execution with caching
 */
import type { Env } from "../../types/env";
import type { MCPServerConfig, ToolResult } from "./registry";
import { logger } from "../logger";

const DEFAULT_TIMEOUTS: Record<string, number> = {
  parallel: 5000,
  context7: 5000,
};

/**
 * Execute all MCP tools in parallel with appropriate timeouts
 */
export async function executeTools(
  env: Env,
  configs: MCPServerConfig[],
  query: string
): Promise<ToolResult[]> {
  if (configs.length === 0) return [];

  const promises = configs.map((config) =>
    executeSingleTool(env, config, query).then((result) => ({
      ...result,
      tool: config.name,
    }))
  );

  // Execute all in parallel, handle individual failures
  const results = await Promise.allSettled(promises);

  return results
    .filter((r): r is PromiseFulfilledResult<ToolResult> => r.status === "fulfilled")
    .map((r) => r.value);
}

async function executeSingleTool(
  env: Env,
  config: MCPServerConfig,
  query: string
): Promise<ToolResult> {
  const timeout = config.config.timeout || DEFAULT_TIMEOUTS[config.name] || 5000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const startTime = Date.now();

  try {
    // Check cache first (external knowledge only)
    const cacheKey = `knowledge/${config.name}/${hashQuery(query)}`;
    const cached = await env.KNOWLEDGE_CACHE?.get(cacheKey);
    if (cached) {
      const body = await cached.text();
      return {
        tool: config.name,
        result: JSON.parse(body),
        fromCache: true,
        quality: "high",
      };
    }

    // Get auth token if configured
    let authHeader: string | undefined;
    if (config.config.authEnvVar) {
      const token = env[config.config.authEnvVar as keyof Env] as string | undefined;
      if (token) {
        authHeader = `Bearer ${token}`;
      }
    }

    // Execute based on type
    let result: unknown;
    if (config.config.type === "mcp-http") {
      result = await executeMCPHTTP(config, query, authHeader, controller.signal);
    } else {
      result = await executeREST(config, query, authHeader, controller.signal);
    }

    clearTimeout(timeoutId);

    // Cache external knowledge (never cache user data)
    await cacheResult(env, cacheKey, result);

    // Log execution
    await logExecution(env.DB, config, query, result, Date.now() - startTime, true);

    return {
      tool: config.name,
      result,
      fromCache: false,
      quality: assessQuality(config.name, result),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const error = err instanceof Error ? err.message : String(err);
    logger.warn(`Tool execution failed: ${config.name}`, { error: error.slice(0, 200) });

    await logExecution(env.DB, config, query, null, Date.now() - startTime, false);

    return {
      tool: config.name,
      error,
      quality: "none",
    };
  }
}

async function executeMCPHTTP(
  config: MCPServerConfig,
  query: string,
  authHeader: string | undefined,
  signal: AbortSignal
): Promise<unknown> {
  // MCP HTTP/SSE endpoints - simplified for search tools
  const url = new URL(config.config.url);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader && { Authorization: authHeader }),
    },
    body: JSON.stringify({
      query,
      tools: config.config.tools,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.json();
}

async function executeREST(
  config: MCPServerConfig,
  query: string,
  authHeader: string | undefined,
  signal: AbortSignal
): Promise<unknown> {
  const response = await fetch(config.config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader && { Authorization: authHeader }),
    },
    body: JSON.stringify({ query }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.json();
}

async function cacheResult(env: Env, key: string, result: unknown): Promise<void> {
  try {
    await env.KNOWLEDGE_CACHE?.put(key, JSON.stringify(result), {
      expirationTtl: 86400 * 2, // 48 hours
    });
  } catch (err) {
    logger.debug("Cache write failed (non-critical)", { key, error: String(err) });
  }
}

async function logExecution(
  db: D1Database,
  config: MCPServerConfig,
  query: string,
  result: unknown | null,
  executionTimeMs: number,
  success: boolean
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO tool_executions (chat_id, mcp_server_id, tool_name, query, result, execution_time_ms, success)
         VALUES (0, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        config.id,
        config.name,
        query.slice(0, 500), // Store query (truncated for size)
        result ? JSON.stringify(result).slice(0, 10000) : null,
        executionTimeMs,
        success
      )
      .run();
  } catch {
    // Non-critical: don't fail draft generation if logging fails
  }
}

function hashQuery(query: string): string {
  // Simple hash for cache keys
  let hash = 0;
  for (let i = 0; i < query.length; i++) {
    const char = query.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function assessQuality(toolName: string, result: unknown): ToolResult["quality"] {
  // Simple quality assessment based on result content
  if (!result) return "none";

  const str = JSON.stringify(result);
  if (str.length < 50) return "low";
  if (str.includes("error") || str.includes("not found")) return "low";
  if (str.length > 500) return "high";
  return "medium";
}

/**
 * Format tool results for inclusion in draft prompt
 */
export function formatToolContext(results: ToolResult[]): string {
  if (results.length === 0) return "";

  const validResults = results.filter((r) => r.result && !r.error);
  if (validResults.length === 0) return "";

  return validResults
    .map((r) => `[${r.tool}]: ${JSON.stringify(r.result).slice(0, 1000)}`)
    .join("\n\n");
}
