import type { Env } from "../types/env";
import type { TriageResult } from "../types/classification";
import { getFiredTimers, markTimerFired } from "../lib/state";
import { handleTriageResult } from "./respond";
import { logger } from "../lib/logger";
import { expirePendingApprovals } from "../lib/approval";
import { sendDailySummary as sendApprovalDailySummary, sendStaleAlert, sendDailySummaryWebhook } from "../lib/slack";
import { calculateAndStoreDailyStats } from "../lib/persistence";
import { loadMCPServers, executeTools, formatToolContext } from "../lib/mcp";
import { getRecentMessagesWithSenders } from "../lib/queries";
import { getErrorMessage } from "../lib/errors";
import {
  getStaleChats,
  recordStaleAlert,
  calculateDailyMetrics,
  checkDuplicateSummary,
  recordSummarySent,
  isTimerProcessed,
  recordTimerProcessed,
} from "../lib/team";

/**
 * Process all fired timers (called from scheduled handler).
 * For each fired timer, classify the latest message and run the response pipeline.
 */
export async function processTimers(env: Env): Promise<number> {
  const timers = await getFiredTimers(env.DB);

  if (timers.length === 0) return 0;

  logger.info("Processing fired timers", { count: timers.length });

  let processed = 0;

  for (const timer of timers) {
    // IDEMPOTENCY: Check if this timer was already processed recently
    const alreadyProcessed = await isTimerProcessed(env.DB, timer.id);
    if (alreadyProcessed) {
      logger.info("Timer already processed recently - skipping", { timerId: timer.id });
      continue;
    }

    try {
      const classification = await getLatestClassification(env.DB, timer.chatId);

      if (classification) {
        // Load and execute MCP tools for additional context (mirrors ingest.ts logic)
        const mcpServers = await loadMCPServers(
          env.DB,
          "default",
          classification.label,
          classification.confidence
        );

        let toolContext = "";
        if (mcpServers.length > 0) {
          // Fetch latest message text for tool execution
          const recentMessages = await getRecentMessagesWithSenders(env.DB, {
            chatId: timer.chatId,
            limit: 1,
            order: "desc",
          });
          const latestMessageText = recentMessages[0]?.text ?? "";

          const toolResults = await executeTools(env, mcpServers, latestMessageText);
          toolContext = formatToolContext(toolResults);

          logger.debug("MCP tools executed for timer", {
            timerId: timer.id,
            chatId: timer.chatId,
            toolsUsed: toolResults.map((r) => r.tool).join(","),
            resultsCount: toolResults.filter((r) => r.result).length,
          });
        }

        await handleTriageResult(env, timer.chatId, triageFromTimer(classification));
      } else {
        logger.warn("No classification found for timer chat", {
          timerId: timer.id,
          chatId: timer.chatId,
        });
      }

      await markTimerFired(env.DB, timer.id);
      await recordTimerProcessed(env.DB, timer.id);
      processed++;

      logger.info("Timer processed", {
        timerId: timer.id,
        chatId: timer.chatId,
        type: timer.type,
      });
    } catch (err) {
      logger.error("Timer processing failed", {
        timerId: timer.id,
        chatId: timer.chatId,
        error: getErrorMessage(err),
      });
    }
  }

  // Check for stale chats needing attention (4+ hours no response)
  try {
    const staleChats = await getStaleChats(env.DB, 4); // 4 hour threshold
    for (const staleChat of staleChats) {
      // Idempotency: Check if we already sent this alert
      const alertRecorded = await recordStaleAlert(env.DB, staleChat.chatId, "stale_4h");
      if (alertRecorded) {
        // Only send if not already sent - pass webhook URL from env
        await sendStaleAlert(env.DB, {
          chatId: staleChat.chatId,
          chatTitle: staleChat.chatTitle || `Chat ${staleChat.chatId}`,
          customerWaitingHours: staleChat.customerWaitingHours,
          lastTeamTouchAt: staleChat.lastTeamTouchAt,
          lastTeamMemberName: staleChat.lastTeamMemberName,
        }, env.SLACK_WEBHOOK_URL);
      } else {
        logger.info("Stale alert already sent - skipping duplicate", { chatId: staleChat.chatId });
      }
    }
  } catch (err) {
    logger.error("Failed to process stale chats", { error: getErrorMessage(err) });
  }

  // Daily aggregation runs once per day
  try {
    const today = new Date().toISOString().split("T")[0];
    const hour = new Date().getUTCHours();

    // Morning summary at 16:00 UTC (8 AM PST), evening at 00:00 UTC (4 PM PST)
    // Note: These times match the crons in wrangler.jsonc
    const isMorningSummaryTime = hour === 16;
    const isEveningSummaryTime = hour === 0;

    if (isMorningSummaryTime || isEveningSummaryTime) {
      const period = isMorningSummaryTime ? "morning" : "evening";

      // Idempotency check: Did we already send today?
      const duplicateCheck = await checkDuplicateSummary(env.DB, today, period);

      if (!duplicateCheck.sent) {
        // Calculate daily metrics first
        await calculateDailyMetrics(env.DB, today);

        // Send summary via webhook
        const summaryResult = await sendDailySummaryWebhook(env.DB, today, period, env.SLACK_WEBHOOK_URL);

        if (summaryResult.success) {
          // Record that we sent it (idempotency)
          await recordSummarySent(env.DB, today, period, summaryResult.channel || "unknown", summaryResult.messageTs || Date.now().toString());
          logger.info("Daily summary sent", { date: today, period, messageTs: summaryResult.messageTs });
        }
      } else {
        logger.info("Daily summary already sent - skipping duplicate", { date: today, period, existingTs: duplicateCheck.slackMessageTs });
      }
    }
  } catch (err) {
    logger.error("Failed to process daily summary", { error: getErrorMessage(err) });
  }

  return processed;
}

async function getLatestClassification(
  db: D1Database,
  chatId: number
): Promise<TriageResult | null> {
  const row = await db
    .prepare(
      `SELECT label, confidence, method
       FROM classifications
       WHERE chat_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(chatId)
    .first<{ label: string; confidence: number; method: string }>();

  if (!row) return null;

  const validLabels = ["bug", "request", "normal", "unknown"];
  if (!validLabels.includes(row.label)) {
    logger.warn("Invalid classification label in database", { label: row.label, chatId });
    return null;
  }

  const validMethods = ["rule", "model", "fallback"];
  if (!validMethods.includes(row.method)) {
    logger.warn("Invalid classification method in database", { method: row.method, chatId });
    return null;
  }

  return {
    label: row.label as TriageResult["label"],
    confidence: row.confidence,
    method: row.method as TriageResult["method"],
    reasoning: "From latest classification",
    action: "escalate",
    draft: null,
    draftConfidence: null,
  };
}

/**
 * Map a stored classification to a TriageResult for the timer path.
 * Timers always escalate — the original triage window has passed.
 */
function triageFromTimer(classification: TriageResult): TriageResult {
  return {
    ...classification,
    action: "escalate",
    draft: null,
    draftConfidence: null,
  };
}

/**
 * Check and expire pending approvals past 72 hours.
 * Called from scheduled handler.
 */
export async function checkApprovalExpirations(env: Env): Promise<number> {
  try {
    const count = await expirePendingApprovals(env);
    if (count > 0) {
      logger.info("Expired pending approvals", { count });
    }
    return count;
  } catch (err) {
    logger.error("Failed to check approval expirations", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Send daily summary for the specified period.
 * Called from scheduled handler at 8am PST (morning) and 4pm PST (evening).
 */
export async function sendDailySummaryIfScheduled(
  env: Env,
  period: "morning" | "evening"
): Promise<void> {
  try {
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];

    // IDEMPOTENCY: Check if we already sent this summary
    const duplicateCheck = await checkDuplicateSummary(env.DB, dateStr, period);
    if (duplicateCheck.sent) {
      logger.info("Daily summary already sent - skipping duplicate", {
        date: dateStr,
        period,
        existingTs: duplicateCheck.slackMessageTs,
      });
      return;
    }

    // Calculate and store stats
    const stats = await calculateAndStoreDailyStats(env.DB, dateStr, period);

    // Send to Slack
    const summaryResult = await sendApprovalDailySummary(env.SLACK_BOT_TOKEN, env.SLACK_SUMMARY_CHANNEL_ID, {
      date: dateStr,
      period,
      totalChats: stats.totalChats,
      approvedChats: stats.approvedChats,
      pendingChats: stats.pendingChats,
      rejectedChats: stats.rejectedChats,
      expiredChats: stats.expiredChats,
      blacklistedChats: stats.blacklistedChats,
      totalMessages: stats.totalMessages,
      uniqueUsers: stats.uniqueUsers,
      activeChats: stats.activeChats,
      approvalDecisions: stats.approvalDecisions,
    });

    // Record that we sent it (idempotency)
    await recordSummarySent(
      env.DB,
      dateStr,
      period,
      summaryResult.channel || "unknown",
      summaryResult.messageTs || Date.now().toString()
    );

    logger.info("Daily summary sent", { date: dateStr, period, messageTs: summaryResult.messageTs });
  } catch (err) {
    logger.error("Failed to send daily summary", {
      period,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
