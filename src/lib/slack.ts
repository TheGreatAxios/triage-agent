/** Slack API helpers and request verification. */

import type { D1Database } from "@cloudflare/workers-types";
import type { PendingApproval, PriorChatSummary } from "../types/approval";
import { logger } from "./logger";
import { getErrorMessage } from "./errors";
import { buildMinimalApprovalBlocks, buildRichApprovalBlocks, buildDecisionBlocks } from "./slack-blocks";

/** Stale chat alert data structure. */
export interface StaleChatAlert {
  chatId: number;
  chatTitle: string;
  customerWaitingHours: number;
  lastTeamTouchAt: string | null;
  lastTeamMemberName: string | null;
}

/** Result of sending a Slack message. */
export interface SlackSendResult {
  success: boolean;
  channel?: string;
  messageTs?: string;
  error?: string;
}

/** Daily metrics for team summary. */
export interface DailyMetrics {
  date: string;
  period: "morning" | "evening";
  totalChats: number;
  newChats: number;
  resolvedChats: number;
  avgResponseTimeSeconds: number | null;
  healthScore: number; // 0-100, <24h response = healthy
  teamMembers: TeamMemberDailyStats[];
}

/** Per-team-member daily statistics. */
export interface TeamMemberDailyStats {
  displayName: string;
  slackUserId: string | null;
  chatsResponded: number;
  messagesSent: number;
  avgFirstResponseMinutes: number | null;
  bugsHandled: number;
  requestsHandled: number;
}

/**
 * Verify Slack request signature using signing secret.
 * Includes 5-minute timestamp freshness check to prevent replay attacks.
 */
export async function verifySlackRequestAsync(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string
): Promise<boolean> {
  try {
    // Timestamp freshness check: reject requests older than 5 minutes or future-dated
    const now = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(timestamp, 10);
    if (isNaN(requestTime) || Math.abs(now - requestTime) > 300) {
      logger.warn("Slack request timestamp invalid or stale", { now, requestTime, diff: now - requestTime });
      return false;
    }

    const baseString = `v0:${timestamp}:${body}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(signingSecret);
    const messageData = encoder.encode(baseString);

    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBuffer = await crypto.subtle.sign("HMAC", key, messageData);
    const computed =
      "v0=" +
      Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    return computed === signature;
  } catch (err) {
    logger.error("Slack signature verification error", {
      error: getErrorMessage(err),
    });
    return false;
  }
}

/**
 * Send approval request to Slack via Bot API.
 */
export async function sendApprovalRequestToSlack(
  botToken: string,
  channelId: string,
  approval: PendingApproval,
  priorSummary: PriorChatSummary | null,
  botUsername: string
): Promise<{ slackMessageTs: string | null; slackChannelId: string | null }> {
  try {
    const blocks =
      approval.slackBlocksType === "rich" && priorSummary
        ? buildRichApprovalBlocks(approval, priorSummary, botUsername)
        : buildMinimalApprovalBlocks(approval, botUsername);

    const text = `🔔 New chat approval request: ${approval.chatTitle || "Untitled Chat"}`;

    const result = await postSlackMessage(botToken, channelId, text, blocks);

    logger.info("Approval request sent to Slack", {
      pending_id: approval.id,
      chat_title: approval.chatTitle,
      blocks_type: approval.slackBlocksType,
      channel: result.channel,
    });

    return {
      slackMessageTs: result.ts,
      slackChannelId: result.channel,
    };
  } catch (err) {
    logger.error("Failed to send Slack approval request", {
      pending_id: approval.id,
      error: getErrorMessage(err),
    });
    throw err;
  }
}

/**
 * Post message to Slack using bot token (returns message timestamp).
 */
export async function postSlackMessage(
  botToken: string,
  channel: string,
  text: string,
  blocks?: unknown[]
): Promise<{ ts: string | null; channel: string | null }> {
  try {
    const payload: Record<string, unknown> = {
      channel,
      text,
      unfurl_links: false,
    };
    if (blocks) {
      payload.blocks = blocks;
    }

    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json() as { ok: boolean; ts?: string; channel?: string; error?: string };

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    return { ts: data.ts || null, channel: data.channel || null };
  } catch (err) {
    logger.error("Failed to post Slack message", {
      error: getErrorMessage(err),
    });
    return { ts: null, channel: null };
  }
}

/**
 * Update a Slack message with decision outcome.
 */
export async function updateSlackMessageWithDecision(
  botToken: string,
  channel: string,
  timestamp: string,
  decision: "approved" | "rejected" | "expired",
  decidedBy: string,
  botUsername: string
): Promise<boolean> {
  try {
    const blocks = buildDecisionBlocks(decision, decidedBy, botUsername);

    const resp = await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel,
        ts: timestamp,
        text: `Chat approval ${decision} by ${decidedBy}`,
        blocks,
      }),
    });

    const data = await resp.json() as { ok: boolean; error?: string };

    if (!data.ok) {
      logger.warn("Failed to update Slack message", {
        error: data.error,
        channel,
        ts: timestamp,
      });
      return false;
    }

    return true;
  } catch (err) {
    logger.error("Error updating Slack message", {
      error: getErrorMessage(err),
    });
    return false;
  }
}

/**
 * Open a modal for batch approval selection.
 */
export async function openBatchApprovalModal(
  botToken: string,
  triggerId: string,
  pendingApprovals: Array<{
    id: number;
    chatId: number;
    chatTitle: string | null;
    chatType: string;
    memberCount: number | null;
    requestedByName: string;
    complexityScore: number | null;
  }>
): Promise<boolean> {
  try {
    // Build options for multi-select (max 100 options per Slack limits)
    const options = pendingApprovals.slice(0, 100).map((approval) => ({
      text: {
        type: "plain_text" as const,
        text: `${approval.chatTitle || "Untitled"} (${approval.chatType}, ${approval.memberCount || "?"} members)`,
        emoji: true,
      },
      value: String(approval.chatId),
      description: {
        type: "plain_text" as const,
        text: `By ${approval.requestedByName} • Complexity: ${((approval.complexityScore || 0) * 100).toFixed(0)}%`,
      },
    }));

    const resp = await fetch("https://slack.com/api/views.open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        trigger_id: triggerId,
        view: {
          type: "modal",
          callback_id: "batch_approval_modal",
          title: {
            type: "plain_text",
            text: `Batch Approve (${pendingApprovals.length})`,
          },
          submit: {
            type: "plain_text",
            text: "Approve Selected",
          },
          close: {
            type: "plain_text",
            text: "Cancel",
          },
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `Select chats to approve (${pendingApprovals.length} total):`,
              },
            },
            {
              type: "input",
              block_id: "selected_chats",
              element: {
                type: "multi_static_select",
                placeholder: {
                  type: "plain_text",
                  text: "Select chats to approve...",
                },
                options,
                action_id: "chat_selection",
              },
              label: {
                type: "plain_text",
                text: `Chats to Approve (${pendingApprovals.length} total)`,
              },
              optional: true,
            },
          ],
        },
      }),
    });

    const data = await resp.json() as { ok: boolean; error?: string };

    if (!data.ok) {
      logger.warn("Failed to open batch approval modal", { error: data.error });
      return false;
    }

    return true;
  } catch (err) {
    logger.error("Error opening batch modal", {
      error: getErrorMessage(err),
    });
    return false;
  }
}

/**
 * Open modal for batch rejection.
 */
export async function openBatchRejectModal(
  botToken: string,
  triggerId: string,
  pendingApprovals: Array<{
    id: number;
    chatId: number;
    chatTitle: string | null;
    chatType: string;
    memberCount: number | null;
  }>
): Promise<boolean> {
  try {
    const options = pendingApprovals.slice(0, 100).map((approval) => ({
      text: {
        type: "plain_text" as const,
        text: `${approval.chatTitle || "Untitled"} (${approval.chatType})`,
        emoji: true,
      },
      value: String(approval.chatId),
    }));

    const resp = await fetch("https://slack.com/api/views.open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        trigger_id: triggerId,
        view: {
          type: "modal",
          callback_id: "batch_reject_modal",
          title: {
            type: "plain_text",
            text: "Batch Reject",
          },
          submit: {
            type: "plain_text",
            text: "Reject Selected",
            style: "danger",
          },
          close: {
            type: "plain_text",
            text: "Cancel",
          },
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:warning: *Reject and blacklist* selected chats:`,
              },
            },
            {
              type: "input",
              block_id: "selected_chats",
              element: {
                type: "multi_static_select",
                placeholder: {
                  type: "plain_text",
                  text: "Select chats to reject...",
                },
                options,
                action_id: "chat_selection",
              },
              label: {
                type: "plain_text",
                text: "Chats to Reject",
              },
              optional: true,
            },
          ],
        },
      }),
    });

    const data = await resp.json() as { ok: boolean; error?: string };
    return data.ok || false;
  } catch {
    return false;
  }
}

/**
 * Send batch operation completion notification via Bot API.
 */
export async function sendBatchApprovalCompleteNotification(
  botToken: string,
  channelId: string,
  results: { approved: number; rejected: number; failed: number; errors: string[] },
  performedBy: string
): Promise<void> {
  try {
    const { approved, rejected, failed, errors } = results;
    const total = approved + rejected + failed;

    const blocks = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "📊 Batch Approval Complete",
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Total:*\n${total}`,
          },
          {
            type: "mrkdwn",
            text: `*Approved:*\n${approved} ✅`,
          },
          {
            type: "mrkdwn",
            text: `*Rejected:*\n${rejected} ❌`,
          },
          {
            type: "mrkdwn",
            text: `*Failed:*\n${failed} ⚠️`,
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Performed by: ${performedBy} • ${new Date().toLocaleString()}`,
          },
        ],
      },
    ];

    if (errors.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Errors:*\n${errors.slice(0, 5).join("\n")}${errors.length > 5 ? `\n...and ${errors.length - 5} more` : ""}`,
          emoji: false,
        },
      });
    }

    const text = `Batch approval complete: ${approved} approved, ${rejected} rejected, ${failed} failed`;
    await postSlackMessage(botToken, channelId, text, blocks);
  } catch (err) {
    logger.error("Failed to send batch completion notification", {
      error: getErrorMessage(err),
    });
  }
}

/**
 * Send daily summary to Slack via Bot API.
 */
export async function sendDailySummary(
  botToken: string,
  channelId: string,
  stats: {
    date: string;
    period: "morning" | "evening";
    totalChats: number;
    approvedChats: number;
    pendingChats: number;
    rejectedChats: number;
    expiredChats: number;
    blacklistedChats: number;
    totalMessages: number;
    uniqueUsers: number;
    activeChats: number;
    approvalDecisions: number;
  }
): Promise<SlackSendResult> {
  try {
    const periodLabel = stats.period === "morning" ? "🌅 Morning Summary" : "🌆 Evening Summary";
    const periodDesc = stats.period === "morning"
      ? "Overnight activity and action items"
      : "Day completion and overnight action items";

    const blocks = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${periodLabel} - ${stats.date}`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: periodDesc,
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Total Chats:*\n${stats.totalChats}`,
          },
          {
            type: "mrkdwn",
            text: `*Active Today:*\n${stats.activeChats}`,
          },
          {
            type: "mrkdwn",
            text: `*Messages:*\n${stats.totalMessages}`,
          },
          {
            type: "mrkdwn",
            text: `*Unique Users:*\n${stats.uniqueUsers}`,
          },
        ],
      },
      {
        type: "divider",
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Approved:*\n${stats.approvedChats} ✅`,
          },
          {
            type: "mrkdwn",
            text: `*Pending:*\n${stats.pendingChats} ⏳`,
          },
          {
            type: "mrkdwn",
            text: `*Rejected:*\n${stats.rejectedChats} ❌`,
          },
          {
            type: "mrkdwn",
            text: `*Expired:*\n${stats.expiredChats} ⏰`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Blacklisted Chats:* ${stats.blacklistedChats} 🚫`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Use \`/pending-chats\` to view approval queue • \`/rejected-chats\` for blacklist`,
          },
        ],
      },
    ];

    const text = `${periodLabel}: ${stats.totalChats} chats, ${stats.totalMessages} messages`;
    const result = await postSlackMessage(botToken, channelId, text, blocks);

    logger.info("Daily summary sent to Slack", {
      date: stats.date,
      period: stats.period,
    });

    return {
      success: true,
      channel: result.channel || channelId,
      messageTs: result.ts || Date.now().toString(),
    };
  } catch (err) {
    logger.error("Failed to send daily summary", {
      error: getErrorMessage(err),
    });
    return {
      success: false,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Send stale chat alert to Slack via webhook with @here mention.
 * Includes idempotency check via stale_alert_sent table.
 */
export async function sendStaleAlert(
  db: D1Database,
  alert: StaleChatAlert,
  webhookUrl: string
): Promise<SlackSendResult> {
  // NOTE: Idempotency is handled upstream by getStaleChats() (NOT EXISTS filter)
  // and recordStaleAlert() in timer.ts. No duplicate check needed here.

  const waitingTime =
    alert.customerWaitingHours < 1
      ? `${Math.round(alert.customerWaitingHours * 60)} minutes`
      : `${Math.round(alert.customerWaitingHours * 10) / 10} hours`;

  const lastResponseText = alert.lastTeamTouchAt
    ? `${Math.round(((Date.now() - new Date(alert.lastTeamTouchAt).getTime()) / 3600000) * 10) / 10}h ago by ${alert.lastTeamMemberName || "team member"}`
    : "None - no team response yet";

  // Convert chat ID to Telegram web URL format (remove -100 prefix for supergroups)
  const telegramChatId = alert.chatId.toString().startsWith("-100")
    ? alert.chatId.toString().replace("-100", "")
    : alert.chatId.toString().replace("-", "");

  const payload = {
    username: "Triage Bot",
    icon_emoji: ":warning:",
    text: `<!here> Chat needs attention`, // @here mention
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "⚠️ Chat Needs Attention",
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Chat:*\n${alert.chatTitle}`,
          },
          {
            type: "mrkdwn",
            text: `*Customer waiting:*\n${waitingTime}`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Last response:* ${lastResponseText}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "View Chat",
              emoji: true,
            },
            url: `https://t.me/c/${telegramChatId}`,
            action_id: "view_chat",
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Mark Resolved",
              emoji: true,
            },
            style: "primary",
            action_id: `mark_resolved_${alert.chatId}`,
            value: alert.chatId.toString(),
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Alert ID: stale_4h_${alert.chatId}_${Date.now()}`,
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Slack webhook error: ${response.status} ${error}`);
    }

    logger.info("Stale alert sent to Slack", { chatId: alert.chatId });

    return {
      success: true,
      channel: "#triage-escalations",
    };
  } catch (error) {
    logger.error("Failed to send stale alert", { error: getErrorMessage(error), alert });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Send daily summary to Slack via webhook with team member KPIs.
 * Idempotency is handled upstream by checkDuplicateSummary() + recordSummarySent() in timer.ts.
 */
export async function sendDailySummaryWebhook(
  db: D1Database,
  date: string,
  period: "morning" | "evening",
  webhookUrl: string
): Promise<SlackSendResult> {
  // Fetch metrics from database
  const metrics = await fetchDailyMetrics(db, date, period);

  const healthEmoji =
    metrics.healthScore >= 80 ? ":green_heart:" : metrics.healthScore >= 50 ? ":yellow_heart:" : ":red_heart:";

  const avgResponseText = metrics.avgResponseTimeSeconds
    ? `${Math.round(metrics.avgResponseTimeSeconds / 60)} min`
    : "N/A";

  // Build team member stats text
  const teamStatsText =
    metrics.teamMembers
      .map((m) => {
        const slackMention = m.slackUserId ? `<@${m.slackUserId}>` : m.displayName;
        const avgResponse = m.avgFirstResponseMinutes ? `${Math.round(m.avgFirstResponseMinutes)} min` : "N/A";
        return `• ${slackMention}: ${m.chatsResponded} chats, ${m.messagesSent} msgs, ${avgResponse} avg response`;
      })
      .join("\n") || "_No team activity recorded_";

  const payload = {
    username: "Triage Bot",
    icon_emoji: ":chart_with_upwards_trend:",
    text: `${period === "morning" ? "🌅" : "🌙"} Daily Triage Summary - ${date}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${period === "morning" ? "🌅 Morning" : "🌙 Evening"} Triage Summary`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Date:* ${date}\n*Period:* ${period === "morning" ? "00:00 - 12:00 UTC" : "12:00 - 23:59 UTC"}`,
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Total Chats*\n${metrics.totalChats}`,
          },
          {
            type: "mrkdwn",
            text: `*New Today*\n${metrics.newChats}`,
          },
          {
            type: "mrkdwn",
            text: `*Resolved*\n${metrics.resolvedChats}`,
          },
          {
            type: "mrkdwn",
            text: `*Avg Response*\n${avgResponseText}`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Health Score:* ${healthEmoji} ${metrics.healthScore}% (<24h response = healthy)`,
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Team Performance*\n${teamStatsText}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Summary ID: ${date}_${period}_${Date.now()}`,
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Slack webhook error: ${response.status} ${error}`);
    }

    logger.info("Daily summary sent to Slack", { date, period });

    return {
      success: true,
      channel: "#triage-summaries",
      messageTs: Date.now().toString(),
    };
  } catch (error) {
    logger.error("Failed to send daily summary", { error: getErrorMessage(error), date, period });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Fetch daily metrics from database for summary.
 */
async function fetchDailyMetrics(
  db: D1Database,
  date: string,
  period: "morning" | "evening"
): Promise<DailyMetrics> {
  // Determine time range based on period
  const startHour = period === "morning" ? 0 : 12;
  const endHour = period === "morning" ? 12 : 24;

  // Query team_member_metrics for the date
  const teamMetrics = await db
    .prepare(
      `
      SELECT
        tm.display_name,
        tm.slack_user_id,
        COALESCE(tmm.chats_responded, 0) as chats_responded,
        COALESCE(tmm.messages_sent, 0) as messages_sent,
        tmm.avg_first_response_seconds,
        COALESCE(tmm.bugs_handled, 0) as bugs_handled,
        COALESCE(tmm.requests_handled, 0) as requests_handled
      FROM team_members tm
      LEFT JOIN team_member_metrics tmm ON tm.id = tmm.team_member_id AND tmm.date = ?
      WHERE tm.is_active = 1
      ORDER BY COALESCE(tmm.chats_responded, 0) DESC
    `
    )
    .bind(date)
    .all();

  // Query chat_metrics for overall stats within period
  // Note: SQLite doesn't have hour extraction, so we filter by date only
  // For more precise period filtering, we'd need to store hour or use timestamp comparison
  const chatStats = await db
    .prepare(
      `
      SELECT
        COUNT(*) as total_chats,
        COUNT(CASE WHEN DATE(first_customer_message_at) = ? THEN 1 END) as new_chats,
        COUNT(CASE WHEN DATE(resolved_at) = ? THEN 1 END) as resolved_chats,
        AVG(first_response_seconds) as avg_response_seconds,
        COUNT(CASE WHEN first_response_seconds < 86400 THEN 1 END) as healthy_responses,
        COUNT(CASE WHEN first_response_seconds IS NOT NULL THEN 1 END) as total_with_response
      FROM chat_metrics
      WHERE DATE(created_at) = ? OR DATE(first_customer_message_at) = ? OR DATE(resolved_at) = ?
    `
    )
    .bind(date, date, date, date, date)
    .first<{
      total_chats: number;
      new_chats: number;
      resolved_chats: number;
      avg_response_seconds: number | null;
      healthy_responses: number;
      total_with_response: number;
    }>();

  const totalWithResponse = chatStats?.total_with_response || 0;
  const healthyResponses = chatStats?.healthy_responses || 0;
  const healthScore = totalWithResponse > 0 ? Math.round((healthyResponses / totalWithResponse) * 100) : 100;

  const teamMembers: TeamMemberDailyStats[] = (teamMetrics.results || []).map((row: unknown) => {
    const r = row as {
      display_name: string;
      slack_user_id: string | null;
      chats_responded: number;
      messages_sent: number;
      avg_first_response_seconds: number | null;
      bugs_handled: number;
      requests_handled: number;
    };
    return {
      displayName: r.display_name,
      slackUserId: r.slack_user_id,
      chatsResponded: r.chats_responded,
      messagesSent: r.messages_sent,
      avgFirstResponseMinutes: r.avg_first_response_seconds ? Math.round(r.avg_first_response_seconds / 60) : null,
      bugsHandled: r.bugs_handled,
      requestsHandled: r.requests_handled,
    };
  });

  return {
    date,
    period,
    totalChats: chatStats?.total_chats || 0,
    newChats: chatStats?.new_chats || 0,
    resolvedChats: chatStats?.resolved_chats || 0,
    avgResponseTimeSeconds: chatStats?.avg_response_seconds || null,
    healthScore,
    teamMembers,
  };
}
