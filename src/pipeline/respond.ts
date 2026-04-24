import type { Env } from "../types/env";
import type { ClassificationResult } from "../types/classification";
import { generateDraft, markDraftSent, sendTelegramMessage, DraftResult } from "../lib/drafter";
import {
  escalateToSlack,
  getRecentMessagesForEscalation,
  getChatTitle,
  getTelegramChatId,
} from "../lib/escalation";
import { createTriageIssue, persistLinearLink } from "../lib/linear";
import { logger } from "../lib/logger";

/**
 * Full response pipeline: generate draft → evaluate policy → act.
 *
 * - auto_send: send to Telegram immediately, mark draft as sent
 * - escalate: generate draft, send Slack escalation with context
 * - draft_only: generate and persist draft for later review
 */
export async function handleResponse(
  env: Env,
  chatId: number,
  classification: ClassificationResult,
  dbMessageId?: number,
  toolContext?: string
): Promise<void> {
  const draft = await generateDraft(env, chatId, classification, toolContext);

  switch (draft.policyAction) {
    case "auto_send": {
      const telegramChatId = await getTelegramChatId(env.DB, chatId);
      if (!telegramChatId) {
        logger.error("Cannot auto-send: Telegram chat ID not found", { chatId });
        break;
      }

      const sent = await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        telegramChatId,
        draft.content
      );

      if (sent) {
        await markDraftSent(env.DB, draft.draftId);
        logger.info("Draft auto-sent", {
          chatId,
          draftId: draft.draftId,
        });
      } else {
        logger.error("Auto-send failed, draft preserved as pending", {
          chatId,
          draftId: draft.draftId,
        });
      }
      break;
    }

    case "escalate": {
      const [chatTitle, recentMessages] = await Promise.all([
        getChatTitle(env.DB, chatId),
        getRecentMessagesForEscalation(env.DB, chatId),
      ]);

      await escalateToSlack(env.DB, env.SLACK_WEBHOOK_URL, {
        chatId,
        chatTitle,
        draftId: draft.draftId,
        draftContent: draft.content,
        classification,
        reason: draft.policyReason,
        recentMessages,
        responseConfidence: draft.responseConfidence, // NEW: Include in escalation
      });

      logger.info("Draft escalated to Slack", {
        chatId,
        draftId: draft.draftId,
        responseConfidence: draft.responseConfidence,
      });
      break;
    }

    case "draft_only": {
      logger.info("Draft saved for review", {
        chatId,
        draftId: draft.draftId,
        classificationConfidence: draft.confidence,
        responseConfidence: draft.responseConfidence,
      });
      break;
    }
  }

  if (classification.label === "bug" || classification.label === "request") {
    try {
      const [chatTitle, recentMessages] = await Promise.all([
        getChatTitle(env.DB, chatId),
        getRecentMessagesForEscalation(env.DB, chatId),
      ]);

      const issue = await createTriageIssue(
        env,
        chatTitle,
        classification,
        recentMessages
      );

      if (issue && dbMessageId) {
        await persistLinearLink(env.DB, chatId, dbMessageId, issue.issueId, issue.issueUrl);
      }
    } catch (err) {
      logger.error("Linear triage issue creation failed", {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
