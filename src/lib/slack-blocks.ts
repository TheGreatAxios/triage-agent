/** Slack Block Kit builders for approval flow UI. */

import type { PendingApproval, PriorChatSummary } from "../types/approval";

/**
 * Build minimal approval request blocks (metadata only).
 */
export function buildMinimalApprovalBlocks(
  approval: PendingApproval,
  botUsername: string
): unknown[] {
  const chatLabel = approval.chatTitle || "Untitled Chat";
  const typeEmoji = getChatTypeEmoji(approval.chatType);
  const complexityPercent = ((approval.complexityScore || 0) * 100).toFixed(0);

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🔔 New Chat Approval Request`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*${typeEmoji} Chat:*\n${chatLabel}`,
        },
        {
          type: "mrkdwn",
          text: `*Type:*\n${approval.chatType}`,
        },
        {
          type: "mrkdwn",
          text: `*Members:*\n${approval.memberCount || "Unknown"}`,
        },
        {
          type: "mrkdwn",
          text: `*Complexity:*\n${complexityPercent}% (Low)`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Added by:* @${approval.requestedBy.username || approval.requestedBy.name}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Bot: ${botUsername} • Expires in 72h`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "✓ Approve",
            emoji: true,
          },
          style: "primary",
          value: String(approval.chatId),
          action_id: "approve_chat",
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "✗ Reject",
            emoji: true,
          },
          style: "danger",
          value: String(approval.chatId),
          action_id: "reject_chat",
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Batch Mode",
            emoji: true,
          },
          value: "open_batch",
          action_id: "open_batch_modal",
        },
      ],
    },
  ];

  return blocks;
}

/**
 * Build rich approval request blocks (with message preview and prior context).
 */
export function buildRichApprovalBlocks(
  approval: PendingApproval,
  priorSummary: PriorChatSummary,
  botUsername: string
): unknown[] {
  const chatLabel = approval.chatTitle || "Untitled Chat";
  const typeEmoji = getChatTypeEmoji(approval.chatType);
  const complexityPercent = ((approval.complexityScore || 0) * 100).toFixed(0);

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🔔 New Chat Approval Request`,
        emoji: true,
      },
    },
  ];

  // Prior summary badge
  if (priorSummary.previouslyApprovedAt) {
    const daysSince = Math.floor(
      (Date.now() - new Date(priorSummary.previouslyApprovedAt).getTime()) /
        (1000 * 60 * 60 * 24)
    );
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:repeat: *Previously approved ${daysSince} days ago* • ${priorSummary.totalMessagesExchanged} messages exchanged`,
      },
    });
  }

  // Main metadata
  blocks.push(
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*${typeEmoji} Chat:*\n${chatLabel}`,
        },
        {
          type: "mrkdwn",
          text: `*Type:*\n${approval.chatType}`,
        },
        {
          type: "mrkdwn",
          text: `*Members:*\n${approval.memberCount || "Unknown"}`,
        },
        {
          type: "mrkdwn",
          text: `*Complexity:*\n${complexityPercent}% (High)`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Added by:* @${approval.requestedBy.username || approval.requestedBy.name}`,
      },
    }
  );

  // Complexity explanation
  if (approval.complexityFactors?.explanation?.length) {
    const factors = approval.complexityFactors.explanation
      .slice(0, 3)
      .map((f) => `• ${f}`)
      .join("\n");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Context signals:*\n${factors}`,
      },
    });
  }

  // Prior summary preview (truncated)
  if (priorSummary.summaryContent) {
    const truncated = priorSummary.summaryContent.slice(0, 200);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Previous context:*\n> ${truncated}${priorSummary.summaryContent.length > 200 ? "..." : ""}`,
      },
    });
  }

  blocks.push(
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Bot: ${botUsername} • Expires in 72h`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "✓ Approve",
            emoji: true,
          },
          style: "primary",
          value: String(approval.chatId),
          action_id: "approve_chat",
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "✗ Reject",
            emoji: true,
          },
          style: "danger",
          value: String(approval.chatId),
          action_id: "reject_chat",
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Batch Mode",
            emoji: true,
          },
          value: "open_batch",
          action_id: "open_batch_modal",
        },
      ],
    }
  );

  return blocks;
}

/**
 * Build blocks showing the decision outcome.
 */
export function buildDecisionBlocks(
  decision: "approved" | "rejected" | "expired",
  decidedBy: string,
  botUsername: string
): unknown[] {
  const decisionEmoji = decision === "approved" ? "✅" : decision === "rejected" ? "❌" : "⏰";
  const decisionText = decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Expired";
  const color = decision === "approved" ? "#36a64f" : decision === "rejected" ? "#ff0000" : "#808080";

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${decisionEmoji} Approval ${decisionText}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Decision:* ${decisionText}\n*Decided by:* ${decidedBy}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Bot: ${botUsername} • ${new Date().toLocaleString()}`,
        },
      ],
    },
  ];
}

/**
 * Build blocks for blacklisted chat list.
 */
export function buildBlacklistBlocks(
  blacklistedChats: Array<{
    chatId: number;
    chatTitle: string | null;
    chatType: string;
    blacklistedAt: string;
    blacklistedBy: string | null;
  }>,
  botUsername: string
): unknown[] {
  if (blacklistedChats.length === 0) {
    return [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🚫 Blacklisted Chats",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "No blacklisted chats. All clear! ✨",
        },
      },
    ];
  }

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🚫 Blacklisted Chats (${blacklistedChats.length})`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "These chats were rejected and are automatically blocked from re-adding the bot.",
      },
    },
    {
      type: "divider",
    },
  ];

  // Show up to 10 blacklisted chats (Slack block limit considerations)
  for (const chat of blacklistedChats.slice(0, 10)) {
    const typeEmoji = getChatTypeEmoji(chat.chatType);
    const date = new Date(chat.blacklistedAt).toLocaleDateString();

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${typeEmoji} *${chat.chatTitle || "Untitled"}* (${chat.chatType})\nBlacklisted: ${date} by ${chat.blacklistedBy || "Unknown"}`,
      },
      accessory: {
        type: "button",
        text: {
          type: "plain_text",
          text: "Unblacklist",
          emoji: false,
        },
        value: String(chat.chatId),
        action_id: "unblacklist_chat",
      },
    });
  }

  if (blacklistedChats.length > 10) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `...and ${blacklistedChats.length - 10} more. Use \`/rejected-chats filter:all\` to see full list.`,
        },
      ],
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Bot: ${botUsername} • Use buttons to remove from blacklist`,
      },
    ],
  });

  return blocks;
}

/**
 * Build blocks for pending chats list (for slash command response).
 */
export function buildPendingListBlocks(
  pendingApprovals: Array<{
    chatId: number;
    chatTitle: string | null;
    chatType: string;
    memberCount: number | null;
    complexityScore: number | null;
    requestedByName: string;
    hoursPending: number;
  }>,
  filter: string,
  botUsername: string
): unknown[] {
  if (pendingApprovals.length === 0) {
    return [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "⏳ Pending Approvals",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: filter === "all"
            ? "No pending approvals. All caught up! 🎉"
            : `No pending approvals matching filter: *${filter}*`,
        },
      },
    ];
  }

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `⏳ Pending Approvals (${pendingApprovals.length})`,
        emoji: true,
      },
    },
  ];

  if (filter !== "all") {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Filter: *${filter}*`,
      },
    });
  }

  blocks.push({ type: "divider" });

  // Show up to 15 pending approvals
  for (const approval of pendingApprovals.slice(0, 15)) {
    const typeEmoji = getChatTypeEmoji(approval.chatType);
    const complexityPercent = ((approval.complexityScore || 0) * 100).toFixed(0);
    const timeWarning = approval.hoursPending > 48 ? " ⚠️ Expires soon" : "";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${typeEmoji} *${approval.chatTitle || "Untitled"}*\n${approval.chatType} • ${approval.memberCount || "?"} members • ${complexityPercent}% complexity${timeWarning}`,
      },
    });
  }

  if (pendingApprovals.length > 15) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `...and ${pendingApprovals.length - 15} more pending. Use \`/batch-approve\` for batch operations.`,
        },
      ],
    });
  }

  blocks.push(
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Batch Approve",
            emoji: true,
          },
          value: "open_batch",
          action_id: "open_batch_modal",
          style: "primary",
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Refresh",
            emoji: true,
          },
          value: "refresh",
          action_id: "refresh_pending",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Bot: ${botUsername} • Use \`/batch-approve\` for bulk operations`,
        },
      ],
    }
  );

  return blocks;
}

/**
 * Get emoji for chat type.
 */
function getChatTypeEmoji(type: string): string {
  switch (type) {
    case "private":
      return "👤";
    case "group":
      return "👥";
    case "supergroup":
      return "📢";
    case "channel":
      return "📡";
    default:
      return "💬";
  }
}
