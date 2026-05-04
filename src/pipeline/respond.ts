import type { TriageResult, ClassificationLabel } from "../types/classification";
import type { Env } from "../types/env";
import type { DraftStatus } from "../types/draft";
import { persistDraft } from "../lib/drafter";
import {
  escalateToSlack,
  getRecentMessagesForEscalation,
  getChatTitle,
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
import { withTimeout, fireAndForget } from "../lib/timeout";
import {
  checkContentSafety,
  persistContentSafetyLog,
  persistTriageDecision,
  SafetyResult,
} from "../lib/safety";

/**
 * Act on a triage result: save draft, escalate to Slack, create Linear issues.
 *
 * Telegram responses are paused for quality rework.
 * No messages are sent to users — all drafts are saved or escalated to Slack.
 */
export async function handleTriageResult(
  env: Env,
  chatId: number,
  triage: TriageResult,
  dbMessageId?: number,
): Promise<void> {
  const startTime = Date.now();
  const draftContent = triage.draft;
  const draftConfidence = triage.draftConfidence ?? 0;

  // ── Safety check ─────────────────────────────────────────────────────
  const safety = draftContent
    ? checkContentSafety(draftContent)
    : { flagged: false, categories: [], scores: {}, action: "pass" as const };

  if (draftContent) {
    await persistContentSafetyLog(env.DB, chatId, safety, draftContent);
  }

  // ── Save or escalate ─────────────────────────────────────────────────
  switch (triage.action) {
    case "draft_only":
    case "auto_send": {
      // auto_send is deprecated — both just save the draft for later review.
      // auto_send is handled here as a safety net for old schema output.
      if (!draftContent) {
        logger.warn("No draft to save — skipping", { chatId });
        break;
      }

      const draftId = await persistDraft(
        env.DB, chatId, draftContent,
        triage.confidence, draftConfidence, "pending",
        undefined, undefined,
        {
          classificationLabel: triage.label,
          classificationConfidence: triage.confidence,
          reasoning: triage.reasoning,
          method: triage.method,
        },
      );

      if (safety.flagged) {
        await env.DB.prepare(
          "UPDATE drafts SET content_filtered = 1 WHERE id = ?"
        ).bind(draftId).run();
      }

      logger.info("Draft saved for review", {
        chatId,
        draftId,
        label: triage.label,
        confidence: triage.confidence,
      });
      break;
    }

    case "escalate": {
      const draftId = draftContent
        ? await persistDraft(
            env.DB, chatId, draftContent,
            triage.confidence, draftConfidence, "escalated",
            undefined, undefined,
            {
              classificationLabel: triage.label,
              classificationConfidence: triage.confidence,
              reasoning: triage.reasoning,
              method: triage.method,
            },
          )
        : null;

      if (draftId && safety.flagged) {
        await env.DB.prepare(
          "UPDATE drafts SET content_filtered = 1 WHERE id = ?"
        ).bind(draftId).run();
      }

      const [chatTitle, recentMessages] = await Promise.all([
        getChatTitle(env.DB, chatId),
        getRecentMessagesForEscalation(env.DB, chatId),
      ]);

      const result = await withTimeout(
        escalateToSlack(env.DB, env.SLACK_WEBHOOK_URL, {
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
        }),
        10000,
        "slack_escalation",
      );

      if (result.delivered) {
        logger.info("Escalated to Slack", {
          chatId, draftId, label: triage.label,
        });
      } else {
        logger.error("Slack escalation delivery failed", {
          chatId, draftId, escalationId: result.escalationId,
        });
      }
      break;
    }

    case "defer": {
      logger.debug("Deferred — no action", {
        chatId,
        label: triage.label,
        confidence: triage.confidence,
      });
      break;
    }
  }

  // ── Audit log ────────────────────────────────────────────────────────
  await persistTriageDecision(env.DB, {
    chatId,
    dbMessageId,
    label: triage.label,
    classificationConfidence: triage.confidence,
    method: triage.method,
    action: triage.action,
    draftContent,
    draftConfidence: triage.draftConfidence ?? null,
    classificationThresholdPassed: true, // Deprecated — kept for schema compat
    draftThresholdPassed: true,           // Deprecated — kept for schema compat
    overallDecision: getOverallDecision(triage, safety),
    contentFlagged: safety.flagged,
    contentSafetyCategories: safety.flagged ? safety.categories : [],
    executionTimeMs: Date.now() - startTime,
  });

  // ── Linear + Notion ──────────────────────────────────────────────────
  if (triage.label === "bug" || triage.label === "request" || triage.label === "financial_help") {
    const [chatTitle, recentMessages] = await Promise.all([
      getChatTitle(env.DB, chatId),
      getRecentMessagesForEscalation(env.DB, chatId),
    ]);

    const linearPromise = triage.label === "financial_help"
      ? Promise.resolve(null)
      : withTimeout(
          createTriageIssue(
            env,
            chatTitle,
            {
              label: triage.label,
              confidence: triage.confidence,
              reasoning: triage.reasoning,
            },
            recentMessages,
          ).then(async (issue) => {
            if (issue && dbMessageId) {
              await persistLinearLink(env.DB, chatId, dbMessageId, issue.issueId, issue.issueUrl);
            }
            return issue;
          }),
          15000,
          "linear_triage_issue",
        );

    const [linearResult] = await Promise.allSettled([linearPromise]);

    if (triage.label !== "financial_help") {
      if (linearResult.status === "fulfilled") {
        logger.info("Linear triage issue created", { chatId, issueId: linearResult.value?.issueId });
      } else {
        logger.error("Linear triage issue failed", { chatId, error: getErrorMessage(linearResult.reason) });
      }
    }

    fireAndForget(
      async () => {
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
        } else if (suggestion && env.SLACK_BOT_TOKEN && env.SLACK_APPROVAL_CHANNEL_ID) {
          await sendProjectSuggestionToSlack(env, suggestion);
        }
      },
      "notion_triage_push",
      logger,
    );

    fireAndForget(
      async () => {
        const summary = await getOrRefreshSummary(env.DB, chatId, env);
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
          } else if (suggestion && env.SLACK_BOT_TOKEN && env.SLACK_APPROVAL_CHANNEL_ID) {
            await sendProjectSuggestionToSlack(env, suggestion);
          }
        }
      },
      "notion_summary_push",
      logger,
    );
  }
}

/**
 * Determine the overall decision string for the audit log.
 */
function getOverallDecision(
  triage: TriageResult,
  safety: SafetyResult,
): string {
  if (!triage.draft) {
    return triage.action === "defer" ? "deferred" : "no_draft";
  }
  if (safety.action === "blocked") {
    return "blocked_by_content_filter";
  }
  if (triage.action === "draft_only" || triage.action === "auto_send") {
    return "saved";
  }
  if (triage.action === "escalate") {
    return "escalated";
  }
  return "deferred";
}

/**
 * Send a Slack message suggesting a project link for a triage page.
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
