/** Core approval flow logic with adaptive complexity scoring. */

import type {
  TelegramUpdate,
  TelegramChatMemberUpdated,
  TelegramUser,
} from "../types/telegram";
import type {
  PendingApproval,
  ApprovalDecision,
  ComplexityFactors,
  SlackBlocksType,
  PriorChatSummary,
} from "../types/approval";
import type { Env } from "../types/env";
import { logger } from "./logger";
import { getErrorMessage } from "./errors";
import {
  leaveChat,
  sendMessage,
  buildRejectionMessage,
  buildExpirationMessage,
  buildActivationMessage,
  getChatMemberCount,
} from "./telegram-api";
import {
  getChatById,
  getTelegramChatId,
  getChatByTelegramId,
  createOrUpdateChat,
  createPendingApproval,
  getPendingApprovalByChatId,
  updateChatApprovalStatus,
  resolvePendingApproval,
  getPriorChatSummary,
  getRecentMessagesForComplexity,
  recordMembershipEvent,
  getBotMetadataFromDb,
  saveBotMetadataToDb,
} from "./persistence";
import {
  sendApprovalRequestToSlack,
  updateSlackMessageWithDecision,
  sendBatchApprovalCompleteNotification,
} from "./slack";
import { buildMinimalApprovalBlocks, buildRichApprovalBlocks } from "./slack-blocks";

// Urgency keywords that increase complexity score
const URGENCY_KEYWORDS = [
  "urgent", "asap", "emergency", "critical", "down", "broken",
  "outage", "error", "failed", "failure", "problem", "issue",
  "help", "support", "bug", "crash", "immediate", "now",
];

// Code/link indicators
const CODE_PATTERNS = [
  /```[\s\S]*?```/, // Code blocks
  /`[^`]+`/, // Inline code
  /https?:\/\/\S+/i, // URLs
];

/**
 * Calculate complexity score (0.0 to 1.0) based on chat characteristics.
 */
function calculateComplexity(
  memberCount: number,
  messages: Array<{ text: string | null; created_at: string }>,
  priorSummaryExists: boolean
): { score: number; factors: ComplexityFactors } {
  const explanation: string[] = [];
  let score = 0;

  // Member count weight (0.3)
  const memberScore = Math.min(memberCount / 50, 1) * 0.3;
  score += memberScore;
  if (memberCount > 10) {
    explanation.push(`${memberCount} members indicates active group`);
  }

  // Message density calculation (0.25)
  let messageDensity = 0;
  if (messages.length >= 2) {
    const timeSpan =
      new Date(messages[0].created_at).getTime() -
      new Date(messages[messages.length - 1].created_at).getTime();
    const hours = timeSpan / (1000 * 60 * 60);
    messageDensity = hours > 0 ? messages.length / hours : messages.length;
  }
  const densityScore = Math.min(messageDensity / 10, 1) * 0.25;
  score += densityScore;
  if (messageDensity > 5) {
    explanation.push(`High message density (${messageDensity.toFixed(1)}/hour)`);
  }

  // Urgency signals (0.25)
  let urgencyCount = 0;
  for (const msg of messages) {
    if (!msg.text) continue;
    const lowerText = msg.text.toLowerCase();
    for (const keyword of URGENCY_KEYWORDS) {
      if (lowerText.includes(keyword)) {
        urgencyCount++;
      }
    }
  }
  const urgencyScore = Math.min(urgencyCount / 3, 1) * 0.25;
  score += urgencyScore;
  if (urgencyCount > 0) {
    explanation.push(`${urgencyCount} urgency signals detected`);
  }

  // Question count (0.1)
  let questionCount = 0;
  for (const msg of messages) {
    if (msg.text && msg.text.includes("?")) {
      questionCount++;
    }
  }
  const questionScore = Math.min(questionCount / 2, 1) * 0.1;
  score += questionScore;
  if (questionCount > 0) {
    explanation.push(`${questionCount} questions in recent messages`);
  }

  // Links/code indicators (0.1)
  let hasLinksOrCode = false;
  for (const msg of messages) {
    if (!msg.text) continue;
    for (const pattern of CODE_PATTERNS) {
      if (pattern.test(msg.text)) {
        hasLinksOrCode = true;
        break;
      }
    }
    if (hasLinksOrCode) break;
  }
  const codeScore = hasLinksOrCode ? 0.1 : 0;
  score += codeScore;
  if (hasLinksOrCode) {
    explanation.push("Code snippets or links detected");
  }

  // Prior summary bonus (adds to explanation but not raw score - affects threshold)
  if (priorSummaryExists) {
    explanation.push("Prior chat history available");
  }

  // Boost score slightly if prior summary exists
  if (priorSummaryExists) {
    score = Math.min(score + 0.15, 1.0);
  }

  return {
    score: Math.min(score, 1.0),
    factors: {
      memberCount,
      messageDensity,
      urgencySignals: urgencyCount,
      questionCount,
      hasLinksOrCode,
      priorSummaryExists,
      explanation,
    },
  };
}

/**
 * Determine if we should use rich or minimal Slack blocks.
 */
function determineBlocksType(
  complexityScore: number,
  memberCount: number,
  priorSummaryExists: boolean
): SlackBlocksType {
  // Threshold: 0.6 complexity OR >10 members OR prior summary
  if (complexityScore > 0.6 || memberCount > 10 || priorSummaryExists) {
    return "rich";
  }
  return "minimal";
}

/**
 * Get bot metadata, fetching from API if not cached.
 */
async function getBotMetadata(env: Env): Promise<{ username: string; firstName: string } | null> {
  // Try cache first
  const cached = await getBotMetadataFromDb(env.DB);
  if (cached) {
    return cached;
  }

  // Fetch from Telegram API
  const { getBotMetadata: fetchBotMetadata } = await import("./telegram-api");
  const meta = await fetchBotMetadata(env.TELEGRAM_BOT_TOKEN);
  if (!meta) {
    return null;
  }

  // Cache in D1
  await saveBotMetadataToDb(env.DB, meta);
  return { username: meta.username, firstName: meta.firstName };
}

/**
 * Handle bot being added to a new chat.
 * Returns true if this was an approval-triggering event (new pending created).
 */
export async function handleBotAddedToChat(
  env: Env,
  update: TelegramUpdate
): Promise<boolean> {
  const memberUpdate = update.my_chat_member ?? update.chat_member;
  if (!memberUpdate) {
    return false;
  }

  const { new_chat_member, old_chat_member, chat, from } = memberUpdate;

  // Check if bot was actually added (transitioned to member)
  const wasAdded =
    new_chat_member.status === "member" &&
    (!old_chat_member ||
      ["left", "kicked", "restricted"].includes(old_chat_member.status));

  if (!wasAdded) {
    return false;
  }

  // Check if this is our bot
  const botMeta = await getBotMetadata(env);
  if (!botMeta) {
    logger.error("Could not fetch bot metadata");
    return false;
  }

  // Note: We can't easily verify the user ID matches without storing it,
  // but the my_chat_member update is specifically for our bot
  logger.info("Bot was added to chat", {
    telegram_chat_id: chat.id,
    chat_title: chat.title,
    added_by: from.username || from.first_name,
  });

  // Get or create chat record
  let chatRecord = await getChatByTelegramId(env.DB, chat.id);

  // Check if blacklisted - immediate reject
  if (chatRecord && chatRecord.is_blacklisted) {
    logger.info("Chat is blacklisted, rejecting immediately", {
      telegram_chat_id: chat.id,
    });

    // Leave chat immediately
    await leaveChat(chat.id, env.TELEGRAM_BOT_TOKEN);

    // Record the auto-rejection
    await recordMembershipEvent(env.DB, chatRecord.id, "auto_rejected_blacklist", null, {
      reason: "Previously rejected and blacklisted",
    });

    return true;
  }

  // Check if already approved - no action needed
  if (chatRecord && chatRecord.approval_status === "approved") {
    logger.info("Chat already approved, no approval needed", {
      telegram_chat_id: chat.id,
    });
    return false;
  }

  // Create or update chat record
  let targetChatId: number;
  if (!chatRecord) {
    const newChat = await createOrUpdateChat(env.DB, {
      telegramChatId: chat.id,
      type: chat.type,
      title: chat.title || null,
      username: chat.username || null,
      approvalStatus: "pending",
    });
    targetChatId = newChat.id;
  } else {
    // Reset to pending if previously rejected/expired
    await updateChatApprovalStatus(env.DB, chatRecord.id, "pending", null);
    targetChatId = chatRecord.id;
  }

  // Get member count
  const memberCount = await getChatMemberCount(chat.id, env.TELEGRAM_BOT_TOKEN);

  // Fetch recent messages for complexity calculation (if any exist)
  const recentMessages = await getRecentMessagesForComplexity(env.DB, targetChatId, 5);

  // Check for prior summary
  const priorSummary = await getPriorChatSummary(env.DB, targetChatId);

  // Calculate complexity
  const { score, factors } = calculateComplexity(
    memberCount || 1,
    recentMessages,
    !!priorSummary
  );

  // Determine block type
  const blocksType = determineBlocksType(score, memberCount || 1, !!priorSummary);

  logger.info("Calculated complexity for approval", {
    chat_id: targetChatId,
    complexity_score: score.toFixed(2),
    blocks_type: blocksType,
    factors: factors.explanation,
  });

  // Create pending approval record
  const pendingApproval = await createPendingApproval(env.DB, {
    chatId: targetChatId,
    requestedByName: from.first_name,
    requestedByUsername: from.username || null,
    requestedByUserId: from.id,
    chatType: chat.type,
    chatTitle: chat.title || null,
    chatUsername: chat.username || null,
    memberCount,
    complexityScore: score,
    complexityFactors: factors,
    slackBlocksType: blocksType,
  });

  // Send approval request to Slack
  try {
    const { slackMessageTs, slackChannelId } = await sendApprovalRequestToSlack(
      env.SLACK_BOT_TOKEN,
      env.SLACK_APPROVAL_CHANNEL_ID,
      pendingApproval,
      priorSummary,
      botMeta.username
    );

    // Update pending approval with Slack message reference
    if (slackMessageTs && slackChannelId) {
      const { updateSlackMessageRef } = await import("./persistence");
      await updateSlackMessageRef(
        env.DB,
        pendingApproval.id,
        slackMessageTs,
        slackChannelId
      );
    }
  } catch (err) {
    logger.error("Failed to send approval request to Slack", {
      pending_approval_id: pendingApproval.id,
      error: getErrorMessage(err),
    });
  }

  // Record membership event
  await recordMembershipEvent(env.DB, targetChatId, "added", null, {
    added_by_user_id: from.id,
    added_by_username: from.username,
    complexity_score: score,
  });

  return true;
}

/**
 * Handle bot being removed from a chat.
 * Resets approval status so re-addition requires fresh approval.
 */
export async function handleBotRemovedFromChat(
  env: Env,
  update: TelegramUpdate
): Promise<boolean> {
  const memberUpdate = update.my_chat_member ?? update.chat_member;
  if (!memberUpdate) {
    return false;
  }

  const { new_chat_member, old_chat_member, chat } = memberUpdate;

  // Check if bot was removed
  const wasRemoved =
    ["left", "kicked"].includes(new_chat_member.status) &&
    old_chat_member?.status === "member";

  if (!wasRemoved) {
    return false;
  }

  const chatRecord = await getChatByTelegramId(env.DB, chat.id);
  if (!chatRecord) {
    return false;
  }

  logger.info("Bot was removed from chat, resetting approval status", {
    chat_id: chatRecord.id,
    telegram_chat_id: chat.id,
    new_status: new_chat_member.status,
  });

  // Reset approval status to require re-approval
  await updateChatApprovalStatus(env.DB, chatRecord.id, "pending", null);

  // Record the removal
  await recordMembershipEvent(env.DB, chatRecord.id, "removed", null, {
    new_status: new_chat_member.status,
  });

  // Cancel any pending approval
  const pending = await getPendingApprovalByChatId(env.DB, chatRecord.id);
  if (pending && pending.status === "pending") {
    await resolvePendingApproval(env.DB, pending.id, "expired", null, null);
  }

  return true;
}

/**
 * Approve a chat and activate the bot.
 */
export async function approveChat(
  env: Env,
  decision: ApprovalDecision
): Promise<{ success: boolean; message: string }> {
  const { chatId, slackUserId, slackUserName } = decision;

  try {
    // Get pending approval
    const pending = await getPendingApprovalByChatId(env.DB, chatId);
    if (!pending || pending.status !== "pending") {
      return { success: false, message: "No pending approval found for this chat" };
    }

    // Update chat status
    await updateChatApprovalStatus(env.DB, chatId, "approved", slackUserName);

    // Resolve pending approval
    await resolvePendingApproval(env.DB, pending.id, "approved", slackUserId, slackUserName);

    // Record event
    await recordMembershipEvent(env.DB, chatId, "approved", slackUserName, {
      slack_user_id: slackUserId,
    });

    // Send activation notification if enabled
    const notifyOnApproval = env.NOTIFY_ON_APPROVAL === "true";
    if (notifyOnApproval) {
      const botMeta = await getBotMetadata(env);
      const telegramChatId = await getTelegramChatId(env.DB, chatId);
      if (telegramChatId && botMeta) {
        const activationMsg = buildActivationMessage(botMeta.username);
        await sendMessage(telegramChatId, activationMsg, env.TELEGRAM_BOT_TOKEN);
      }
    }

    // Update Slack message
    if (pending.slackMessageTs && pending.slackChannelId) {
      const botMeta = await getBotMetadata(env);
      await updateSlackMessageWithDecision(
        env.SLACK_BOT_TOKEN,
        pending.slackChannelId,
        pending.slackMessageTs,
        "approved",
        slackUserName,
        botMeta?.username || "Bot"
      );
    }

    logger.info("Chat approved successfully", {
      chat_id: chatId,
      approved_by: slackUserName,
    });

    return { success: true, message: `Chat approved by ${slackUserName}` };
  } catch (err) {
    logger.error("Error approving chat", {
      chat_id: chatId,
      error: getErrorMessage(err),
    });
    return { success: false, message: "Internal error during approval" };
  }
}

/**
 * Reject a chat, blacklist it, and leave.
 */
export async function rejectChat(
  env: Env,
  decision: ApprovalDecision
): Promise<{ success: boolean; message: string }> {
  const { chatId, slackUserId, slackUserName } = decision;

  try {
    // Get pending approval
    const pending = await getPendingApprovalByChatId(env.DB, chatId);
    if (!pending || pending.status !== "pending") {
      return { success: false, message: "No pending approval found for this chat" };
    }

    // Get chat details for rejection message
    const chatRecord = await getChatById(env.DB, chatId);
    if (!chatRecord) {
      return { success: false, message: "Chat record not found" };
    }

    // Send rejection message to chat before leaving
    const botMeta = await getBotMetadata(env);
    if (botMeta) {
      const rejectionMsg = buildRejectionMessage(
        pending.chatTitle,
        botMeta.username,
        slackUserName
      );
      await sendMessage(chatRecord.telegram_chat_id, rejectionMsg, env.TELEGRAM_BOT_TOKEN);
    }

    // Leave the chat
    await leaveChat(chatRecord.telegram_chat_id, env.TELEGRAM_BOT_TOKEN);

    // Update chat status to rejected + blacklisted
    await updateChatApprovalStatus(env.DB, chatId, "rejected", slackUserName, true);

    // Resolve pending approval
    await resolvePendingApproval(env.DB, pending.id, "rejected", slackUserId, slackUserName);

    // Record event
    await recordMembershipEvent(env.DB, chatId, "rejected", slackUserName, {
      slack_user_id: slackUserId,
      blacklisted: true,
    });

    // Update Slack message
    if (pending.slackMessageTs && pending.slackChannelId) {
      const botMeta = await getBotMetadata(env);
      await updateSlackMessageWithDecision(
        env.SLACK_BOT_TOKEN,
        pending.slackChannelId,
        pending.slackMessageTs,
        "rejected",
        slackUserName,
        botMeta?.username || "Bot"
      );
    }

    logger.info("Chat rejected and blacklisted", {
      chat_id: chatId,
      rejected_by: slackUserName,
    });

    return { success: true, message: `Chat rejected by ${slackUserName} and blacklisted` };
  } catch (err) {
    logger.error("Error rejecting chat", {
      chat_id: chatId,
      error: getErrorMessage(err),
    });
    return { success: false, message: "Internal error during rejection" };
  }
}

/**
 * Remove a chat from the blacklist and create fresh approval request.
 */
export async function unblacklistChat(
  env: Env,
  decision: ApprovalDecision
): Promise<{ success: boolean; message: string }> {
  const { chatId, slackUserId, slackUserName } = decision;

  try {
    const chatRecord = await getChatById(env.DB, chatId);
    if (!chatRecord) {
      return { success: false, message: "Chat record not found" };
    }

    if (!chatRecord.is_blacklisted) {
      return { success: false, message: "Chat is not blacklisted" };
    }

    // Remove from blacklist but keep as pending
    await updateChatApprovalStatus(env.DB, chatId, "pending", null, false);

    // Record event
    await recordMembershipEvent(env.DB, chatId, "unblacklisted", slackUserName, {
      slack_user_id: slackUserId,
    });

    // Create fresh approval request
    // Simulate a new add event
    const mockUpdate: TelegramUpdate = {
      update_id: Date.now(),
      my_chat_member: {
        chat: {
          id: chatRecord.telegram_chat_id,
          type: chatRecord.type as any,
          title: chatRecord.title || undefined,
          username: chatRecord.username || undefined,
        },
        from: {
          id: 0,
          is_bot: false,
          first_name: "Manual",
          username: "unblacklist",
        },
        date: Math.floor(Date.now() / 1000),
        new_chat_member: {
          user: { id: 0, is_bot: true, first_name: "Bot" },
          status: "member",
        },
      },
    };

    const triggered = await handleBotAddedToChat(env, mockUpdate);

    logger.info("Chat unblacklisted and new approval requested", {
      chat_id: chatId,
      unblacklisted_by: slackUserName,
    });

    return {
      success: true,
      message: `Chat removed from blacklist by ${slackUserName}. New approval request created.`,
    };
  } catch (err) {
    logger.error("Error unblacklisting chat", {
      chat_id: chatId,
      error: getErrorMessage(err),
    });
    return { success: false, message: "Internal error during unblacklist" };
  }
}

/**
 * Process batch approval decisions.
 */
export async function batchProcessApprovals(
  env: Env,
  decisions: ApprovalDecision[]
): Promise<{
  approved: number;
  rejected: number;
  failed: number;
  errors: string[];
}> {
  const results = { approved: 0, rejected: 0, failed: 0, errors: [] as string[] };

  for (const decision of decisions) {
    let result: { success: boolean; message: string };

    if (decision.action === "approve") {
      result = await approveChat(env, decision);
      if (result.success) results.approved++;
      else {
        results.failed++;
        results.errors.push(`Chat ${decision.chatId}: ${result.message}`);
      }
    } else if (decision.action === "reject") {
      result = await rejectChat(env, decision);
      if (result.success) results.rejected++;
      else {
        results.failed++;
        results.errors.push(`Chat ${decision.chatId}: ${result.message}`);
      }
    } else if (decision.action === "unblacklist") {
      result = await unblacklistChat(env, decision);
      if (result.success) results.approved++;
      else {
        results.failed++;
        results.errors.push(`Chat ${decision.chatId}: ${result.message}`);
      }
    }
  }

  // Send batch completion notification
  const slackUserName = decisions[0]?.slackUserName || "Unknown";
  await sendBatchApprovalCompleteNotification(
    env.SLACK_BOT_TOKEN,
    env.SLACK_APPROVAL_CHANNEL_ID,
    results,
    slackUserName
  );

  return results;
}

/**
 * Check and expire pending approvals past 72 hours.
 */
export async function expirePendingApprovals(env: Env): Promise<number> {
  const { getExpiredPendingApprovals, resolvePendingApproval } = await import(
    "./persistence"
  );

  const expired = await getExpiredPendingApprovals(env.DB);
  let count = 0;

  const botMeta = await getBotMetadata(env);

  for (const pending of expired) {
    try {
      // Get chat details
      const chatRecord = await getChatById(env.DB, pending.chatId);
      if (!chatRecord) continue;

      // Send expiration message
      if (botMeta) {
        const expirationMsg = buildExpirationMessage(botMeta.username);
        await sendMessage(chatRecord.telegram_chat_id, expirationMsg, env.TELEGRAM_BOT_TOKEN);
      }

      // Leave chat
      await leaveChat(chatRecord.telegram_chat_id, env.TELEGRAM_BOT_TOKEN);

      // Update status
      await updateChatApprovalStatus(env.DB, pending.chatId, "pending", null);

      // Resolve as expired
      await resolvePendingApproval(env.DB, pending.id, "expired", null, null);

      // Update Slack message
      if (pending.slackMessageTs && pending.slackChannelId) {
        await updateSlackMessageWithDecision(
          env.SLACK_BOT_TOKEN,
          pending.slackChannelId,
          pending.slackMessageTs,
          "expired",
          "System",
          botMeta?.username || "Bot"
        );
      }

      // Record event
      await recordMembershipEvent(env.DB, pending.chatId, "expired", "system", {
        reason: "72 hour timeout",
      });

      count++;
      logger.info("Expired pending approval", { pending_id: pending.id });
    } catch (err) {
      logger.error("Error expiring approval", {
        pending_id: pending.id,
        error: getErrorMessage(err),
      });
    }
  }

  return count;
}

// Note: Helper functions getChatById and getTelegramChatId are imported from persistence.ts at top of file
