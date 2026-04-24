import type { Env } from "../types/env";
import type { ClassificationLabel } from "../types/classification";
import { logger } from "./logger";

const LINEAR_API_URL = "https://api.linear.app/graphql";

function getLabelIds(env: Env): Record<string, string> {
  const labels: Record<string, string> = {};
  if (env.LINEAR_LABEL_BUG) labels.bug = env.LINEAR_LABEL_BUG;
  if (env.LINEAR_LABEL_REQUEST) labels.request = env.LINEAR_LABEL_REQUEST;
  return labels;
}

interface LinearIssueResult {
  issueId: string;
  issueUrl: string;
}

/**
 * Create a triage issue in Linear for bug or request classifications.
 */
export async function createTriageIssue(
  env: Env,
  chatTitle: string | null,
  classification: { label: ClassificationLabel; confidence: number; reasoning: string },
  recentMessages: string[]
): Promise<LinearIssueResult | null> {
  const labelIds = getLabelIds(env);
  const labelId = labelIds[classification.label];
  if (!labelId) {
    logger.warn("No Linear label mapping for classification", {
      label: classification.label,
    });
    return null;
  }

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

  const variables = {
    input: {
      title,
      description,
      teamId: env.LINEAR_TEAM_ID,
      ...(env.LINEAR_PROJECT_ID ? { projectId: env.LINEAR_PROJECT_ID } : {}),
      stateId: env.LINEAR_TRIAGE_STATE_ID,
      labelIds: [labelId],
    },
  };

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
      errors?: { message: string }[];
    }>();

    if (json.errors?.length) {
      logger.error("Linear GraphQL errors", {
        errors: json.errors.map((e) => e.message).join("; "),
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
      error: err instanceof Error ? err.message : String(err),
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
