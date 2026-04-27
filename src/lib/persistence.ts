import type { InternalEvent } from "../types/events";
import type { TelegramChat } from "../types/telegram";
import type { ClassificationResult } from "../types/classification";
import { logger } from "./logger";
import { incrementMessageCounters, incrementClassificationCounter } from "./counters";

export interface PersistResult {
  chatId: number;
  messageId: number;
}

/**
 * Persist an InternalEvent to D1: upsert chat, upsert participant, insert message.
 * Uses INSERT OR IGNORE / ON CONFLICT for idempotency on duplicate delivery.
 * Returns internal DB IDs for downstream use (e.g., classification persistence).
 *
 * TODO: Multi-source support:
 * 1. Abstract chatMeta: TelegramChat -> generic ChatInfo with source field
 * 2. upsertChat should use event.source instead of hardcoded telegram_chat_id
 * 3. Add source-specific ID columns (e.g., external_chat_id) or use JSON metadata
 */
export async function persistEvent(
  db: D1Database,
  event: InternalEvent,
  chatMeta: TelegramChat
): Promise<PersistResult> {
  const chatId = await upsertChat(db, chatMeta);
  const participantId = await upsertParticipant(db, chatId, event);
  const messageId = await insertMessage(db, chatId, participantId, event);
  return { chatId, messageId };
}

async function upsertChat(db: D1Database, chat: TelegramChat): Promise<number> {
  // Upsert: update title and timestamp if chat already exists
  // This handles Telegram group title changes and duplicate webhook deliveries
  await db
    .prepare(
      `INSERT INTO chats (telegram_chat_id, type, title)
       VALUES (?, ?, ?)
       ON CONFLICT (telegram_chat_id) DO UPDATE SET
         title = excluded.title,
         updated_at = datetime('now')`
    )
    .bind(chat.id, chat.type, chat.title ?? null)
    .run();

  // Retrieve the internal ID (whether just inserted or existing)
  const row = await db
    .prepare(
      `SELECT id FROM chats WHERE telegram_chat_id = ?`
    )
    .bind(chat.id)
    .first<{ id: number }>();

  if (!row) throw new Error(`Failed to upsert chat ${chat.id}`);
  return row.id;
}

async function upsertParticipant(
  db: D1Database,
  chatId: number,
  event: InternalEvent
): Promise<number> {
  // Upsert on composite unique key (chat_id, telegram_user_id)
  // Updates display name/username in case user changed them
  // Always updates last_seen_at for activity tracking
  await db
    .prepare(
      `INSERT INTO chat_participants (chat_id, telegram_user_id, is_bot, display_name, username)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, telegram_user_id) DO UPDATE SET
         display_name = excluded.display_name,
         username = excluded.username,
         last_seen_at = datetime('now')`
    )
    .bind(chatId, event.sender.id, event.sender.isBot ? 1 : 0, event.sender.name, event.sender.username ?? null)
    .run();

  // Retrieve internal participant ID for message insertion FK
  const row = await db
    .prepare(
      `SELECT id FROM chat_participants WHERE chat_id = ? AND telegram_user_id = ?`
    )
    .bind(chatId, event.sender.id)
    .first<{ id: number }>();

  if (!row) throw new Error(`Failed to upsert participant ${event.sender.id}`);
  return row.id;
}

async function insertMessage(
  db: D1Database,
  chatId: number,
  senderId: number,
  event: InternalEvent
): Promise<number> {
  // Idempotency: ignore duplicates from Telegram webhook redeliveries
  // Composite unique constraint on (chat_id, telegram_message_id)
  const result = await db
    .prepare(
      `INSERT INTO active_messages (source, chat_id, telegram_message_id, sender_id, text, event_type, is_mention, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, telegram_message_id) DO NOTHING`
    )
    .bind(
      event.source,
      chatId,
      event.messageId,
      senderId,
      event.text,
      event.type,
      event.isMention ? 1 : 0,
      event.timestamp
    )
    .run();

  // Log duplicate detection (changes === 0 means row was skipped)
  if (result.meta.changes === 0) {
    logger.info("Duplicate message ignored", {
      chatId,
      messageId: event.messageId,
    });
  }

  // Retrieve internal message ID for classification persistence
  const row = await db
    .prepare(
      `SELECT id FROM active_messages WHERE chat_id = ? AND telegram_message_id = ?`
    )
    .bind(chatId, event.messageId)
    .first<{ id: number }>();

  if (!row) throw new Error(`Failed to insert message ${event.messageId}`);

  // Increment counters for D1 row optimization (non-blocking)
  // This maintains running totals to eliminate expensive COUNT(*) queries
  if (result.meta.changes > 0) {
    await incrementMessageCounters(db, chatId, "messages");
  }

  return row.id;
}

/**
 * Persist a classification result for a message.
 * Note: No ON CONFLICT clause - we want to record every classification attempt
 * for analytics, even if the same message is classified multiple times.
 */
export async function persistClassification(
  db: D1Database,
  messageId: number,
  chatId: number,
  result: ClassificationResult
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO classifications (message_id, chat_id, label, confidence, method, reasoning)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(messageId, chatId, result.label, result.confidence, result.method, result.reasoning)
    .run();

  // Increment classification counter for D1 row optimization
  // Maintains running totals to eliminate expensive aggregations
  await incrementClassificationCounter(db, chatId, result.label);
}

// ============================================================================
// APPROVAL FLOW QUERIES
// ============================================================================

import type {
  PendingApproval,
  ComplexityFactors,
  BlacklistedChat,
  PriorChatSummary,
  ApprovalStatus,
  ChatType,
  SlackBlocksType,
} from "../types/approval";
import type { BotMetadata } from "../types/approval";

/**
 * Get chat by internal ID.
 */
export async function getChatById(
  db: D1Database,
  chatId: number
): Promise<{
  id: number;
  telegram_chat_id: number;
  type: string;
  title: string | null;
  username: string | null;
  approval_status: string;
  is_blacklisted: number;
} | null> {
  return db
    .prepare(
      `SELECT id, telegram_chat_id, type, title, username, approval_status, is_blacklisted
       FROM chats WHERE id = ?`
    )
    .bind(chatId)
    .first<{
      id: number;
      telegram_chat_id: number;
      type: string;
      title: string | null;
      username: string | null;
      approval_status: string;
      is_blacklisted: number;
    }>();
}

/**
 * Get chat by Telegram ID.
 */
export async function getChatByTelegramId(
  db: D1Database,
  telegramChatId: number
): Promise<{
  id: number;
  telegram_chat_id: number;
  type: string;
  title: string | null;
  username: string | null;
  approval_status: string;
  is_blacklisted: number;
  first_added_at: string | null;
} | null> {
  return db
    .prepare(
      `SELECT id, telegram_chat_id, type, title, username, approval_status, is_blacklisted, first_added_at
       FROM chats WHERE telegram_chat_id = ?`
    )
    .bind(telegramChatId)
    .first<{
      id: number;
      telegram_chat_id: number;
      type: string;
      title: string | null;
      username: string | null;
      approval_status: string;
      is_blacklisted: number;
      first_added_at: string | null;
    }>();
}

/**
 * Create or update chat with approval tracking.
 */
export async function createOrUpdateChat(
  db: D1Database,
  data: {
    telegramChatId: number;
    type: string;
    title: string | null;
    username?: string | null;
    approvalStatus?: string;
  }
): Promise<{ id: number; telegram_chat_id: number; type: string; title: string | null; username: string | null; approval_status: string; is_blacklisted: number; first_added_at: string | null }> {
  await db
    .prepare(
      `INSERT INTO chats (telegram_chat_id, type, title, username, approval_status, first_added_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (telegram_chat_id) DO UPDATE SET
         title = COALESCE(excluded.title, chats.title),
         username = COALESCE(excluded.username, chats.username),
         updated_at = datetime('now')`
    )
    .bind(data.telegramChatId, data.type, data.title, data.username ?? null, data.approvalStatus ?? "pending")
    .run();

  const row = await db
    .prepare(`SELECT id, telegram_chat_id, type, title, username, approval_status, is_blacklisted, first_added_at FROM chats WHERE telegram_chat_id = ?`)
    .bind(data.telegramChatId)
    .first<{ id: number; telegram_chat_id: number; type: string; title: string | null; username: string | null; approval_status: string; is_blacklisted: number; first_added_at: string | null }>();

  if (!row) throw new Error(`Failed to create/update chat ${data.telegramChatId}`);
  return row;
}

/**
 * Update chat approval status.
 */
export async function updateChatApprovalStatus(
  db: D1Database,
  chatId: number,
  status: ApprovalStatus,
  approvedBy: string | null,
  isBlacklisted?: boolean
): Promise<void> {
  const updates: string[] = ["approval_status = ?"];
  const bindings: (string | number | null)[] = [status];

  if (status === "approved") {
    updates.push("approved_at = datetime('now')");
    updates.push("approved_by = ?");
    bindings.push(approvedBy);
  } else if (status === "rejected") {
    updates.push("rejected_at = datetime('now')");
  }

  if (isBlacklisted !== undefined) {
    updates.push("is_blacklisted = ?");
    updates.push(isBlacklisted ? "1" : "0");
    bindings.push(isBlacklisted ? 1 : 0);
    if (isBlacklisted) {
      updates.push("blacklisted_at = datetime('now')");
      updates.push("blacklisted_by = ?");
      bindings.push(approvedBy);
    }
  }

  updates.push("updated_at = datetime('now')");

  bindings.push(chatId);

  await db
    .prepare(`UPDATE chats SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...bindings)
    .run();
}

/**
 * Create pending approval record.
 */
export async function createPendingApproval(
  db: D1Database,
  data: {
    chatId: number;
    requestedByName: string;
    requestedByUsername: string | null;
    requestedByUserId: number;
    chatType: string;
    chatTitle: string | null;
    chatUsername: string | null;
    memberCount: number | null;
    complexityScore: number | null;
    complexityFactors: ComplexityFactors | null;
    slackBlocksType: SlackBlocksType;
  }
): Promise<PendingApproval> {
  await db
    .prepare(
      `INSERT INTO pending_approvals (
        chat_id, requested_by_name, requested_by_username, requested_by_user_id,
        chat_type, chat_title, chat_username, member_count, complexity_score,
        complexity_factors, slack_blocks_type, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now', '+72 hours'))
      ON CONFLICT (chat_id) DO UPDATE SET
        requested_by_name = excluded.requested_by_name,
        requested_by_username = excluded.requested_by_username,
        requested_by_user_id = excluded.requested_by_user_id,
        member_count = excluded.member_count,
        complexity_score = excluded.complexity_score,
        complexity_factors = excluded.complexity_factors,
        slack_blocks_type = excluded.slack_blocks_type,
        status = 'pending',
        expires_at = datetime('now', '+72 hours'),
        resolved_at = NULL,
        resolved_by_slack_user_id = NULL,
        resolved_by_slack_user_name = NULL,
        created_at = datetime('now')`
    )
    .bind(
      data.chatId,
      data.requestedByName,
      data.requestedByUsername,
      data.requestedByUserId,
      data.chatType,
      data.chatTitle,
      data.chatUsername,
      data.memberCount,
      data.complexityScore,
      data.complexityFactors ? JSON.stringify(data.complexityFactors) : null,
      data.slackBlocksType
    )
    .run();

  const row = await db
    .prepare(
      `SELECT * FROM pending_approvals WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .bind(data.chatId)
    .first<{
      id: number;
      chat_id: number;
      slack_message_ts: string | null;
      slack_channel_id: string | null;
      slack_blocks_type: SlackBlocksType;
      requested_by_name: string;
      requested_by_username: string | null;
      requested_by_user_id: number;
      chat_type: ChatType;
      chat_title: string | null;
      chat_username: string | null;
      member_count: number | null;
      complexity_score: number | null;
      complexity_factors: string | null;
      status: ApprovalStatus;
      created_at: string;
      expires_at: string;
      resolved_at: string | null;
      resolved_by_slack_user_id: string | null;
      resolved_by_slack_user_name: string | null;
    }>();

  if (!row) throw new Error(`Failed to create pending approval for chat ${data.chatId}`);

  return {
    id: row.id,
    chatId: row.chat_id,
    slackMessageTs: row.slack_message_ts,
    slackChannelId: row.slack_channel_id,
    slackBlocksType: row.slack_blocks_type,
    requestedBy: {
      name: row.requested_by_name,
      username: row.requested_by_username,
      userId: row.requested_by_user_id,
    },
    chatType: row.chat_type,
    chatTitle: row.chat_title,
    chatUsername: row.chat_username,
    memberCount: row.member_count,
    complexityScore: row.complexity_score,
    complexityFactors: row.complexity_factors ? JSON.parse(row.complexity_factors) : null,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolvedBySlackUserId: row.resolved_by_slack_user_id,
    resolvedBySlackUserName: row.resolved_by_slack_user_name,
  };
}

/**
 * Get pending approval by chat ID.
 */
export async function getPendingApprovalByChatId(
  db: D1Database,
  chatId: number
): Promise<PendingApproval | null> {
  const row = await db
    .prepare(`SELECT * FROM pending_approvals WHERE chat_id = ?`)
    .bind(chatId)
    .first<{
      id: number;
      chat_id: number;
      slack_message_ts: string | null;
      slack_channel_id: string | null;
      slack_blocks_type: SlackBlocksType;
      requested_by_name: string;
      requested_by_username: string | null;
      requested_by_user_id: number;
      chat_type: ChatType;
      chat_title: string | null;
      chat_username: string | null;
      member_count: number | null;
      complexity_score: number | null;
      complexity_factors: string | null;
      status: ApprovalStatus;
      created_at: string;
      expires_at: string;
      resolved_at: string | null;
      resolved_by_slack_user_id: string | null;
      resolved_by_slack_user_name: string | null;
    }>();

  if (!row) return null;

  return {
    id: row.id,
    chatId: row.chat_id,
    slackMessageTs: row.slack_message_ts,
    slackChannelId: row.slack_channel_id,
    slackBlocksType: row.slack_blocks_type,
    requestedBy: {
      name: row.requested_by_name,
      username: row.requested_by_username,
      userId: row.requested_by_user_id,
    },
    chatType: row.chat_type,
    chatTitle: row.chat_title,
    chatUsername: row.chat_username,
    memberCount: row.member_count,
    complexityScore: row.complexity_score,
    complexityFactors: row.complexity_factors ? JSON.parse(row.complexity_factors) : null,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolvedBySlackUserId: row.resolved_by_slack_user_id,
    resolvedBySlackUserName: row.resolved_by_slack_user_name,
  };
}

/**
 * Get pending approvals by status.
 */
export async function getPendingApprovals(
  db: D1Database,
  status: ApprovalStatus
): Promise<PendingApproval[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM pending_approvals WHERE status = ? ORDER BY created_at ASC`
    )
    .bind(status)
    .all<{
      id: number;
      chat_id: number;
      slack_message_ts: string | null;
      slack_channel_id: string | null;
      slack_blocks_type: SlackBlocksType;
      requested_by_name: string;
      requested_by_username: string | null;
      requested_by_user_id: number;
      chat_type: ChatType;
      chat_title: string | null;
      chat_username: string | null;
      member_count: number | null;
      complexity_score: number | null;
      complexity_factors: string | null;
      status: ApprovalStatus;
      created_at: string;
      expires_at: string;
      resolved_at: string | null;
      resolved_by_slack_user_id: string | null;
      resolved_by_slack_user_name: string | null;
    }>();

  return (rows.results || []).map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    slackMessageTs: row.slack_message_ts,
    slackChannelId: row.slack_channel_id,
    slackBlocksType: row.slack_blocks_type,
    requestedBy: {
      name: row.requested_by_name,
      username: row.requested_by_username,
      userId: row.requested_by_user_id,
    },
    chatType: row.chat_type,
    chatTitle: row.chat_title,
    chatUsername: row.chat_username,
    memberCount: row.member_count,
    complexityScore: row.complexity_score,
    complexityFactors: row.complexity_factors ? JSON.parse(row.complexity_factors) : null,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolvedBySlackUserId: row.resolved_by_slack_user_id,
    resolvedBySlackUserName: row.resolved_by_slack_user_name,
  }));
}

/**
 * Get pending approvals with filters.
 */
export async function getPendingApprovalsByFilter(
  db: D1Database,
  filter: string
): Promise<PendingApproval[]> {
  let whereClause = "status = 'pending'";
  const bindings: (string | number)[] = [];

  if (filter === "groups") {
    whereClause += " AND chat_type IN ('group', 'supergroup')";
  } else if (filter === "dms") {
    whereClause += " AND chat_type = 'private'";
  } else if (filter === "recent") {
    whereClause += " AND created_at > datetime('now', '-24 hours')";
  } else if (filter === "rich") {
    whereClause += " AND slack_blocks_type = 'rich'";
  }

  const rows = await db
    .prepare(`SELECT * FROM pending_approvals WHERE ${whereClause} ORDER BY created_at ASC`)
    .bind(...bindings)
    .all<{
      id: number;
      chat_id: number;
      slack_message_ts: string | null;
      slack_channel_id: string | null;
      slack_blocks_type: SlackBlocksType;
      requested_by_name: string;
      requested_by_username: string | null;
      requested_by_user_id: number;
      chat_type: ChatType;
      chat_title: string | null;
      chat_username: string | null;
      member_count: number | null;
      complexity_score: number | null;
      complexity_factors: string | null;
      status: ApprovalStatus;
      created_at: string;
      expires_at: string;
      resolved_at: string | null;
      resolved_by_slack_user_id: string | null;
      resolved_by_slack_user_name: string | null;
    }>();

  return (rows.results || []).map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    slackMessageTs: row.slack_message_ts,
    slackChannelId: row.slack_channel_id,
    slackBlocksType: row.slack_blocks_type,
    requestedBy: {
      name: row.requested_by_name,
      username: row.requested_by_username,
      userId: row.requested_by_user_id,
    },
    chatType: row.chat_type,
    chatTitle: row.chat_title,
    chatUsername: row.chat_username,
    memberCount: row.member_count,
    complexityScore: row.complexity_score,
    complexityFactors: row.complexity_factors ? JSON.parse(row.complexity_factors) : null,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolvedBySlackUserId: row.resolved_by_slack_user_id,
    resolvedBySlackUserName: row.resolved_by_slack_user_name,
  }));
}

/**
 * Get expired pending approvals.
 */
export async function getExpiredPendingApprovals(
  db: D1Database
): Promise<PendingApproval[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM pending_approvals 
       WHERE status = 'pending' AND expires_at < datetime('now')
       ORDER BY expires_at ASC`
    )
    .all<{
      id: number;
      chat_id: number;
      slack_message_ts: string | null;
      slack_channel_id: string | null;
      slack_blocks_type: SlackBlocksType;
      requested_by_name: string;
      requested_by_username: string | null;
      requested_by_user_id: number;
      chat_type: ChatType;
      chat_title: string | null;
      chat_username: string | null;
      member_count: number | null;
      complexity_score: number | null;
      complexity_factors: string | null;
      status: ApprovalStatus;
      created_at: string;
      expires_at: string;
      resolved_at: string | null;
      resolved_by_slack_user_id: string | null;
      resolved_by_slack_user_name: string | null;
    }>();

  return (rows.results || []).map((row) => ({
    id: row.id,
    chatId: row.chat_id,
    slackMessageTs: row.slack_message_ts,
    slackChannelId: row.slack_channel_id,
    slackBlocksType: row.slack_blocks_type,
    requestedBy: {
      name: row.requested_by_name,
      username: row.requested_by_username,
      userId: row.requested_by_user_id,
    },
    chatType: row.chat_type,
    chatTitle: row.chat_title,
    chatUsername: row.chat_username,
    memberCount: row.member_count,
    complexityScore: row.complexity_score,
    complexityFactors: row.complexity_factors ? JSON.parse(row.complexity_factors) : null,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolvedBySlackUserId: row.resolved_by_slack_user_id,
    resolvedBySlackUserName: row.resolved_by_slack_user_name,
  }));
}

/**
 * Resolve a pending approval.
 */
export async function resolvePendingApproval(
  db: D1Database,
  approvalId: number,
  status: ApprovalStatus,
  resolvedBySlackUserId: string | null,
  resolvedBySlackUserName: string | null
): Promise<void> {
  await db
    .prepare(
      `UPDATE pending_approvals SET
        status = ?,
        resolved_at = datetime('now'),
        resolved_by_slack_user_id = ?,
        resolved_by_slack_user_name = ?
       WHERE id = ?`
    )
    .bind(status, resolvedBySlackUserId, resolvedBySlackUserName, approvalId)
    .run();
}

/**
 * Update Slack message reference for a pending approval.
 */
export async function updateSlackMessageRef(
  db: D1Database,
  approvalId: number,
  slackMessageTs: string,
  slackChannelId: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE pending_approvals SET
        slack_message_ts = ?,
        slack_channel_id = ?
       WHERE id = ?`
    )
    .bind(slackMessageTs, slackChannelId, approvalId)
    .run();
}

/**
 * Get blacklisted chats.
 */
export async function getBlacklistedChats(
  db: D1Database,
  limit: number = 10
): Promise<BlacklistedChat[]> {
  const rows = await db
    .prepare(
      `SELECT
        c.id as chat_id,
        c.telegram_chat_id,
        c.type as chat_type,
        c.title as chat_title,
        c.blacklisted_at,
        c.blacklisted_by,
        c.blacklisted_reason,
        pa.requested_by_name,
        pa.requested_by_username
       FROM chats c
       LEFT JOIN pending_approvals pa ON pa.chat_id = c.id
       WHERE c.is_blacklisted = 1
       ORDER BY c.blacklisted_at DESC
       LIMIT ?`
    )
    .bind(limit)
    .all<{
      chat_id: number;
      telegram_chat_id: number;
      chat_type: ChatType;
      chat_title: string | null;
      blacklisted_at: string;
      blacklisted_by: string | null;
      blacklisted_reason: string | null;
      requested_by_name: string | null;
      requested_by_username: string | null;
    }>();

  return (rows.results || []).map((row) => ({
    chatId: row.chat_id,
    telegramChatId: row.telegram_chat_id,
    chatTitle: row.chat_title,
    chatType: row.chat_type,
    blacklistedAt: row.blacklisted_at,
    blacklistedBy: row.blacklisted_by,
    blacklistedReason: row.blacklisted_reason,
    requestedByName: row.requested_by_name,
    requestedByUsername: row.requested_by_username,
  }));
}

/**
 * Get prior chat summary (for rich context).
 */
export async function getPriorChatSummary(
  db: D1Database,
  chatId: number
): Promise<PriorChatSummary | null> {
  // Check for previous approval
  const previousApproval = await db
    .prepare(
      `SELECT resolved_at FROM pending_approvals
       WHERE chat_id = ? AND status = 'approved'
       ORDER BY resolved_at DESC LIMIT 1`
    )
    .bind(chatId)
    .first<{ resolved_at: string }>();

  // Get message count from membership history
  const history = await db
    .prepare(
      `SELECT COUNT(*) as msg_count, MAX(occurred_at) as last_activity
       FROM chat_membership_history
       WHERE chat_id = ?`
    )
    .bind(chatId)
    .first<{ msg_count: number; last_activity: string }>();

  // Get latest summary if available
  const summary = await db
    .prepare(
      `SELECT content FROM summaries
       WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .bind(chatId)
    .first<{ content: string }>();

  if (!previousApproval && !history) {
    return null;
  }

  const chat = await getChatById(db, chatId);
  if (!chat) return null;

  return {
    chatId,
    telegramChatId: chat.telegram_chat_id,
    chatTitle: chat.title,
    previouslyApprovedAt: previousApproval?.resolved_at || null,
    totalMessagesExchanged: history?.msg_count || 0,
    lastActivityAt: history?.last_activity || null,
    summaryContent: summary?.content || null,
  };
}

/**
 * Get recent messages for complexity calculation.
 */
export async function getRecentMessagesForComplexity(
  db: D1Database,
  chatId: number,
  limit: number = 5
): Promise<Array<{ text: string | null; created_at: string }>> {
  const rows = await db
    .prepare(
      `SELECT text, created_at FROM active_messages
       WHERE chat_id = ? AND text IS NOT NULL
       ORDER BY created_at DESC LIMIT ?`
    )
    .bind(chatId, limit)
    .all<{ text: string | null; created_at: string }>();

  return rows.results || [];
}

/**
 * Record membership event.
 */
export async function recordMembershipEvent(
  db: D1Database,
  chatId: number,
  eventType: string,
  performedBy: string | null,
  metadata?: Record<string, unknown>
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chat_membership_history (chat_id, event_type, performed_by, metadata)
       VALUES (?, ?, ?, ?)`
    )
    .bind(chatId, eventType, performedBy, metadata ? JSON.stringify(metadata) : null)
    .run();
}

/**
 * Get Telegram chat ID from internal ID.
 */
export async function getTelegramChatId(
  db: D1Database,
  chatId: number
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT telegram_chat_id FROM chats WHERE id = ?`)
    .bind(chatId)
    .first<{ telegram_chat_id: number }>();

  return row?.telegram_chat_id ?? null;
}

/**
 * Get bot metadata from D1 cache.
 */
export async function getBotMetadataFromDb(
  db: D1Database
): Promise<{ username: string; firstName: string } | null> {
  const username = await db
    .prepare(`SELECT value FROM app_config WHERE key = 'bot_username'`)
    .first<{ value: string }>();

  const firstName = await db
    .prepare(`SELECT value FROM app_config WHERE key = 'bot_first_name'`)
    .first<{ value: string }>();

  if (!username) return null;

  return {
    username: username.value,
    firstName: firstName?.value || "Bot",
  };
}

/**
 * Save bot metadata to D1 cache.
 */
export async function saveBotMetadataToDb(
  db: D1Database,
  metadata: BotMetadata
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_config (key, value) VALUES ('bot_username', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .bind(metadata.username)
    .run();

  await db
    .prepare(
      `INSERT INTO app_config (key, value) VALUES ('bot_first_name', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .bind(metadata.firstName)
    .run();

  await db
    .prepare(
      `INSERT INTO app_config (key, value) VALUES ('bot_metadata_initialized', 'true')
       ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = datetime('now')`
    )
    .run();
}



// ============================================================================
// DAILY STATS QUERIES
// ============================================================================

export interface DailyStatsRecord {
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

/**
 * Calculate and store daily stats.
 */
export async function calculateAndStoreDailyStats(
  db: D1Database,
  date: string,
  period: "morning" | "evening"
): Promise<DailyStatsRecord> {
  // Count total chats by status
  const chatStats = await db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN approval_status = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN approval_status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN approval_status = 'rejected' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN is_blacklisted = 1 THEN 1 ELSE 0 END) as blacklisted
       FROM chats`
    )
    .first<{ total: number; approved: number; pending: number; rejected: number; blacklisted: number }>();

  // Count messages and active chats in last period
  const timeWindow = period === "morning" ? "-12 hours" : "-12 hours";
  const messageStats = await db
    .prepare(
      `SELECT
        COUNT(*) as total_messages,
        COUNT(DISTINCT chat_id) as active_chats,
        COUNT(DISTINCT sender_id) as unique_users
       FROM active_messages
       WHERE created_at > datetime('now', ?)`
    )
    .bind(timeWindow)
    .first<{ total_messages: number; active_chats: number; unique_users: number }>();

  // Count approval decisions in last period
  const approvalStats = await db
    .prepare(
      `SELECT COUNT(*) as decisions
       FROM pending_approvals
       WHERE resolved_at > datetime('now', ?)
       AND status IN ('approved', 'rejected')`
    )
    .bind(timeWindow)
    .first<{ decisions: number }>();

  // Count expired in last period
  const expiredStats = await db
    .prepare(
      `SELECT COUNT(*) as expired
       FROM pending_approvals
       WHERE status = 'expired'
       AND resolved_at > datetime('now', ?)`
    )
    .bind(timeWindow)
    .first<{ expired: number }>();

  const stats: DailyStatsRecord = {
    date,
    period,
    totalChats: chatStats?.total || 0,
    approvedChats: chatStats?.approved || 0,
    pendingChats: chatStats?.pending || 0,
    rejectedChats: chatStats?.rejected || 0,
    expiredChats: expiredStats?.expired || 0,
    blacklistedChats: chatStats?.blacklisted || 0,
    totalMessages: messageStats?.total_messages || 0,
    uniqueUsers: messageStats?.unique_users || 0,
    activeChats: messageStats?.active_chats || 0,
    approvalDecisions: approvalStats?.decisions || 0,
  };

  // Store in database
  await db
    .prepare(
      `INSERT INTO daily_stats (
        date, period, total_chats, approved_chats, pending_chats,
        rejected_chats, expired_chats, blacklisted_chats, total_messages,
        unique_users, active_chats, approval_decisions
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (date, period) DO UPDATE SET
        total_chats = excluded.total_chats,
        approved_chats = excluded.approved_chats,
        pending_chats = excluded.pending_chats,
        rejected_chats = excluded.rejected_chats,
        expired_chats = excluded.expired_chats,
        blacklisted_chats = excluded.blacklisted_chats,
        total_messages = excluded.total_messages,
        unique_users = excluded.unique_users,
        active_chats = excluded.active_chats,
        approval_decisions = excluded.approval_decisions`
    )
    .bind(
      stats.date,
      stats.period,
      stats.totalChats,
      stats.approvedChats,
      stats.pendingChats,
      stats.rejectedChats,
      stats.expiredChats,
      stats.blacklistedChats,
      stats.totalMessages,
      stats.uniqueUsers,
      stats.activeChats,
      stats.approvalDecisions
    )
    .run();

  return stats;
}

