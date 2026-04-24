/** Slack API helpers and request verification. */

import type { PendingApproval, PriorChatSummary } from "../types/approval";
import { logger } from "./logger";
import { buildMinimalApprovalBlocks, buildRichApprovalBlocks, buildDecisionBlocks } from "./slack-blocks";

/**
 * Verify Slack request signature using signing secret.
 * @deprecated Use verifySlackRequestAsync instead for proper async handling
 */
export function verifySlackRequest(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string
): Promise<boolean> {
  // Delegate to async implementation for consistency
  return verifySlackRequestAsync(signingSecret, timestamp, body, signature);
}

/**
 * Async wrapper for verification.
 */
export async function verifySlackRequestAsync(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string
): Promise<boolean> {
  try {
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
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Send approval request to Slack via webhook.
 */
export async function sendApprovalRequestToSlack(
  webhookUrl: string,
  approval: PendingApproval,
  priorSummary: PriorChatSummary | null,
  botUsername: string
): Promise<{ slackMessageTs: string | null; slackChannelId: string | null }> {
  try {
    const blocks =
      approval.slackBlocksType === "rich" && priorSummary
        ? buildRichApprovalBlocks(approval, priorSummary, botUsername)
        : buildMinimalApprovalBlocks(approval, botUsername);

    const payload = {
      text: `🔔 New chat approval request: ${approval.chatTitle || "Untitled Chat"}`,
      blocks,
      unfurl_links: false,
    };

    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Slack webhook returned ${resp.status}: ${errorText}`);
    }

    // Webhook responses don't include message timestamp
    // We'll need to update this later via chat.postMessage for full API
    logger.info("Approval request sent to Slack", {
      pending_id: approval.id,
      chat_title: approval.chatTitle,
      blocks_type: approval.slackBlocksType,
    });

    return { slackMessageTs: null, slackChannelId: null };
  } catch (err) {
    logger.error("Failed to send Slack approval request", {
      pending_id: approval.id,
      error: err instanceof Error ? err.message : String(err),
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
      error: err instanceof Error ? err.message : String(err),
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
      error: err instanceof Error ? err.message : String(err),
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
                  text: "Select chats...",
                },
                options,
                action_id: "chat_selection",
              },
              label: {
                type: "plain_text",
                text: "Chats to Approve",
              },
              optional: true,
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "Select All",
                  },
                  action_id: "select_all",
                  value: "select_all",
                },
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "Clear",
                  },
                  action_id: "clear_selection",
                  value: "clear",
                },
              ],
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
      error: err instanceof Error ? err.message : String(err),
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
 * Send batch operation completion notification.
 */
export async function sendBatchApprovalCompleteNotification(
  webhookUrl: string,
  results: { approved: number; rejected: number; failed: number; errors: string[] },
  performedBy: string
): Promise<void> {
  try {
    const { approved, rejected, failed, errors } = results;
    const total = approved + rejected + failed;

    let color = "#36a64f"; // Green
    if (failed > 0) color = "#ff9900"; // Orange
    if (approved === 0 && rejected === 0) color = "#ff0000"; // Red

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

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Batch approval complete: ${approved} approved, ${rejected} rejected, ${failed} failed`,
        blocks,
      }),
    });
  } catch (err) {
    logger.error("Failed to send batch completion notification", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Send daily summary to Slack.
 */
export async function sendDailySummary(
  webhookUrl: string,
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
): Promise<void> {
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

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `${periodLabel}: ${stats.totalChats} chats, ${stats.totalMessages} messages`,
        blocks,
      }),
    });

    logger.info("Daily summary sent to Slack", {
      date: stats.date,
      period: stats.period,
    });
  } catch (err) {
    logger.error("Failed to send daily summary", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
