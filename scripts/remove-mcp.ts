#!/usr/bin/env bun
/**
 * MCP Remove - Disable an MCP server
 * 
 * Usage:
 *   bun run mcp:remove <name>
 *   NAME=my-search bun run mcp:remove
 */

import { $ } from "bun";

function getName(): string {
  const args = process.argv.slice(2);
  const envName = process.env.NAME;
  
  if (args.length > 0 && !args[0].startsWith("-")) {
    return args[0];
  }
  
  if (envName) {
    return envName;
  }
  
  console.error("❌ Error: Provide name as argument or NAME env var");
  console.error("   bun run mcp:remove my-mcp");
  console.error("   NAME=my-mcp bun run mcp:remove");
  process.exit(1);
}

async function removeMCP(name: string): Promise<void> {
  const dbName = "triage-agent-db";
  
  console.log(`🗑️  Disabling MCP server: ${name}\n`);
  
  try {
    const sql = `UPDATE mcp_servers SET enabled = false WHERE name = '${name.replace(/'/g, "''")}' AND project_id = 'default';`;
    
    await $`wrangler d1 execute ${dbName} --remote --command=${sql}`;
    
    console.log(`✅ MCP server "${name}" disabled`);
    console.log();
    console.log("📝 To re-enable, run add again:");
    console.log(`   bun run mcp:add ${name} <url> <description> [tools...]`);
    console.log();
    console.log("📝 To permanently delete:");
    console.log(`   wrangler d1 execute ${dbName} --remote --command="DELETE FROM mcp_servers WHERE name = '${name}';"`);
    
  } catch (error) {
    console.error("\n❌ Failed to remove MCP server");
    if (error instanceof Error) {
      console.error(error.message);
    }
    process.exit(1);
  }
}

const name = getName();
await removeMCP(name);
