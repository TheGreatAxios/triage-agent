#!/usr/bin/env bun
/**
 * Telegram Team Add - Add team members
 *
 * Usage:
 *   bun run telegram:add <username> <display-name> [role] [slack-id]
 *
 * Examples:
 *   bun run telegram:add @alice "Alice Chen" agent U123456
 *   bun run telegram:add @alice,@bob,@charlie --names "Alice,Bob,Charlie"
 *   bun run telegram:add @alice,@bob --names "Alice,Bob" --roles "agent,supervisor"
 */

import { $ } from "bun";

const DB_NAME = "triage-agent-db";
const VALID_ROLES = ['agent', 'admin', 'supervisor'];

interface TeamMember {
  username: string;
  displayName: string;
  role: string;
  slackId: string | null;
}

function showHelp(): void {
  console.log(`
👥 Telegram Team Add

Usage:
  bun run telegram:add <username> <display-name> [role] [slack-id]

Examples:
  # Add single member
  bun run telegram:add @alice "Alice Chen" agent U123456

  # Add multiple members
  bun run telegram:add @alice,@bob,@charlie --names "Alice,Bob,Charlie"

  # Add with specific roles
  bun run telegram:add @alice,@bob --names "Alice,Bob" --roles "agent,supervisor"

  # Add with Slack IDs
  bun run telegram:add @alice,@bob --names "Alice,Bob" --slack "U123,U456"

Notes:
  - Usernames MUST start with @
  - Stores username without @ for consistent matching
  - Add is idempotent (updates if exists)
`);
  process.exit(0);
}

function parseArgs(): TeamMember[] {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    showHelp();
  }

  const namesFlagIdx = args.findIndex(a => a === "--names");
  const rolesFlagIdx = args.findIndex(a => a === "--roles");
  const slackFlagIdx = args.findIndex(a => a === "--slack");

  const usernamesArg = args[0];
  if (!usernamesArg) {
    console.error("❌ Error: Missing username(s)");
    showHelp();
  }

  const usernames = usernamesArg.split(",").map(u => u.trim());

  for (const u of usernames) {
    if (!u.startsWith("@")) {
      console.error(`❌ Error: Username "${u}" must start with @`);
      process.exit(1);
    }
  }

  let displayNames: string[];
  let roles: string[];
  let slackIds: (string | null)[];

  if (namesFlagIdx !== -1) {
    const namesValue = args[namesFlagIdx + 1];
    if (!namesValue) {
      console.error("❌ Error: --names requires a value");
      process.exit(1);
    }
    displayNames = namesValue.split(",").map(n => n.trim());

    if (rolesFlagIdx !== -1) {
      const rolesValue = args[rolesFlagIdx + 1];
      if (!rolesValue) {
        console.error("❌ Error: --roles requires a value");
        process.exit(1);
      }
      roles = rolesValue.split(",").map(r => r.trim());
    } else {
      roles = usernames.map(() => "agent");
    }

    if (slackFlagIdx !== -1) {
      const slackValue = args[slackFlagIdx + 1];
      if (!slackValue) {
        console.error("❌ Error: --slack requires a value");
        process.exit(1);
      }
      slackIds = slackValue.split(",").map(s => s.trim() || null);
    } else {
      slackIds = usernames.map(() => null);
    }

    if (displayNames.length !== usernames.length) {
      console.error(`❌ Error: ${usernames.length} usernames but ${displayNames.length} display names`);
      process.exit(1);
    }
    if (roles.length !== usernames.length) {
      console.error(`❌ Error: ${usernames.length} usernames but ${roles.length} roles`);
      process.exit(1);
    }
    if (slackIds.length !== usernames.length) {
      console.error(`❌ Error: ${usernames.length} usernames but ${slackIds.length} Slack IDs`);
      process.exit(1);
    }
  } else {
    if (args.length < 2) {
      console.error("❌ Error: Requires at least username and display name");
      console.error("Usage: bun run telegram:add @alice \"Alice Chen\" [role] [slack-id]");
      console.error("       bun run telegram:add @alice,@bob --names \"Alice,Bob\" [roles] [slack-ids]");
      process.exit(1);
    }

    // If multiple usernames provided, check if display name arg has commas
    if (usernames.length > 1) {
      const displayNameArg = args[1];
      const splitNames = displayNameArg.split(",").map(n => n.trim());

      if (splitNames.length === usernames.length) {
        // User provided comma-separated display names
        displayNames = splitNames;

        // Parse roles - if single value, repeat for all users
        const roleArg = args[2];
        if (roleArg) {
          const splitRoles = roleArg.split(",").map(r => r.trim());
          roles = splitRoles.length === 1
            ? usernames.map(() => splitRoles[0])  // Single role for all
            : splitRoles;
        } else {
          roles = usernames.map(() => "agent");
        }

        // Parse Slack IDs - if single value, repeat for all users
        const slackArg = args[3];
        if (slackArg) {
          const splitSlack = slackArg.split(",").map(s => s.trim() || null);
          slackIds = splitSlack.length === 1 && splitSlack[0]
            ? usernames.map(() => splitSlack[0])  // Single Slack ID for all
            : splitSlack;
        } else {
          slackIds = usernames.map(() => null);
        }
      } else {
        console.error(`❌ Error: ${usernames.length} usernames but 1 display name.`);
        console.error("For bulk add, use: --names \"Name1,Name2\"");
        console.error("Or provide comma-separated names as second argument");
        process.exit(1);
      }
    } else {
      // Single username - simple case
      displayNames = [args[1]];
      roles = [args[2] || "agent"];
      slackIds = [args[3] || null];
    }
  }

  for (const role of roles) {
    if (!VALID_ROLES.includes(role)) {
      console.error(`❌ Error: Invalid role "${role}". Must be one of: ${VALID_ROLES.join(", ")}`);
      process.exit(1);
    }
  }

  return usernames.map((username, i) => ({
    username,
    displayName: displayNames[i],
    role: roles[i],
    slackId: slackIds[i],
  }));
}

function normalizeUsername(username: string): string {
  return username.replace(/^@/, "").trim().toLowerCase();
}

function buildSQL(members: TeamMember[]): string {
  const values = members.map(m => {
    const escapedName = m.displayName.replace(/'/g, "''");
    const normalizedUsername = normalizeUsername(m.username);
    const slackVal = m.slackId ? `'${m.slackId}'` : "NULL";
    return `('${normalizedUsername}', '${escapedName}', '${m.role}', ${slackVal}, 1)`;
  }).join(",\n  ");

  return `
INSERT INTO team_members (telegram_username, display_name, role, slack_user_id, is_active)
VALUES
  ${values}
ON CONFLICT (telegram_username) DO UPDATE SET
  display_name = excluded.display_name,
  role = excluded.role,
  slack_user_id = excluded.slack_user_id,
  is_active = 1,
  updated_at = datetime('now');
`;
}

async function main(): Promise<void> {
  const members = parseArgs();

  console.log(`\n🚀 Adding ${members.length} team member(s)...\n`);

  for (const m of members) {
    const normalized = normalizeUsername(m.username);
    const slackInfo = m.slackId ? ` (Slack: ${m.slackId})` : "";
    console.log(`  - ${m.username} → ${normalized}: ${m.displayName} (${m.role})${slackInfo}`);
  }

  const sql = buildSQL(members);

  try {
    await $`wrangler d1 execute ${DB_NAME} --remote --command=${sql}`;

    console.log(`\n✅ Added ${members.length} member(s) successfully!\n`);
    console.log("📝 To verify: bun run telegram:list");

  } catch (error) {
    console.error("\n❌ Failed to add members");
    if (error instanceof Error) console.error(error.message);
    process.exit(1);
  }
}

await main();
