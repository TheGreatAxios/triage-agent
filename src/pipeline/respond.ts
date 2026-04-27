import type { ClassificationResult } from "../types/classification";
import type { TriageResult, ClassificationLabel } from "../types/classification";
import type { Env } from "../types/env";
import type { DraftStatus } from "../types/draft";
import { persistDraft, markDraftSent, sendTelegramMessage } from "../lib/drafter";
import {
  escalateToSlack,
  getRecentMessagesForEscalation,
  getChatTitle,
  getTelegramChatId,
} from "../lib/escalation";
import { createTriageIssue, persistLinearLink } from "../lib/linear";
import { logger } from "../lib/logger";
import { getErrorMessage } from "../lib/errors";

/**
 * Act on a triage result: auto_send, escalate, draft_only, or defer.
 *
 * No LLM calls here — the draft and action come from the triage step.
 */
export async function handleTriageResult(
  env: Env,
  chatId: number,
  triage: TriageResult,
  dbMessageId?: number,
): Promise<void> {
  const draftContent = triage.draft;
  const draftConfidence = triage.draftConfidence ?? 0;

  switch (triage.action) {
    case "auto_send": {
      if (!draftContent) {
        logger.warn("auto_send with no draft — skipping", { chatId });
        break;
      }

      const telegramChatId = await getTelegramChatId(env.DB, chatId);
      if (!telegramChatId) {
        logger.error("Cannot auto-send: Telegram chat ID not found", { chatId });
        break;
      }

      const draftId = await persistDraft(
        env.DB, chatId, draftContent,
        triage.confidence, draftConfidence, "pending",
      );

      const sent = await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN, telegramChatId, draftContent,
      );

      if (sent) {
        await markDraftSent(env.DB, draftId);
        logger.info("Draft auto-sent", { chatId, draftId });
      } else {
        logger.error("Auto-send failed, draft preserved as pending", { chatId, draftId });
      }
      break;
    }

    case "escalate": {
      const draftId = draftContent
        ? await persistDraft(
            env.DB, chatId, draftContent,
            triage.confidence, draftConfidence, "escalated",
          )
        : null;

      const [chatTitle, recentMessages] = await Promise.all([
        getChatTitle(env.DB, chatId),
        getRecentMessagesForEscalation(env.DB, chatId),
      ]);

      const result = await escalateToSlack(env.DB, env.SLACK_WEBHOOK_URL, {
        chatId,
        chatTitle,
        draftId,
        draftContent,
        classification: {
          label: triage.label as ClassificationLabel,
          confidence: triage.confidence,
          method: triage.method,
          reasoning: triage.reasoning,
        },
        reason: triage.reasoning,
        recentMessages,
        responseConfidence: triage.draftConfidence ?? undefined,
      });

      if (result.delivered) {
        logger.info("Draft escalated to Slack", {
          chatId, draftId, responseConfidence: triage.draftConfidence,
        });
      } else {
        logger.error("Slack escalation delivery failed", {
          chatId, draftId, escalationId: result.escalationId,
        });
      }
      break;
    }

    case "draft_only": {
      if (!draftContent) {
        logger.warn("draft_only with no draft — skipping", { chatId });
        break;
      }

      await persistDraft(
        env.DB, chatId, draftContent,
        triage.confidence, draftConfidence, "pending",
      );

      logger.info("Draft saved for review", {
        chatId,
        classificationConfidence: triage.confidence,
        responseConfidence: triage.draftConfidence,
      });
      break;
    }

    case "defer": {
      logger.debug("Deferred — no action needed", {
        chatId,
        label: triage.label,
        confidence: triage.confidence,
      });
      break;
    }
  }

  // Linear triage issue for bugs and requests
  if (triage.label === "bug" || triage.label === "request") {
    try {
      const [chatTitle, recentMessages] = await Promise.all([
        getChatTitle(env.DB, chatId),
        getRecentMessagesForEscalation(env.DB, chatId),
      ]);

      const issue = await createTriageIssue(
        env,
        chatTitle,
        {
          label: triage.label,
          confidence: triage.confidence,
          reasoning: triage.reasoning,
        },
        recentMessages,
      );

      if (issue && dbMessageId) {
        await persistLinearLink(env.DB, chatId, dbMessageId, issue.issueId, issue.issueUrl);
      }
    } catch (err) {
      logger.error("Linear triage issue creation failed", {
        chatId,
        error: getErrorMessage(err),
      });
    }
  }
}

/**
 * @deprecated Use handleTriageResult() instead.
 * Legacy handler for timer-based processing that still uses ClassificationResult.
 */
export async function handleResponse(
  env: Env,
  chatId: number,
  classification: { label: string; confidence: number; method: string; reasoning: string },
  _dbMessageId?: number,
  _toolContext?: string,
  _toolResults?: Array<{ tool: string; result: unknown; summary: string }>,
): Promise<void> {
  // Map old classification to a triage result and delegate
  const triage: TriageResult = {
    label: classification.label as TriageResult["label"],
    confidence: classification.confidence,
    method: classification.method as TriageResult["method"],
    reasoning: classification.reasoning,
    // No draft from timer — escalate to let humans handle
    action: "escalate",
    draft: null,
    draftConfidence: null,
  };

  await handleTriageResult(env, chatId, triage, _dbMessageId);
}
