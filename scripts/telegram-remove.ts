#!/usr/bin/env bun
/**
 * Telegram Team Remove - Remove (deactivate) team member
 *
 * Usage:
 *   bun run telegram:remove @username
 *
 * Examples:
 *   bun run telegram:remove @alice
 */

import { $ } from "bun";

const DB_NAME = "triage-agent-db";

function showHelp(): void {
  console.log(`
🗑️  Telegram Team Remove

Usage:
  bun run telegram:remove @username

Examples:
  bun run telegram:remove @alice

Notes:
  - Username must start with @
  - Performs soft delete (sets is_active=0)
  - To reactivate: bun run telegram:add @username "Name" role
`);
  process.exit(0);
}

function normalizeUsername(username: string): string {
  return username.replace(/^@/, "").trim().toLowerCase();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    showHelp();
  }

  const username = args[0];

  if (!username.startsWith("@")) {
    console.error(`❌ Error: Username "${username}" must start with @`);
    process.exit(1);
  }

  const normalized = normalizeUsername(username);
  console.log(`\n🗑️  Deactivating ${username} (${normalized})...\n`);

  const sql = `UPDATE team_members SET is_active = 0, updated_at = datetime('now') WHERE telegram_username = '${normalized}';`;

  try {
    await $`wrangler d1 execute ${DB_NAME} --remote --command=${sql}`;

    console.log(`✅ Deactivated ${username}\n`);
    console.log("📝 To reactivate: bun run telegram:add @username \"Name\" role");

  } catch (error) {
    console.error("\n❌ Failed to remove member");
    if (error instanceof Error) console.error(error.message);
    process.exit(1);
  }
}

await main();
