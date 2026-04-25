#!/usr/bin/env bun
/**
 * Telegram Team List - List all active team members
 *
 * Usage:
 *   bun run telegram:list
 */

import { $ } from "bun";

const DB_NAME = "triage-agent-db";

function showHelp(): void {
  console.log(`
📋 Telegram Team List

Usage:
  bun run telegram:list

Shows all active Telegram team members with their roles and Slack IDs.
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
  }

  console.log('\n📋 Telegram Team Members\n');

  const sql = `SELECT telegram_username, display_name, role, slack_user_id, created_at FROM team_members WHERE is_active = 1 ORDER BY display_name;`;

  try {
    await $`wrangler d1 execute ${DB_NAME} --remote --command=${sql}`;
    console.log();
  } catch (error) {
    console.error("\n❌ Failed to list members");
    if (error instanceof Error) console.error(error.message);
    process.exit(1);
  }
}

await main();
