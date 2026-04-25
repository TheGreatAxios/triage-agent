#!/usr/bin/env bun
/**
 * Team Member Management Script
 *
 * Runtime team member configuration without code changes or redeploys.
 *
 * Usage:
 *   bun run team:add <path-to-json>
 *   bun run team:remove @username
 *   bun run team:list
 *   bun run team:update @username <path-to-json>
 *
 * Examples:
 *   bun run team:add ./team.json
 *   bun run team:remove @alice
 *   bun run team:list
 *   bun run team:update @alice ./updates.json
 *
 * JSON format for add:
 *   [
 *     {
 *       "telegramUsername": "@alice",
 *       "displayName": "Alice Chen",
 *       "role": "agent",
 *       "slackUserId": "U12345678"
 *     }
 *   ]
 *
 * JSON format for update:
 *   {
 *     "displayName": "Alice Smith",
 *     "role": "supervisor"
 *   }
 */

import { $ } from "bun";
import { readFileSync } from "fs";
import { resolve } from "path";

interface TeamMemberInput {
  telegramUsername: string;
  displayName: string;
  role?: 'agent' | 'admin' | 'supervisor';
  slackUserId?: string;
  isActive?: boolean;
}

const DB_NAME = "triage-agent-db";

function showHelp(): void {
  console.log(`
👥 Team Member Management

Runtime team member configuration without code changes or redeploys.

Usage:
  bun run team:add <path-to-json>     Add team members from JSON file
  bun run team:remove @username       Remove (deactivate) a team member
  bun run team:list                   List all active team members
  bun run team:update @username <path-to-json>  Update team member fields

Examples:
  # Add team members from file
  bun run team:add ./team.json

  # Remove a team member (soft delete - sets is_active=0)
  bun run team:remove @alice

  # List all active team members
  bun run team:list

  # Update specific fields
  bun run team:update @alice ./updates.json

JSON format for add:
  [
    {
      "telegramUsername": "@alice",
      "displayName": "Alice Chen",
      "role": "agent",
      "slackUserId": "U12345678"
    },
    {
      "telegramUsername": "@bob",
      "displayName": "Bob Smith",
      "role": "supervisor"
    }
  ]

JSON format for update:
  {
    "displayName": "Alice Smith",
    "role": "supervisor",
    "slackUserId": "U87654321"
  }

Notes:
  - Usernames MUST start with @ (enforced)
  - Valid roles: agent, admin, supervisor (default: agent)
  - Remove performs soft delete (is_active=0); use update to reactivate
`);
  process.exit(0);
}

function validateUsername(username: string): boolean {
  if (!username.startsWith('@')) {
    console.error(`❌ Error: Username "${username}" must start with @`);
    return false;
  }
  return true;
}

function validateRole(role: string): boolean {
  const validRoles = ['agent', 'admin', 'supervisor'];
  if (!validRoles.includes(role)) {
    console.error(`❌ Error: Invalid role "${role}". Must be one of: ${validRoles.join(', ')}`);
    return false;
  }
  return true;
}

async function executeSQL(sql: string, description: string): Promise<void> {
  console.log(`\n🚀 ${description}...\n`);

  try {
    const tmpFile = `/tmp/team-manage-${Date.now()}.sql`;
    await Bun.write(tmpFile, sql);

    const result = await $`wrangler d1 execute ${DB_NAME} --remote --file=${tmpFile}`;

    await Bun.file(tmpFile).delete();

    console.log(`✅ ${description} completed successfully!\n`);
  } catch (error) {
    console.error(`\n❌ Failed to ${description.toLowerCase()}`);
    if (error instanceof Error) {
      console.error(error.message);
    }
    process.exit(1);
  }
}

async function addTeamMembers(inputPath: string): Promise<void> {
  let members: TeamMemberInput[];

  try {
    const content = readFileSync(resolve(inputPath), 'utf-8');
    members = JSON.parse(content);
  } catch (error) {
    console.error(`❌ Error reading ${inputPath}:`, error instanceof Error ? error.message : error);
    process.exit(1);
  }

  if (!Array.isArray(members)) {
    console.error('❌ Error: Input must be a JSON array of team members');
    process.exit(1);
  }

  console.log(`\n📥 Adding ${members.length} team member(s)...`);

  const values: string[] = [];
  for (const m of members) {
    if (!validateUsername(m.telegramUsername)) {
      process.exit(1);
    }

    const role = m.role || 'agent';
    if (!validateRole(role)) {
      process.exit(1);
    }

    const isActive = m.isActive !== false ? 1 : 0;
    const slackId = m.slackUserId || null;

    values.push(`('${m.telegramUsername}', '${m.displayName.replace(/'/g, "''")}', '${role}', ${slackId ? `'${slackId}'` : 'NULL'}, ${isActive})`);

    console.log(`  - ${m.telegramUsername} (${m.displayName}, ${role})`);
  }

  const sql = `
INSERT INTO team_members (telegram_username, display_name, role, slack_user_id, is_active)
VALUES ${values.join(', ')}
ON CONFLICT (telegram_username) DO UPDATE SET
  display_name = excluded.display_name,
  role = excluded.role,
  slack_user_id = excluded.slack_user_id,
  is_active = excluded.is_active,
  updated_at = datetime('now');
`;

  await executeSQL(sql, `Added ${members.length} team member(s)`);

  console.log('📝 To verify:');
  console.log('   bun run team:list');
}

async function removeTeamMember(username: string): Promise<void> {
  if (!validateUsername(username)) {
    process.exit(1);
  }

  console.log(`\n🗑️  Deactivating ${username}...`);

  const sql = `
UPDATE team_members
SET is_active = 0, updated_at = datetime('now')
WHERE telegram_username = '${username}';
`;

  await executeSQL(sql, `Deactivated ${username}`);

  console.log('📝 To reactivate:');
  console.log(`   bun run team:update ${username} '{"isActive": true}'`);
}

async function listTeamMembers(): Promise<void> {
  console.log('\n📋 Active Team Members\n');

  const sql = `
SELECT telegram_username, display_name, role, slack_user_id, created_at
FROM team_members
WHERE is_active = 1
ORDER BY display_name;
`;

  const tmpFile = `/tmp/team-list-${Date.now()}.sql`;
  await Bun.write(tmpFile, sql);

  try {
    const result = await $`wrangler d1 execute ${DB_NAME} --remote --file=${tmpFile}`;
    await Bun.file(tmpFile).delete();

    // Output is already printed by wrangler
    console.log('\n✅ List complete');
  } catch (error) {
    await Bun.file(tmpFile).delete();
    console.error('\n❌ Failed to list team members');
    if (error instanceof Error) {
      console.error(error.message);
    }
    process.exit(1);
  }
}

async function updateTeamMember(username: string, updatePath: string): Promise<void> {
  if (!validateUsername(username)) {
    process.exit(1);
  }

  let updates: Partial<TeamMemberInput>;

  try {
    const content = readFileSync(resolve(updatePath), 'utf-8');
    updates = JSON.parse(content);
  } catch (error) {
    console.error(`❌ Error reading ${updatePath}:`, error instanceof Error ? error.message : error);
    process.exit(1);
  }

  const setClauses: string[] = ['updated_at = datetime(\'now\')'];

  if (updates.displayName !== undefined) {
    setClauses.push(`display_name = '${updates.displayName.replace(/'/g, "''")}'`);
  }

  if (updates.role !== undefined) {
    if (!validateRole(updates.role)) {
      process.exit(1);
    }
    setClauses.push(`role = '${updates.role}'`);
  }

  if (updates.slackUserId !== undefined) {
    setClauses.push(`slack_user_id = ${updates.slackUserId ? `'${updates.slackUserId}'` : 'NULL'}`);
  }

  if (updates.isActive !== undefined) {
    setClauses.push(`is_active = ${updates.isActive ? 1 : 0}`);
  }

  if (setClauses.length === 1) {
    console.error('❌ Error: No valid fields to update');
    process.exit(1);
  }

  console.log(`\n✏️  Updating ${username}...`);

  const sql = `
UPDATE team_members
SET ${setClauses.join(', ')}
WHERE telegram_username = '${username}';
`;

  await executeSQL(sql, `Updated ${username}`);

  console.log('📝 To verify:');
  console.log('   bun run team:list');
}

// CLI
const [cmd, arg1, arg2] = process.argv.slice(2);

if (!cmd || cmd === '--help' || cmd === '-h') {
  showHelp();
}

switch (cmd) {
  case 'add':
    if (!arg1) {
      console.error('❌ Error: Missing path to JSON file');
      console.error('Usage: bun run team:add <path-to-json>');
      process.exit(1);
    }
    await addTeamMembers(arg1);
    break;

  case 'remove':
    if (!arg1) {
      console.error('❌ Error: Missing username');
      console.error('Usage: bun run team:remove @username');
      process.exit(1);
    }
    await removeTeamMember(arg1);
    break;

  case 'list':
    await listTeamMembers();
    break;

  case 'update':
    if (!arg1 || !arg2) {
      console.error('❌ Error: Missing username or update file');
      console.error('Usage: bun run team:update @username <path-to-json>');
      process.exit(1);
    }
    await updateTeamMember(arg1, arg2);
    break;

  default:
    console.error(`❌ Unknown command: ${cmd}`);
    showHelp();
}
