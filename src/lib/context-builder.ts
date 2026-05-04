/**
 * Tiered context builder for AI calls.
 *
 * Addresses the "raw message dump" problem by layering context:
 * - Tier 1: Summary + latest 3-5 messages (always included)
 * - Tier 2: Structured metadata (chat type, team activity, linked issues)
 * - Tier 3: Raw messages (only if needed, capped appropriately)
 *
 * Right-sizes context per task:
 * - Classification: 30 messages + summary (understanding conversation flow)
 * - Drafting: 5-10 messages + summary + rich metadata (focused on response quality)
 */

import type { MessageWithSender } from "./queries";
import { logger } from "./logger";
import { getErrorMessage } from "./errors";

// ============================================================================
// Types
// ============================================================================

/** Structured metadata about a chat for the LLM. */
export interface ChatMetadata {
  /** Chat type from Telegram */
  type: "private" | "group" | "supergroup" | "channel" | "unknown";
  /** Chat title (for groups) or username (for DMs) */
  title: string | null;
  /** Number of participants tracked */
  participantCount: number;
  /** Whether a team member participated recently (last 30 min) */
  teamMemberRecentlyActive: boolean;
  /** Time since last team member message */
  minutesSinceTeamMember?: number;
  /** Whether this chat was escalated to Slack recently */
  recentlyEscalated: boolean;
  /** Number of pending escalations */
  pendingEscalations: number;
  /** Number of linked Linear issues */
  linkedIssuesCount: number;
  /** Linked Linear issue identifiers */
  linkedIssues: Array<{ issueId: string; url: string; type: string }>;
  /** Previous drafts for this chat (last 3) */
  recentDrafts: Array<{
    content: string;
    status: string;
    classificationLabel: string | null;
    createdAt: string;
  }>;
  /** Previous classifications for similar messages */
  recentClassifications: Array<{
    label: string;
    confidence: number;
    reasoning: string;
    createdAt: string;
  }>;
  /** Whether sender has been helped before */
  senderHistory: {
    messageCount: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
  };
}

/** Tiered context structure for classification. */
export interface ClassificationContext {
  type: "classification";
  summary: string | null;
  recentMessages: MessageWithSender[];
  metadata: ChatMetadata;
  formatted: string;
}

/** Tiered context structure for drafting. */
export interface DraftContext {
  type: "draft";
  summary: string | null;
  /** Only most relevant messages (3-5) */
  relevantMessages: MessageWithSender[];
  metadata: ChatMetadata;
  /** The message being responded to */
  targetMessage: {
    text: string;
    senderName: string;
    senderId: number;
  };
  formatted: string;
}

// ============================================================================
// Knowledge Retrieval Queries
// ============================================================================

/**
 * Retrieve chat metadata for context enrichment.
 */
async function retrieveChatMetadata(
  db: D1Database,
  chatId: number,
  senderId: number,
): Promise<ChatMetadata> {
  // Get chat info
  const chatRow = await db
    .prepare(
      `SELECT type, title, 
        (SELECT COUNT(*) FROM chat_participants WHERE chat_id = ?) as participant_count
       FROM chats WHERE id = ?`
    )
    .bind(chatId, chatId)
    .first<{
      type: string;
      title: string | null;
      participant_count: number;
    }>();

  // Check recent team member activity (last 30 minutes)
  // Join with team_members table to identify team member messages
  const teamActivity = await db
    .prepare(
      `SELECT 
        COUNT(*) as team_message_count,
        MAX(am.created_at) as last_team_message_at,
        ROUND((JULIANDAY('now') - JULIANDAY(MAX(am.created_at))) * 24 * 60) as minutes_since
       FROM active_messages am
       JOIN chat_participants cp ON cp.id = am.sender_id
       LEFT JOIN team_members tm ON tm.telegram_user_id = cp.telegram_user_id
       WHERE am.chat_id = ? 
         AND tm.id IS NOT NULL
         AND tm.deleted_at IS NULL
         AND am.created_at > datetime('now', '-30 minutes')`
    )
    .bind(chatId)
    .first<{
      team_message_count: number;
      last_team_message_at: string | null;
      minutes_since: number | null;
    }>();

  // Check recent escalations (last 24 hours)
  const escalationStats = await db
    .prepare(
      `SELECT 
        COUNT(*) as total_recent,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
       FROM escalations
       WHERE chat_id = ? AND created_at > datetime('now', '-24 hours')`
    )
    .bind(chatId)
    .first<{ total_recent: number; pending: number }>();

  // Get linked Linear issues
  const linearLinks = await db
    .prepare(
      `SELECT linear_issue_id, linear_issue_url, issue_type
       FROM linear_links
       WHERE chat_id = ?
       ORDER BY created_at DESC
       LIMIT 5`
    )
    .bind(chatId)
    .all<{ linear_issue_id: string; linear_issue_url: string; issue_type: string }>();

  // Get recent drafts
  const recentDrafts = await db
    .prepare(
      `SELECT content, status, classification_label, created_at
       FROM drafts
       WHERE chat_id = ?
       ORDER BY created_at DESC
       LIMIT 3`
    )
    .bind(chatId)
    .all<{
      content: string;
      status: string;
      classification_label: string | null;
      created_at: string;
    }>();

  // Get recent classifications (last 10)
  const recentClassifications = await db
    .prepare(
      `SELECT c.label, c.confidence, c.reasoning, c.created_at
       FROM classifications c
       JOIN active_messages am ON am.id = c.message_id
       WHERE c.chat_id = ?
       ORDER BY c.created_at DESC
       LIMIT 10`
    )
    .bind(chatId)
    .all<{
      label: string;
      confidence: number;
      reasoning: string;
      created_at: string;
    }>();

  // Get sender history
  const senderStats = await db
    .prepare(
      `SELECT 
        COUNT(*) as message_count,
        MIN(am.created_at) as first_seen,
        MAX(am.created_at) as last_seen
       FROM active_messages am
       WHERE am.chat_id = ? AND am.sender_id = 
         (SELECT id FROM chat_participants WHERE chat_id = ? AND telegram_user_id = ?)`
    )
    .bind(chatId, chatId, senderId)
    .first<{
      message_count: number;
      first_seen: string | null;
      last_seen: string | null;
    }>();

  return {
    type: (chatRow?.type as ChatMetadata["type"]) || "unknown",
    title: chatRow?.title ?? null,
    participantCount: chatRow?.participant_count || 0,
    teamMemberRecentlyActive: (teamActivity?.team_message_count || 0) > 0,
    minutesSinceTeamMember: teamActivity?.minutes_since ?? undefined,
    recentlyEscalated: (escalationStats?.total_recent || 0) > 0,
    pendingEscalations: escalationStats?.pending || 0,
    linkedIssuesCount: linearLinks.results?.length || 0,
    linkedIssues: (linearLinks.results || []).map((l) => ({
      issueId: l.linear_issue_id,
      url: l.linear_issue_url,
      type: l.issue_type,
    })),
    recentDrafts: (recentDrafts.results || []).map((d) => ({
      content: d.content.slice(0, 200), // Truncate for context
      status: d.status,
      classificationLabel: d.classification_label,
      createdAt: d.created_at,
    })),
    recentClassifications: (recentClassifications.results || []).map((c) => ({
      label: c.label,
      confidence: c.confidence,
      reasoning: c.reasoning.slice(0, 150), // Truncate
      createdAt: c.created_at,
    })),
    senderHistory: {
      messageCount: senderStats?.message_count || 0,
      firstSeenAt: senderStats?.first_seen ?? null,
      lastSeenAt: senderStats?.last_seen ?? null,
    },
  };
}

// ============================================================================
// Message Formatting
// ============================================================================

/**
 * Format relative time from ISO timestamp.
 */
function formatRelativeTime(isoTimestamp: string, now: Date): string {
  const then = new Date(isoTimestamp + "Z");
  const diffMs = now.getTime() - then.getTime();

  if (isNaN(diffMs) || diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format messages for AI context.
 */
function formatMessages(messages: MessageWithSender[]): string {
  if (messages.length === 0) return "(no recent messages)";

  const now = new Date();

  return messages
    .map((m) => {
      const timeAgo = formatRelativeTime(m.created_at, now);
      const text = m.text ?? "";
      return `[${m.display_name} (${timeAgo})]: ${text}`;
    })
    .join("\n");
}

/**
 * Format metadata for the draft prompt header.
 * Provides critical context without overwhelming the model.
 */
export function formatMetadataForPrompt(metadata: ChatMetadata): string {
  const parts: string[] = [];

  // Chat context
  const chatContext = [`Chat: ${metadata.type}`];
  if (metadata.title) chatContext.push(metadata.title);
  if (metadata.participantCount > 0) {
    chatContext.push(`~${metadata.participantCount} people`);
  }
  parts.push(chatContext.join(" | "));

  // Activity indicators
  const activity: string[] = [];
  if (metadata.teamMemberRecentlyActive) {
    activity.push("team member active");
  }
  if (metadata.recentlyEscalated) {
    activity.push(metadata.pendingEscalations > 0
      ? `${metadata.pendingEscalations} escalation pending`
      : "recently escalated");
  }
  if (activity.length > 0) {
    parts.push(`Activity: ${activity.join(", ")}`);
  }

  // Linked issues (critical for bug reports)
  if (metadata.linkedIssuesCount > 0) {
    const issueInfo = metadata.linkedIssues
      .slice(0, 2)
      .map((i) => i.issueId)
      .join(", ");
    parts.push(`Known issues: ${issueInfo}${metadata.linkedIssuesCount > 2 ? ` (+${metadata.linkedIssuesCount - 2})` : ""}`);
  }

  // Sender context (helps calibrate tone)
  if (metadata.senderHistory.messageCount <= 2) {
    parts.push("Sender: new to chat");
  } else if (metadata.senderHistory.messageCount > 20) {
    parts.push("Sender: regular");
  }

  // Previous similar responses
  const similarDrafts = metadata.recentDrafts.filter(
    (d) => d.classificationLabel && d.status !== "rejected"
  );
  if (similarDrafts.length > 0) {
    const recentTopics = similarDrafts
      .slice(0, 2)
      .map((d) => d.classificationLabel)
      .filter(Boolean)
      .join(", ");
    if (recentTopics) {
      parts.push(`Previously helped with: ${recentTopics}`);
    }
  }

  return parts.join("\n");
}

/**
 * Format metadata for inclusion in prompts.
 */
function formatMetadata(metadata: ChatMetadata): string {
  const parts: string[] = [];

  // Chat basics
  parts.push(`Chat: ${metadata.type}`);
  if (metadata.title) {
    parts.push(`Title: ${metadata.title}`);
  }
  if (metadata.participantCount > 0) {
    parts.push(`Participants: ~${metadata.participantCount}`);
  }

  // Team activity
  if (metadata.teamMemberRecentlyActive) {
    const time = metadata.minutesSinceTeamMember
      ? `${metadata.minutesSinceTeamMember}m ago`
      : "recently";
    parts.push(`Team member active: ${time}`);
  }

  // Escalations
  if (metadata.recentlyEscalated) {
    parts.push(`Escalated: yes${metadata.pendingEscalations > 0 ? ` (${metadata.pendingEscalations} pending)` : ""}`);
  }

  // Linked issues
  if (metadata.linkedIssuesCount > 0) {
    const issues = metadata.linkedIssues
      .slice(0, 2)
      .map((i) => `${i.issueId} (${i.type})`)
      .join(", ");
    parts.push(`Linked issues: ${issues}${metadata.linkedIssuesCount > 2 ? ` +${metadata.linkedIssuesCount - 2} more` : ""}`);
  }

  // Sender context
  if (metadata.senderHistory.messageCount > 1) {
    parts.push(`Sender history: ${metadata.senderHistory.messageCount} messages`);
  }

  // Previous similar responses
  const relevantDrafts = metadata.recentDrafts.filter(
    (d) => d.status === "sent" || d.status === "pending"
  );
  if (relevantDrafts.length > 0) {
    const topics = relevantDrafts
      .map((d) => d.classificationLabel)
      .filter(Boolean)
      .slice(0, 2)
      .join(", ");
    if (topics) {
      parts.push(`Previous topics: ${topics}`);
    }
  }

  return parts.join(" | ");
}

// ============================================================================
// Context Building Functions
// ============================================================================

/**
 * Build context for classification.
 *
 * Uses 30 recent messages + summary to understand conversation flow.
 * Metadata is lightweight for classification.
 */
export async function buildClassificationContext(
  db: D1Database,
  chatId: number,
  senderId: number,
  getSummary: (chatId: number) => Promise<string | null>,
  getMessages: (db: D1Database, opts: { chatId: number; limit: number; order: "desc" }) => Promise<MessageWithSender[]>,
): Promise<ClassificationContext> {
  const startTime = Date.now();

  try {
    // Fetch in parallel: summary, messages, metadata
    const [summary, messages, metadata] = await Promise.all([
      getSummary(chatId),
      getMessages(db, { chatId, limit: 30, order: "desc" }).then((m) => m.reverse()),
      retrieveChatMetadata(db, chatId, senderId),
    ]);

    // Build formatted context (classification gets full message dump)
    let formatted = "";
    if (summary) {
      formatted += `Summary:\n${summary}\n\n`;
    }
    formatted += `Recent messages:\n${formatMessages(messages)}`;

    logger.debug("Classification context built", {
      chatId,
      messageCount: messages.length,
      hasSummary: !!summary,
      metadataKeys: Object.keys(metadata).length,
      durationMs: Date.now() - startTime,
    });

    return {
      type: "classification",
      summary,
      recentMessages: messages,
      metadata,
      formatted,
    };
  } catch (err) {
    logger.error("Failed to build classification context", {
      chatId,
      error: getErrorMessage(err),
    });
    // Return minimal context on error
    return {
      type: "classification",
      summary: null,
      recentMessages: [],
      metadata: {
        type: "unknown",
        title: null,
        participantCount: 0,
        teamMemberRecentlyActive: false,
        recentlyEscalated: false,
        pendingEscalations: 0,
        linkedIssuesCount: 0,
        linkedIssues: [],
        recentDrafts: [],
        recentClassifications: [],
        senderHistory: { messageCount: 0, firstSeenAt: null, lastSeenAt: null },
      },
      formatted: "(Error loading context)",
    };
  }
}

/**
 * Build context for draft generation.
 *
 * Uses only 5-10 most relevant messages + rich metadata.
 * Focused on response quality, not full history.
 */
export async function buildDraftContext(
  db: D1Database,
  chatId: number,
  senderId: number,
  targetMessage: { text: string; senderName: string; senderId: number },
  getSummary: (chatId: number) => Promise<string | null>,
  getMessages: (db: D1Database, opts: { chatId: number; limit: number; order: "desc" }) => Promise<MessageWithSender[]>,
): Promise<DraftContext> {
  const startTime = Date.now();

  try {
    // Fetch in parallel: summary, messages (we'll trim), metadata
    const [summary, recentMessages, metadata] = await Promise.all([
      getSummary(chatId),
      getMessages(db, { chatId, limit: 15, order: "desc" }),
      retrieveChatMetadata(db, chatId, senderId),
    ]);

    // Trim to most relevant: latest 5-7 messages
    // Reverse to chronological, take last 7, then reverse back for display
    const relevantMessages = recentMessages.slice(0, 7).reverse();

    // Build formatted context with rich metadata
    const parts: string[] = [];

    // Metadata header (critical for draft quality)
    parts.push(`Context: ${formatMetadata(metadata)}`);
    parts.push("");

    // Summary
    if (summary) {
      parts.push(`Conversation summary: ${summary}`);
      parts.push("");
    }

    // Recent relevant messages
    if (relevantMessages.length > 0) {
      parts.push("Recent messages:");
      parts.push(formatMessages(relevantMessages));
      parts.push("");
    }

    // Target message being responded to
    parts.push(`Responding to: [${targetMessage.senderName}]: ${targetMessage.text}`);

    const formatted = parts.join("\n");

    logger.debug("Draft context built", {
      chatId,
      messageCount: relevantMessages.length,
      hasSummary: !!summary,
      hasLinkedIssues: metadata.linkedIssuesCount > 0,
      recentlyEscalated: metadata.recentlyEscalated,
      durationMs: Date.now() - startTime,
    });

    return {
      type: "draft",
      summary,
      relevantMessages,
      metadata,
      targetMessage,
      formatted,
    };
  } catch (err) {
    logger.error("Failed to build draft context", {
      chatId,
      error: getErrorMessage(err),
    });
    // Return minimal context on error
    return {
      type: "draft",
      summary: null,
      relevantMessages: [],
      metadata: {
        type: "unknown",
        title: null,
        participantCount: 0,
        teamMemberRecentlyActive: false,
        recentlyEscalated: false,
        pendingEscalations: 0,
        linkedIssuesCount: 0,
        linkedIssues: [],
        recentDrafts: [],
        recentClassifications: [],
        senderHistory: { messageCount: 0, firstSeenAt: null, lastSeenAt: null },
      },
      targetMessage,
      formatted: `Responding to: [${targetMessage.senderName}]: ${targetMessage.text}`,
    };
  }
}
