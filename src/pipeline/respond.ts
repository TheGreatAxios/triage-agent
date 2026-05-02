import type { TriageResult, ClassificationLabel } from "../types/classification";
import type { Env } from "../types/env";
import type { DraftStatus } from "../types/draft";
import { persistDraft, markDraftSent, sendTelegramMessage } from "../lib/drafter";
import {
  escalateToSlack,
  sendErrorAlert,
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
import { withTimeout, fireAndForget } from "../lib/timeout";
import {
  checkContentSafety,
  persistContentSafetyLog,
  persistTriageDecision,
  SafetyResult,
} from "../lib/safety";

// ── Confidence Thresholds ────────────────────────────────────────────────
// These guardrails prevent the system from sending low-confidence AI output
// to users. All thresholds are enforced AFTER the LLM decides, so the prompt
// can suggest but the code enforces.

/** Minimum classification confidence to send any draft to the user. */
const CLASSIFICATION_THRESHOLD = 0.4;

/** Minimum draft/response confidence to send a draft to the user. */
const DRAFT_CONFIDENCE_THRESHOLD = 0.6;

/** Label types that require special handling. */
const SENSITIVE_LABELS: ClassificationLabel[] = ["bug", "request"];

/**
 * Evaluate whether a triage result passes safety and confidence checks.
 *
 * Returns a decision that overrides the LLM's action if thresholds aren't met:
 * - "pass" — send as the LLM intended
 * - "blocked_by_threshold" — confidence too low, escalate instead
 * - "blocked_by_content_filter" — unsafe content detected, escalate instead
 * - "no_draft" — no draft content to send
 */
function evaluateSafety(
  triage: TriageResult,
  safety: SafetyResult,
): { pass: boolean; overriddenAction: TriageResult["action"] | null; reason: string } {
  // 1. No draft content → can't send anything
  if (!triage.draft) {
    return { pass: false, overriddenAction: null, reason: "no_draft" };
  }

  // 2. Content safety check — flag unsafe output before it reaches the user
  if (safety.action === "blocked") {
    return { pass: false, overriddenAction: "escalate", reason: "blocked_by_content_filter" };
  }

  // 3. Classification confidence too low
  if (triage.confidence < CLASSIFICATION_THRESHOLD) {
    return { pass: false, overriddenAction: "escalate", reason: "blocked_by_threshold" };
  }

  // 4. Draft confidence below threshold — even if LLM said auto_send, don't trust it
  const draftConfidence = triage.draftConfidence ?? 0;
  if (draftConfidence < DRAFT_CONFIDENCE_THRESHOLD) {
    return { pass: false, overriddenAction: "escalate", reason: "blocked_by_threshold" };
  }

  // 5. For sensitive labels (bug/request), require higher draft confidence
  const isSensitive = SENSITIVE_LABELS.includes(triage.label as ClassificationLabel);
  if (isSensitive && draftConfidence < 0.8) {
    return { pass: false, overriddenAction: "escalate", reason: "blocked_by_threshold" };
  }

  // Passed all checks
  return { pass: true, overriddenAction: null, reason: "pass" };
}

/**
 * Act on a triage result: auto_send, escalate, draft_only, or defer.
 *
 * All drafts are validated against safety and confidence thresholds before
 * reaching the user. Every decision is logged to the triage_decisions audit table.
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

  // ── Safety & threshold validation ────────────────────────────────────
  const safety = draftContent ? checkContentSafety(draftContent) : { flagged: false, categories: [], scores: {}, action: "pass" as const };
  const thresholdEval = evaluateSafety(triage, safety);

  const classificationThresholdPassed = triage.confidence >= CLASSIFICATION_THRESHOLD;
  const draftThresholdPassed = thresholdEval.pass;

  // Log safety check result
  await persistContentSafetyLog(env.DB, chatId, safety, draftContent ?? "");

  // Determine effective action (LLM action vs safety override)
  const effectiveAction = thresholdEval.overriddenAction ?? triage.action;
  const overallDecision = getOverallDecision(triage, thresholdEval, safety);
  const safetyCategories = safety.flagged ? safety.categories : [];

  // ── Act on the effective action ──────────────────────────────────────
  switch (effectiveAction) {
    case "auto_send": {
      if (!draftContent) {
        logger.warn("auto_send with no draft — skipping", { chatId });
        break;
      }

      const telegramChatId = await getTelegramChatId(env.DB, chatId);
      if (!telegramChatId) {
        logger.error("Cannot auto-send: Telegram chat ID not found", { chatId });
        sendErrorAlert(
          env.DB,
          env.SLACK_WEBHOOK_URL,
          {
            chatId,
            errorType: "NotFoundError",
            errorMessage: "Cannot auto-send: Telegram chat ID not found for this internal chat. The draft was never sent.",
            messageText: triage.reasoning,
            sender: "system",
            draftContent: draftContent,
          },
        ).catch((escalateErr) => {
          logger.error("Failed to escalate auto-send failure to Slack", {
            chatId,
            error: getErrorMessage(escalateErr),
          });
        });
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

      // Mark content safety flags on the draft
      if (safety.flagged) {
        await env.DB.prepare(
          "UPDATE drafts SET content_filtered = 1 WHERE id = ?"
        ).bind(draftId).run();
      }

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
            undefined, undefined,
            {
              classificationLabel: triage.label,
              classificationConfidence: triage.confidence,
              reasoning: triage.reasoning,
              method: triage.method,
            },
          )
        : null;

      // Mark content safety flags on the draft
      if (draftId && safety.flagged) {
        await env.DB.prepare(
          "UPDATE drafts SET content_filtered = 1 WHERE id = ?"
        ).bind(draftId).run();
      }

      // Only send the draft to Telegram if it passed safety and thresholds.
      // If it was blocked, don't send to user — just escalate to Slack.
      const sendToUser = draftContent && thresholdEval.pass;

      if (sendToUser) {
        const telegramChatId = await getTelegramChatId(env.DB, chatId);
        if (telegramChatId) {
          const sent = await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN, telegramChatId, draftContent,
          );
          if (sent) {
            logger.info("Draft sent to user during escalation", { chatId, draftId });
          } else {
            logger.error("Failed to send draft to user during escalation", { chatId, draftId });
          }
        } else {
          logger.error("Cannot send escalate draft: Telegram chat ID not found", { chatId });
        }
      } else {
        logger.info("Draft blocked from user — escalating to Slack only", {
          chatId,
          draftId,
          reason: thresholdEval.reason,
          classificationConfidence: triage.confidence,
          draftConfidence,
        });
      }

      const [chatTitle, recentMessages] = await Promise.all([
        getChatTitle(env.DB, chatId),
        getRecentMessagesForEscalation(env.DB, chatId),
      ]);

      // Timeout Slack escalation at 10s to prevent waitUntil overrun
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
          reason: buildEscalationReason(triage, thresholdEval),
          recentMessages,
          responseConfidence: triage.draftConfidence ?? undefined,
        }),
        10000,
        "slack_escalation",
      );

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
    classificationThresholdPassed,
    draftThresholdPassed,
    overallDecision,
    contentFlagged: safety.flagged,
    contentSafetyCategories: safetyCategories,
    executionTimeMs: Date.now() - startTime,
  });

  // ── Linear + Notion (unchanged logic) ────────────────────────────────
  if (triage.label === "bug" || triage.label === "request") {
    const [chatTitle, recentMessages] = await Promise.all([
      getChatTitle(env.DB, chatId),
      getRecentMessagesForEscalation(env.DB, chatId),
    ]);

    const [linearResult] = await Promise.allSettled([
      withTimeout(
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
      ),
    ]);

    if (linearResult.status === "fulfilled") {
      logger.info("Linear triage issue created", { chatId, issueId: linearResult.value?.issueId });
    } else {
      logger.error("Linear triage issue failed", { chatId, error: getErrorMessage(linearResult.reason) });
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
  thresholdEval: { pass: boolean; reason: string },
  safety: SafetyResult,
): string {
  if (!triage.draft) {
    return triage.action === "defer" ? "deferred" : "no_draft";
  }
  if (safety.action === "blocked") {
    return "blocked_by_content_filter";
  }
  if (!thresholdEval.pass) {
    return "blocked_by_threshold";
  }
  if (triage.action === "auto_send" || triage.action === "escalate") {
    return "sent";
  }
  return "deferred";
}

/**
 * Build an escalation reason string that includes threshold info for human reviewers.
 */
function buildEscalationReason(
  triage: TriageResult,
  thresholdEval: { pass: boolean; reason: string },
): string {
  const parts: string[] = [triage.reasoning];

  if (!thresholdEval.pass) {
    parts.push(
      `\n\n[Threshold gate: ${thresholdEval.reason}] ` +
      `Classification confidence: ${(triage.confidence * 100).toFixed(0)}%, ` +
      `Draft confidence: ${((triage.draftConfidence ?? 0) * 100).toFixed(0)}%`
    );
  }

  return parts.join("");
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
