import type { ClassificationResult } from "../types/classification";
import type { EscalationStatus } from "../types/escalation";
import { logger } from "./logger";

export interface EscalationContext {
  chatId: number;
  chatTitle: string | null;
  draftId: number | null;
  draftContent: string | null;
  classification: ClassificationResult;
  reason: string;
  recentMessages: string[];
}

export interface EscalationResult {
  escalationId: number;
  slackMessageTs: string | null;
  delivered: boolean;
}

/**
 * Send a Slack escalation and persist the result.
 */
export async function escalateToSlack(
  db: D1Database,
  slackWebhookUrl: string,
  ctx: EscalationContext
): Promise<EscalationResult> {
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
      text: {
        type: "mrkdwn",
        text: `*Reason:*\n${ctx.reason}`,
      },
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
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.error("Slack webhook failed", {
        status: resp.status,
        body,
      });
      return false;
    }

    logger.info("Slack escalation sent");
    return true;
  } catch (err) {
    logger.error("Slack webhook error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function persistEscalation(
  db: D1Database,
  chatId: number,
  draftId: number | null,
  reason: string
): Promise<number> {
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

  if (!row) throw new Error(`Failed to persist escalation for chat ${chatId}`);
  return row.id;
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
      .prepare(`UPDATE escalations SET status = ? WHERE id = ?`)
      .bind(status, escalationId)
      .run();
  }
}

/**
 * Get recent messages for a chat as formatted strings for escalation context.
 */
export async function getRecentMessagesForEscalation(
  db: D1Database,
  chatId: number,
  limit: number = 5
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT am.text, cp.display_name
       FROM active_messages am
       JOIN chat_participants cp ON cp.id = am.sender_id
       WHERE am.chat_id = ?
       ORDER BY am.created_at DESC
       LIMIT ?`
    )
    .bind(chatId, limit)
    .all<{ text: string; display_name: string }>();

  return results.reverse().map((m) => `[${m.display_name}]: ${m.text}`);
}

/**
 * Get the chat title from the chats table.
 */
export async function getChatTitle(
  db: D1Database,
  chatId: number
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT title FROM chats WHERE id = ?`)
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
    .prepare(`SELECT telegram_chat_id FROM chats WHERE id = ?`)
    .bind(chatId)
    .first<{ telegram_chat_id: number }>();

  return row?.telegram_chat_id ?? null;
}
