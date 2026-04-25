/**
 * MCP Registry - Dynamic tool configuration from D1
 * Per-project configs, no git commits needed
 */

export interface MCPServerConfig {
  id: number;
  projectId: string;
  name: string;
  description?: string | null; // Human-readable for codemode/AI
  enabled: boolean;
  config: {
    type: "mcp-http" | "rest";
    url: string;
    authEnvVar?: string | null;
    timeout: number;
    tools: string[];
    retryAttempts?: number;
  };
  forLabels: string[] | null;
  forClassificationConfidenceAbove: number;
  priority: number;
}

export interface ToolResult {
  tool: string;
  /** Result data (present on success, undefined on error) */
  result: unknown;
  /** Error message (present on failure, undefined on success) */
  error?: string;
  fromCache?: boolean;
  quality: "high" | "medium" | "low" | "none";
  /** Summary of the result for persistence (auto-generated from result) */
  summary: string;
}

/**
 * Add a new MCP server with simplified parameters.
 * 
 * Example:
 * ```typescript
 * await addMCPServer(env.DB, {
 *   name: 'my-search',
 *   url: 'https://api.example.com/mcp',
 *   tools: ['search'],
 *   authEnvVar: 'MY_API_KEY' // optional
 * });
 * ```
 */
export async function addMCPServer(
  db: D1Database,
  params: {
    name: string;
    url: string;
    tools: string[];
    description?: string; // For codemode: what this MCP does
    authEnvVar?: string;
    forLabels?: string[];
    timeout?: number;
    priority?: number;
    projectId?: string;
  }
): Promise<void> {
  const {
    name,
    url,
    tools,
    description,
    authEnvVar,
    forLabels = ["bug", "request"],
    timeout = 5000,
    priority = 50,
    projectId = "default",
  } = params;

  // Security: Validate HTTPS URL to prevent SSRF via internal/fake URLs
  if (!url.startsWith("https://")) {
    throw new Error("MCP server URL must use HTTPS");
  }
  try {
    new URL(url); // Validate URL format
  } catch {
    throw new Error("Invalid MCP server URL format");
  }

  const config = {
    type: "mcp-http" as const,
    url,
    timeout,
    tools,
    retryAttempts: 2,
    ...(authEnvVar && { authEnvVar }),
  };

  await db
    .prepare(
      `INSERT INTO mcp_servers (project_id, name, description, config, for_labels, priority, enabled)
       VALUES (?, ?, ?, ?, ?, ?, true)
       ON CONFLICT (project_id, name) DO UPDATE SET
         description = excluded.description,
         config = excluded.config,
         for_labels = excluded.for_labels,
         priority = excluded.priority,
         enabled = true,
         updated_at = datetime('now')`
    )
    .bind(
      projectId,
      name,
      description ?? null,
      JSON.stringify(config),
      JSON.stringify(forLabels),
      priority
    )
    .run();
}

/**
 * Quick templates for common MCP types.
 */
export const MCPTemplates = {
  /** Web search API (like Parallel) */
  webSearch: (url: string, authEnvVar?: string) => ({
    type: "mcp-http" as const,
    url,
    timeout: 5000,
    tools: ["web_search", "web_fetch"],
    retryAttempts: 2,
    ...(authEnvVar && { authEnvVar }),
  }),

  /** Documentation API (like Context7) */
  docs: (url: string, authEnvVar?: string) => ({
    type: "mcp-http" as const,
    url,
    timeout: 5000,
    tools: ["query-docs", "resolve-library-id"],
    retryAttempts: 2,
    ...(authEnvVar && { authEnvVar }),
  }),

  /** Generic API */
  api: (url: string, tools: string[], authEnvVar?: string) => ({
    type: "mcp-http" as const,
    url,
    timeout: 5000,
    tools,
    retryAttempts: 2,
    ...(authEnvVar && { authEnvVar }),
  }),
};

/**
 * Load enabled MCP servers for a project and classification
 */
export async function loadMCPServers(
  db: D1Database,
  projectId: string,
  label: string,
  classificationConfidence: number
): Promise<MCPServerConfig[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM mcp_servers
       WHERE project_id = ?
       AND enabled = true
       AND for_classification_confidence_above <= ?
       ORDER BY priority ASC`
    )
    .bind(projectId, classificationConfidence)
    .all<{
      id: number;
      project_id: string;
      name: string;
      description: string | null;
      enabled: number;
      config: string;
      for_labels: string | null;
      for_classification_confidence_above: number;
      priority: number;
    }>();

  if (!results) return [];

  return results
    .filter((row) => {
      // Include if for_labels is null (applies to all labels)
      if (row.for_labels === null) return true;

      // Otherwise, check if the label is in the array
      try {
        const labels = JSON.parse(row.for_labels) as string[];
        return labels.includes(label);
      } catch {
        return false;
      }
    })
    .map((row) => ({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      description: row.description,
      enabled: Boolean(row.enabled),
      config: JSON.parse(row.config) as MCPServerConfig["config"],
      forLabels: row.for_labels ? JSON.parse(row.for_labels) : null,
      forClassificationConfidenceAbove: row.for_classification_confidence_above,
      priority: row.priority,
    }));
}
