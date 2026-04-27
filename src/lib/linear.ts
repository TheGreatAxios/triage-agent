import type { Env } from "../types/env";
import type { ClassificationLabel } from "../types/classification";
import { logger } from "./logger";
import { getErrorMessage } from "./errors";

const LINEAR_API_URL = "https://api.linear.app/graphql";

/** UUID format validator */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUUID(value: string | undefined, name: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!UUID_RE.test(trimmed)) {
    logger.error(`Invalid Linear UUID format`, { name, value: `${trimmed.slice(0, 8)}...` });
    return null;
  }
  return trimmed;
}

interface LinearIssueResult {
  issueId: string;
  issueUrl: string;
}

/**
 * Create a triage issue in Linear for bug or request classifications.
 *
 * Validates all UUIDs before sending — logs clear errors for any malformed IDs.
 */
export async function createTriageIssue(
  env: Env,
  chatTitle: string | null,
  classification: { label: ClassificationLabel; confidence: number; reasoning: string },
  recentMessages: string[]
): Promise<LinearIssueResult | null> {
  // Validate required UUIDs
  const teamId = validateUUID(env.LINEAR_TEAM_ID, "LINEAR_TEAM_ID");
  const stateId = validateUUID(env.LINEAR_TRIAGE_STATE_ID, "LINEAR_TRIAGE_STATE_ID");

  if (!teamId || !stateId) {
    logger.error("Linear issue creation skipped — missing or invalid required IDs", {
      teamId: !!teamId,
      stateId: !!stateId,
    });
    return null;
  }

  // Optional UUIDs
  const projectId = validateUUID(env.LINEAR_PROJECT_ID, "LINEAR_PROJECT_ID");

  // Resolve label ID for classification
  const labelMap: Record<string, string | undefined> = {
    bug: env.LINEAR_LABEL_BUG,
    request: env.LINEAR_LABEL_REQUEST,
  };
  const rawLabelId = labelMap[classification.label];
  const labelId = rawLabelId ? validateUUID(rawLabelId, `LABEL_${classification.label}`) : null;

  const chatLabel = chatTitle ?? "Unknown Chat";
  const prefix = classification.label === "bug" ? "🐛 Bug" : "✨ Feature Request";
  const title = `[Telegram] ${prefix}: ${chatLabel}`;

  const messageContext =
    recentMessages.length > 0
      ? recentMessages.join("\n")
      : "_No recent messages available._";

  const description = [
    `## Classification`,
    `- **Label:** ${classification.label}`,
    `- **Confidence:** ${(classification.confidence * 100).toFixed(0)}%`,
    `- **Reasoning:** ${classification.reasoning}`,
    ``,
    `## Recent Messages`,
    "```",
    messageContext,
    "```",
  ].join("\n");

  const mutation = `
    mutation CreateTriageIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          url
        }
      }
    }
  `;

  const input: Record<string, unknown> = {
    title,
    description,
    teamId,
    stateId,
    ...(projectId ? { projectId } : {}),
    ...(labelId ? { labelIds: [labelId] } : {}),
  };

  const variables = { input };

  try {
    const resp = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: env.LINEAR_API_KEY,
      },
      body: JSON.stringify({ query: mutation, variables }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.error("Linear API request failed", { status: resp.status, body });
      return null;
    }

    const json = await resp.json<{
      data?: {
        issueCreate: {
          success: boolean;
          issue: { id: string; url: string };
        };
      };
      errors?: { message: string; extensions?: Record<string, unknown> }[];
    }>();

    if (json.errors?.length) {
      logger.error("Linear GraphQL errors", {
        errors: json.errors.map((e) => ({
          message: e.message,
          ...e.extensions,
        })),
        input: {
          teamId,
          stateId,
          projectId: projectId ?? null,
          labelId: labelId ?? null,
          classification: classification.label,
        },
      });
      return null;
    }

    const result = json.data?.issueCreate;
    if (!result?.success) {
      logger.error("Linear issue creation unsuccessful");
      return null;
    }

    logger.info("Linear triage issue created", {
      issueId: result.issue.id,
      issueUrl: result.issue.url,
    });

    return { issueId: result.issue.id, issueUrl: result.issue.url };
  } catch (err) {
    logger.error("Linear API error", {
      error: getErrorMessage(err),
    });
    return null;
  }
}

/**
 * Persist a Linear issue link in D1.
 */
export async function persistLinearLink(
  db: D1Database,
  chatId: number,
  messageId: number,
  issueId: string,
  issueUrl: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO linear_links (chat_id, message_id, linear_issue_id, linear_issue_url, issue_type)
       VALUES (?, ?, ?, ?, 'triage')`
    )
    .bind(chatId, messageId, issueId, issueUrl)
    .run();
}
