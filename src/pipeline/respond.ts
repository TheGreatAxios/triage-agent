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
import {
  pushTriageToNotion,
  pushSummaryToNotion,
  persistNotionLink,
  getProjectPageId as getProjectPageIdCached,
  NotionProjectSuggestion,
} from "../lib/notion";
import { postSlackMessage } from "../lib/slack";
import { getOrRefreshSummary } from "../lib/summary";
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

  // Triage issue tracking for bugs and requests (Linear + Notion)
  if (triage.label === "bug" || triage.label === "request") {
    const [chatTitle, recentMessages] = await Promise.all([
      getChatTitle(env.DB, chatId),
      getRecentMessagesForEscalation(env.DB, chatId),
    ]);

    // Linear triage issue
    try {
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

    // Notion: append triage block to project page
    try {
      const { appended, suggestion } = await pushTriageToNotion(
        env,
        chatId,
        chatTitle,
        { label: triage.label, confidence: triage.confidence, reasoning: triage.reasoning },
        recentMessages,
      );

      if (appended && dbMessageId) {
        const projectPageId = await getProjectPageIdCached(env.DB, chatId);
        if (projectPageId) {
          await persistNotionLink(env.DB, chatId, dbMessageId, projectPageId, `https://notion.so/${projectPageId.replace(/-/g, "")}`, "block_triage");
        }
      } else if (suggestion) {
        await sendProjectSuggestionToSlack(env, suggestion);
      }
    } catch (err) {
      logger.error("Notion triage push failed", { chatId, error: getErrorMessage(err) });
    }

    // Notion: append summary block to project page
    try {
      const summary = await getOrRefreshSummary(env.DB, chatId);
      if (summary?.content) {
        const { appended, suggestion } = await pushSummaryToNotion(
          env,
          chatId,
          chatTitle,
          summary.content,
          summary.messageRangeEnd && summary.messageRangeStart
            ? summary.messageRangeEnd - summary.messageRangeStart
            : 0,
        );

        if (appended && dbMessageId) {
          const projectPageId = await getProjectPageIdCached(env.DB, chatId);
          if (projectPageId) {
            await persistNotionLink(env.DB, chatId, dbMessageId, projectPageId, `https://notion.so/${projectPageId.replace(/-/g, "")}`, "block_summary");
          }
        } else if (suggestion) {
          await sendProjectSuggestionToSlack(env, suggestion);
        }
      }
    } catch (err) {
      logger.error("Notion summary push failed", { chatId, error: getErrorMessage(err) });
    }
  }
}

/**
 * Send a Slack message suggesting a project link for a triage page.
 * Approver can confirm the match or create a new project.
 */
async function sendProjectSuggestionToSlack(
  env: Env,
  suggestion: NotionProjectSuggestion,
): Promise<void> {
  const { chatId, chatTitle, matches } = suggestion;

  if (!env.SLACK_BOT_TOKEN || !env.SLACK_APPROVAL_CHANNEL_ID) return;

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "📎 Link Notion Project?",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Chat *${chatTitle}* has a new ${suggestion.pendingType} item. Append it to an existing Notion project page?`,
      },
    },
  ];

  // Show matches with confirm buttons
  for (const match of matches) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `• *${match.title}*`,
      },
      accessory: {
        type: "button",
        text: {
          type: "plain_text",
          text: `Confirm`,
          emoji: true,
        },
        style: "primary",
        value: `${chatId}:${match.pageId}:${suggestion.pendingType}`,
        action_id: "notion_link_project",
      },
    });
  }

  // Always show "Create New" and "Skip"
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: `Create New Project`,
          emoji: true,
        },
        value: `${chatId}::${suggestion.pendingType}`,
        action_id: "notion_create_project",
      },
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Skip",
          emoji: true,
        },
        value: `skip:${chatId}`,
        action_id: "notion_skip_project",
      },
    ],
  });

  await postSlackMessage(
    env.SLACK_BOT_TOKEN,
    env.SLACK_APPROVAL_CHANNEL_ID,
    `Link Notion project for: ${chatTitle}`,
    blocks,
  );
}

