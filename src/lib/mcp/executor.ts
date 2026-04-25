/**
 * MCP Tool Executor - Parallel execution with caching
 */
import type { Env } from "../../types/env";
import type { MCPServerConfig, ToolResult } from "./registry";
import { logger } from "../logger";
import { getErrorMessage } from "../errors";

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
    const cacheKey = `knowledge/${config.name}/${await hashQuery(query)}`;
    const cached = await env.KNOWLEDGE_CACHE?.get(cacheKey);
    if (cached) {
      try {
        const body = await cached.text();
        const result = JSON.parse(body);
        return {
          tool: config.name,
          result,
          fromCache: true,
          quality: "high",
          summary: generateSummary(result),
        };
      } catch (err) {
        // Cache corrupted or unreadable - proceed to fetch fresh
        logger.warn("Cache read failed, fetching fresh", {
          tool: config.name,
          error: String(err).slice(0, 100),
        });
      }
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
      summary: generateSummary(result),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const error = getErrorMessage(err);
    logger.warn(`Tool execution failed: ${config.name}`, { error: error.slice(0, 200) });

    await logExecution(env.DB, config, query, null, Date.now() - startTime, false);

    return {
      tool: config.name,
      result: null,
      error,
      quality: "none",
      summary: `Error: ${error.slice(0, 100)}`,
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
    // Store without expiration - bucket lifecycle rules handle cleanup
    await env.KNOWLEDGE_CACHE?.put(key, JSON.stringify(result));
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

/**
 * Generate cache key hash for a query.
 * Uses SHA-256 via crypto.subtle when available (256-bit security),
 * falls back to FNV-1a 64-bit hash for compatibility.
 * Includes query length in the key to reduce collision risk.
 */
async function hashQuery(query: string): Promise<string> {
  const len = query.length;
  const encoder = new TextEncoder();
  const data = encoder.encode(query);

  // Prefer SHA-256 via crypto.subtle for 256-bit collision resistance
  if (typeof crypto !== "undefined" && crypto.subtle) {
    try {
      const digest = await crypto.subtle.digest("SHA-256", data);
      const hashArray = new Uint8Array(digest);
      const hashHex = Array.from(hashArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return `${len}:${hashHex}`;
    } catch {
      // Fall through to FNV-1a on error
    }
  }

  // FNV-1a 64-bit fallback (good distribution, fast in pure JS)
  const hashHex = fnv1a64(data);
  return `${len}:${hashHex}`;
}

/**
 * FNV-1a 64-bit hash algorithm.
 * Uses BigInt for 64-bit arithmetic. Returns 16-char hex string.
 */
function fnv1a64(data: Uint8Array): string {
  const FNV_OFFSET_BASIS = BigInt("14695981039346656037"); // 2^64 + 2^8 + 0x3c6ef372bf
  const FNV_PRIME = BigInt("1099511628211"); // 2^40 + 2^8 + 0xb3
  const MODULO = BigInt("18446744073709551616"); // 2^64

  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < data.length; i++) {
    hash ^= BigInt(data[i]);
    hash = (hash * FNV_PRIME) % MODULO;
  }

  // Return 16-character hex (64 bits)
  return hash.toString(16).padStart(16, "0");
}

/**
 * Generate a brief summary of tool result for persistence.
 * Truncated to avoid storing large results in D1.
 */
function generateSummary(result: unknown): string {
  if (!result) return "No result";
  const str = JSON.stringify(result);
  // Truncate to 200 chars for D1 storage efficiency
  return str.length > 200 ? str.slice(0, 197) + "..." : str;
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
