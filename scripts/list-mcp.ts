#!/usr/bin/env bun
/**
 * MCP List - Show all registered MCP servers
 * 
 * Usage:
 *   bun run mcp:list
 *   bun run mcp:list --json
 */

import { $ } from "bun";

const format = process.argv.includes("--json") ? "json" : "table";

async function listMCPs(): Promise<void> {
  const dbName = "triage-agent-db";
  
  try {
    const sql = `
      SELECT 
        name,
        description,
        for_labels,
        priority,
        enabled,
        datetime(created_at) as created
      FROM mcp_servers 
      WHERE project_id = 'default'
      ORDER BY priority, name;
    `;
    
    const result = await $`wrangler d1 execute ${dbName} --remote --command=${sql}`;
    
    if (format === "json") {
      console.log(result.stdout);
    } else {
      // Parse and format as table
      console.log("\n📦 MCP Servers\n");
      console.log(result.stdout);
    }
    
  } catch (error) {
    console.error("❌ Failed to list MCP servers");
    if (error instanceof Error) {
      console.error(error.message);
    }
    process.exit(1);
  }
}

await listMCPs();
