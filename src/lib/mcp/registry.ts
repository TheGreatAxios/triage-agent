/**
 * MCP Registry - Dynamic tool configuration from D1
 * Per-project configs, no git commits needed
 */

export interface MCPServerConfig {
  id: number;
  projectId: string;
  name: string;
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
  result?: unknown;
  error?: string;
  fromCache?: boolean;
  quality: "high" | "medium" | "low" | "none";
}

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
      enabled: Boolean(row.enabled),
      config: JSON.parse(row.config) as MCPServerConfig["config"],
      forLabels: row.for_labels ? JSON.parse(row.for_labels) : null,
      forClassificationConfidenceAbove: row.for_classification_confidence_above,
      priority: row.priority,
    }));
}
