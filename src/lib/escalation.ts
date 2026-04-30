import type { ClassificationResult } from "../types/classification";
import type { EscalationStatus } from "../types/escalation";
import { logger } from "./logger";
import { getFormattedMessagesForEscalation } from "./queries";
import { APIError, DatabaseError, getErrorMessage } from "./errors";
import { withTimeout } from "./timeout";

export interface EscalationContext {
  chatId: number;
  chatTitle: string | null;
  draftId: number | null;
  draftContent: string | null;
  classification: ClassificationResult;
  reason: string;
  recentMessages: string[];
  responseConfidence?: number; // NEW: AI self-assessment for dual-confidence policy
}

export interface EscalationResult {
  escalationId: number;
  slackMessageTs: string | null;
  delivered: boolean;
}

/**
 * Send a Slack escalation and persist the result.
 * Includes idempotency check: skips if escalation sent in last 5 minutes.
 */
export async function escalateToSlack(
  db: D1Database,
  slackWebhookUrl: string,
  ctx: EscalationContext
): Promise<EscalationResult> {
  // Idempotency check: Did we already escalate this chat recently?
  const recentEscalation = await db
    .prepare(
      `SELECT id FROM escalations
       WHERE chat_id = ?
       AND created_at > datetime('now', '-5 minutes')
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(ctx.chatId)
    .first<{ id: number }>();

  if (recentEscalation) {
    logger.info("Recent escalation exists - skipping duplicate", { chatId: ctx.chatId, escalationId: recentEscalation.id });
    return { escalationId: recentEscalation.id, slackMessageTs: null, delivered: true };
  }

  const escalationId = await persistEscalation(
    db,
    ctx.chatId,
    ctx.draftId,
    ctx.reason
  );

  const payload = buildSlackPayload(ctx);
  const delivered = await sendSlackNotification(slackWebhookUrl, payload);

  if (!delivered) {
    logger.error("Slack escalation delivery failed", {
      escalationId,
      chatId: ctx.chatId,
    });
  }

  return { escalationId, slackMessageTs: null, delivered };
}

function buildSlackPayload(ctx: EscalationContext): Record<string, unknown> {
  const chatLabel = ctx.chatTitle ?? `Chat ${ctx.chatId}`;
  const confidencePercent = (ctx.classification.confidence * 100).toFixed(0);
  const responseConfPercent = ctx.responseConfidence
    ? `${(ctx.responseConfidence * 100).toFixed(0)}%`
    : "N/A";

  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "🚨 Telegram Escalation",
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Chat:*\n${chatLabel}`,
        },
        {
          type: "mrkdwn",
          text: `*Classification:*\n${ctx.classification.label} (${confidencePercent}% confidence)`,
        },
      ],
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Response Quality:*\n${responseConfPercent}`,
        },
        {
          type: "mrkdwn",
          text: `*Reason:*\n${ctx.reason}`,
        },
      ],
    },
  ];

  if (ctx.recentMessages.length > 0) {
    const messagePreview = ctx.recentMessages.slice(-5).join("\n");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Recent messages:*\n\`\`\`${messagePreview}\`\`\``,
      },
    });
  }

  if (ctx.draftContent) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Proposed draft:*\n> ${ctx.draftContent}`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Method: ${ctx.classification.method} | Reasoning: ${ctx.classification.reasoning}`,
      },
    ],
  });

  return { blocks };
}

async function sendSlackNotification(
  webhookUrl: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  try {
    const resp = await withTimeout(
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
      8000, // 8s timeout for Slack webhook
      "slack_webhook",
    );

    if (!resp.ok) {
      const body = await resp.text();
      const error = new APIError(
        `Slack webhook returned ${resp.status}`,
        "slack",
        resp.status,
        { responseBody: body }
      );
      logger.error(error.message, error.toJSON());
      return false;
    }

    logger.info("Slack escalation sent");
    return true;
  } catch (err) {
    const error = new APIError(
      "Slack webhook request failed",
      "slack",
      undefined,
      { originalError: getErrorMessage(err) }
    );
    logger.error(error.message, error.toJSON());
    return false;
  }
}

async function persistEscalation(
  db: D1Database,
  chatId: number,
  draftId: number | null,
  reason: string
): Promise<number> {
  try {
    await db
      .prepare(
        `INSERT INTO escalations (chat_id, draft_id, reason, status)
         VALUES (?, ?, ?, 'pending')`
      )
      .bind(chatId, draftId, reason)
      .run();

    const row = await db
      .prepare(
        `SELECT id FROM escalations WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .bind(chatId)
      .first<{ id: number }>();

    if (!row) {
      throw new DatabaseError(
        "Escalation was inserted but could not be retrieved",
        "SELECT",
        "escalations",
        { chatId }
      );
    }

    return row.id;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(
      `Failed to persist escalation for chat ${chatId}`,
      "INSERT",
      "escalations",
      { chatId, draftId, error: getErrorMessage(err) }
    );
  }
}

/**
 * Update escalation status (e.g., when a human acknowledges or resolves).
 */
export async function updateEscalationStatus(
  db: D1Database,
  escalationId: number,
  status: EscalationStatus
): Promise<void> {
  if (status === "resolved") {
    await db
      .prepare(
        `UPDATE escalations SET status = ?, resolved_at = datetime('now') WHERE id = ?`
      )
      .bind(status, escalationId)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE escalations SET status = ? WHERE id = ?`
      )
      .bind(status, escalationId)
      .run();
  }
}

/**
 * Get recent messages for a chat as formatted strings for escalation context.
 * Delegates to centralized query module for consistency.
 */
export async function getRecentMessagesForEscalation(
  db: D1Database,
  chatId: number,
  limit: number = 5
): Promise<string[]> {
  return getFormattedMessagesForEscalation(db, chatId, limit);
}

/**
 * Get the chat title from the chats table.
 */
export async function getChatTitle(
  db: D1Database,
  chatId: number
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT title FROM chats WHERE id = ?`
    )
    .bind(chatId)
    .first<{ title: string | null }>();

  return row?.title ?? null;
}

/**
 * Get the Telegram chat ID from the internal DB chat ID.
 */
export async function getTelegramChatId(
  db: D1Database,
  chatId: number
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT telegram_chat_id FROM chats WHERE id = ?`
    )
    .bind(chatId)
    .first<{ telegram_chat_id: number }>();

  return row?.telegram_chat_id ?? null;
}
