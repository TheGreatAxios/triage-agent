#!/usr/bin/env bun
/**
 * MCP Add Script - Simplified MCP registration
 * 
 * Usage:
 *   bun run mcp:add <name> <url> <description> [tools...]
 * 
 * Examples:
 *   bun run mcp:add my-search https://api.example.com/search "Web search for docs" search query
 *   bun run mcp:add context7 https://mcp.context7.com/mcp "Query library documentation" query-docs resolve-library-id
 * 
 * Environment Variables:
 *   MCP_FOR_LABELS    - Labels to apply to [default: "bug,request"]
 *   MCP_TIMEOUT       - Request timeout in ms [default: 5000]
 *   MCP_PRIORITY      - Priority (lower = first) [default: 50]
 */

import { $ } from "bun";

interface MCPAddArgs {
  name: string;
  url: string;
  description: string;
  tools: string[];
  forLabels: string[];
  timeout: number;
  priority: number;
}

function showHelp(): void {
  console.log(`
📦 MCP Add - Register a new MCP server

Usage:
  bun run mcp:add <name> <url> <description> [tools...]

Arguments:
  name         Unique identifier (e.g., "my-search")
  url          HTTP endpoint URL
  description  What this MCP does (for codemode/AI)
  tools        Tool names to invoke (space-separated)

Environment Variables:
  MCP_FOR_LABELS    Labels to apply to [default: "bug,request"]
  MCP_TIMEOUT       Request timeout ms [default: 5000]
  MCP_PRIORITY      Priority (lower = first) [default: 50]

Examples:
  # Simple web search MCP
  bun run mcp:add web-search https://search.example.com "Search the web" search

  # Documentation MCP with multiple tools
  bun run mcp:add docs https://docs.example.com/mcp "Query documentation" query search

  # Apply to all message types
  MCP_FOR_LABELS="bug,request,normal" bun run mcp:add helper https://api.example.com "General helper" assist

Related Commands:
  bun run mcp:list    - List all MCP servers
`);
  process.exit(0);
}

function parseArgs(): MCPAddArgs {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    showHelp();
  }
  
  if (args.length < 4) {
    console.error("❌ Error: Requires name, url, description, and at least one tool");
    showHelp();
  }
  
  const [name, url, description, ...tools] = args;
  
  // Validate URL
  try {
    new URL(url);
  } catch {
    console.error(`❌ Error: Invalid URL: ${url}`);
    process.exit(1);
  }
  
  // Validate name (no spaces, alphanumeric + dash/underscore)
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    console.error("❌ Error: Name must be alphanumeric with dashes/underscores only");
    process.exit(1);
  }
  
  return {
    name,
    url,
    description,
    tools,
    forLabels: process.env.MCP_FOR_LABELS?.split(",").map(s => s.trim()) || ["bug", "request"],
    timeout: parseInt(process.env.MCP_TIMEOUT || "5000", 10),
    priority: parseInt(process.env.MCP_PRIORITY || "50", 10),
  };
}

function buildSQL(args: MCPAddArgs): string {
  const config = {
    type: "mcp-http",
    url: args.url,
    timeout: args.timeout,
    tools: args.tools,
    retryAttempts: 2,
  };
  
  const configJson = JSON.stringify(config);
  const forLabelsJson = JSON.stringify(args.forLabels);
  
  // Escape single quotes for SQL
  const descEscaped = args.description.replace(/'/g, "''");
  
  return `
INSERT INTO mcp_servers (project_id, name, description, config, for_labels, priority, enabled)
VALUES ('default', '${args.name}', '${descEscaped}', '${configJson.replace(/'/g, "''")}', '${forLabelsJson}', ${args.priority}, true)
ON CONFLICT (project_id, name) DO UPDATE SET
  description = excluded.description,
  config = excluded.config,
  for_labels = excluded.for_labels,
  priority = excluded.priority,
  enabled = true,
  updated_at = datetime('now');
`;
}

async function executeSQL(sql: string, args: MCPAddArgs): Promise<void> {
  const dbName = "triage-agent-db";
  
  console.log("🚀 Adding MCP server to database...\n");
  
  try {
    // Write SQL to temp file (wrangler likes files better than long commands)
    const tmpFile = `/tmp/mcp-add-${Date.now()}.sql`;
    await Bun.write(tmpFile, sql);
    
    // Execute via wrangler
    const result = await $`wrangler d1 execute ${dbName} --remote --file=${tmpFile}`;
    
    // Clean up
    await Bun.file(tmpFile).delete();
    
    console.log("✅ MCP server added successfully!\n");
    console.log("📋 Configuration:");
    console.log(`   Name:        ${args.name}`);
    console.log(`   Description: ${args.description}`);
    console.log(`   URL:         ${args.url}`);
    console.log(`   Tools:       ${args.tools.join(", ")}`);
    console.log(`   For Labels:  ${args.forLabels.join(", ")}`);
    console.log(`   Priority:    ${args.priority}`);
    console.log();
    console.log("📝 To verify:");
    console.log(`   bun run mcp:list`);
    console.log();
    console.log("🗑️  To remove:");
    console.log(`   NAME=${args.name} bun run mcp:remove`);
    
  } catch (error) {
    console.error("\n❌ Failed to add MCP server");
    if (error instanceof Error) {
      console.error(error.message);
    }
    process.exit(1);
  }
}

// Main
const args = parseArgs();
const sql = buildSQL(args);

console.log();
await executeSQL(sql, args);
