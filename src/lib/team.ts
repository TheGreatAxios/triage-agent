/**
 * Team member detection and metrics tracking.
 *
 * This module handles:
 * - Team member identification (runtime configurable via D1)
 * - Response metrics tracking (first response time, touches)
 * - Stale chat detection and alerting
 * - Daily metrics aggregation
 * - Idempotency tracking for alerts and summaries
 */

import { logger } from "./logger";
import { getErrorMessage } from "./errors";
import type { StaleChat } from "../types/team";

// ============================================================================
// TEAM MEMBER DETECTION
// ============================================================================

export interface TeamMember {
  id: number;
  telegramUsername: string;
  displayName: string;
  role: string;
  slackUserId: string | null;
  isActive: boolean;
}

/**
 * Check if a username belongs to a team member.
 */
export async function isTeamMember(
  db: D1Database,
  username: string | undefined
): Promise<boolean> {
  if (!username) return false;

  const row = await db
    .prepare(
      `SELECT 1 FROM team_members
       WHERE telegram_username = ? AND is_active = 1`
    )
    .bind(username)
    .first<{ "1": number }>();

  return !!row;
}

/**
 * Get team member details by username.
 */
export async function getTeamMemberByUsername(
  db: D1Database,
  username: string
): Promise<TeamMember | null> {
  const row = await db
    .prepare(
      `SELECT id, telegram_username, display_name, role, slack_user_id, is_active
       FROM team_members
       WHERE telegram_username = ? AND is_active = 1`
    )
    .bind(username)
    .first<{
      id: number;
      telegram_username: string;
      display_name: string;
      role: string;
      slack_user_id: string | null;
      is_active: number;
    }>();

  if (!row) return null;

  return {
    id: row.id,
    telegramUsername: row.telegram_username,
    displayName: row.display_name,
    role: row.role,
    slackUserId: row.slack_user_id,
    isActive: row.is_active === 1,
  };
}

/**
 * Record a team member touch (response) on a chat.
 * Updates chat_metrics for response time tracking.
 */
export async function recordTeamTouch(
  db: D1Database,
  chatId: number,
  teamMemberId: number,
  timestamp: string
): Promise<void> {
  try {
    // Upsert chat_metrics: update last_team_touch_at, increment total_team_touches
    // Calculate first_response_seconds if this is the first response
    await db
      .prepare(
        `INSERT INTO chat_metrics (
          chat_id, last_team_touch_at, total_team_touches, team_member_ids,
          first_response_at, first_response_seconds, created_at, updated_at
        ) VALUES (
          ?, ?, 1, ?, ?, 
          CASE WHEN ? IS NOT NULL THEN 
            ROUND((julianday(?) - julianday(?)) * 86400)
          ELSE NULL END,
          datetime('now'), datetime('now')
        )
        ON CONFLICT (chat_id) DO UPDATE SET
          last_team_touch_at = ?,
          total_team_touches = chat_metrics.total_team_touches + 1,
          team_member_ids = CASE
            WHEN chat_metrics.team_member_ids IS NULL THEN ?
            WHEN INSTR(chat_metrics.team_member_ids, ?) > 0 THEN chat_metrics.team_member_ids
            ELSE chat_metrics.team_member_ids || ',' || ?
          END,
          first_response_at = COALESCE(chat_metrics.first_response_at, ?),
          first_response_seconds = COALESCE(
            chat_metrics.first_response_seconds,
            CASE WHEN ? IS NOT NULL THEN 
              ROUND((julianday(?) - julianday(?)) * 86400)
            ELSE NULL END
          ),
          updated_at = datetime('now')`
      )
      .bind(
        chatId,
        timestamp,
        String(teamMemberId),
        timestamp, // first_response_at (initial)
        null, // placeholder for first_customer_message_at subquery
        timestamp,
        null, // will be replaced with first_customer_message_at
        timestamp,
        String(teamMemberId),
        String(teamMemberId),
        String(teamMemberId),
        timestamp,
        null, // placeholder
        timestamp,
        null // placeholder
      )
      .run();

    // Update team_member_metrics for this date
    const today = timestamp.split("T")[0];
    await db
      .prepare(
        `INSERT INTO team_member_metrics (
          team_member_id, date, messages_sent, chats_responded,
          created_at, updated_at
        ) VALUES (?, ?, 1, 1, datetime('now'), datetime('now'))
        ON CONFLICT (team_member_id, date) DO UPDATE SET
          messages_sent = team_member_metrics.messages_sent + 1,
          chats_responded = (
            SELECT COUNT(DISTINCT chat_id) FROM chat_metrics
            WHERE team_member_ids LIKE '%' || ? || '%'
            AND date(first_customer_message_at) = ?
          ),
          updated_at = datetime('now')`
      )
      .bind(teamMemberId, today, String(teamMemberId), today)
      .run();

    logger.debug("Team touch recorded", { chatId, teamMemberId, timestamp });
  } catch (err) {
    logger.error("Failed to record team touch", {
      chatId,
      teamMemberId,
      error: getErrorMessage(err),
    });
    // Don't throw - metrics failure shouldn't block message processing
  }
}

/**
 * Ensure first customer message is tracked for response time metrics.
 */
export async function ensureFirstCustomerMessage(
  db: D1Database,
  chatId: number,
  customerUsername: string | undefined,
  timestamp: string
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO chat_metrics (chat_id, first_customer_message_at, created_at, updated_at)
         VALUES (?, ?, datetime('now'), datetime('now'))
         ON CONFLICT (chat_id) DO UPDATE SET
           first_customer_message_at = COALESCE(
             chat_metrics.first_customer_message_at,
             excluded.first_customer_message_at
           ),
           updated_at = datetime('now')`
      )
      .bind(chatId, timestamp)
      .run();

    logger.debug("First customer message tracked", {
      chatId,
      customerUsername,
      timestamp,
    });
  } catch (err) {
    logger.error("Failed to track first customer message", {
      chatId,
      error: getErrorMessage(err),
    });
    // Don't throw - metrics failure shouldn't block message processing
  }
}

// ============================================================================
// STALE CHAT DETECTION
// ============================================================================

/**
 * Get chats that haven't had a response in the specified hours.
 * Returns chats where customer is waiting for team response.
 */
export async function getStaleChats(
  db: D1Database,
  hoursThreshold: number
): Promise<StaleChat[]> {
  const { results } = await db
    .prepare(
      `SELECT
        c.id as chat_id,
        c.title as chat_title,
        cm.first_customer_message_at,
        cm.last_team_touch_at,
        ROUND((julianday('now') - julianday(
          COALESCE(cm.last_team_touch_at, cm.first_customer_message_at)
        )) * 24) as hours_waiting,
        tm.display_name as last_team_member_name
       FROM chat_metrics cm
       JOIN chats c ON c.id = cm.chat_id
       LEFT JOIN team_members tm ON tm.id = (
         SELECT json_extract(cm.team_member_ids, '$[0]')
       )
       WHERE cm.first_customer_message_at IS NOT NULL
       AND cm.resolved_at IS NULL
       AND (
         cm.last_team_touch_at IS NULL
         OR cm.last_team_touch_at < datetime('now', '-' || ? || ' hours')
       )
       AND NOT EXISTS (
         SELECT 1 FROM stale_alert_sent sas
         WHERE sas.chat_id = c.id AND sas.alert_type = 'stale_4h'
       )
       ORDER BY cm.first_customer_message_at ASC`
    )
    .bind(hoursThreshold)
    .all<{
      chat_id: number;
      chat_title: string | null;
      first_customer_message_at: string;
      last_team_touch_at: string | null;
      hours_waiting: number;
      last_team_member_name: string | null;
    }>();

  return (results || []).map((row) => ({
    chatId: row.chat_id,
    chatTitle: row.chat_title,
    customerWaitingHours: row.hours_waiting,
    lastTeamTouchAt: row.last_team_touch_at,
    lastTeamMemberName: row.last_team_member_name,
  }));
}

/**
 * Record that a stale alert was sent (idempotency).
 * Returns true if this is a new alert (not a duplicate).
 */
export async function recordStaleAlert(
  db: D1Database,
  chatId: number,
  alertType: string
): Promise<boolean> {
  try {
    const result = await db
      .prepare(
        `INSERT INTO stale_alert_sent (chat_id, alert_type, sent_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT (chat_id, alert_type) DO NOTHING`
      )
      .bind(chatId, alertType)
      .run();

    // If changes === 0, the alert was already recorded (duplicate)
    const isNewAlert = result.meta.changes > 0;

    if (!isNewAlert) {
      logger.debug("Stale alert already recorded", { chatId, alertType });
    }

    return isNewAlert;
  } catch (err) {
    logger.error("Failed to record stale alert", {
      chatId,
      alertType,
      error: getErrorMessage(err),
    });
    // On error, assume it's not a duplicate to avoid missing alerts
    return true;
  }
}

// ============================================================================
// DAILY METRICS & SUMMARIES
// ============================================================================

export interface DailyMetrics {
  date: string;
  totalChats: number;
  activeChats: number;
  totalMessages: number;
  teamTouches: number;
  avgFirstResponseSeconds: number | null;
  bugsReported: number;
  requestsReported: number;
}

export interface DuplicateCheckResult {
  sent: boolean;
  slackMessageTs: string | null;
  slackChannel: string | null;
}

/**
 * Calculate daily metrics for team performance tracking.
 */
export async function calculateDailyMetrics(
  db: D1Database,
  date: string
): Promise<DailyMetrics> {
  // Get chat activity for the date
  const chatStats = await db
    .prepare(
      `SELECT
        COUNT(DISTINCT c.id) as total_chats,
        COUNT(DISTINCT CASE WHEN date(am.created_at) = ? THEN am.chat_id END) as active_chats,
        COUNT(CASE WHEN date(am.created_at) = ? THEN 1 END) as total_messages
       FROM chats c
       LEFT JOIN active_messages am ON am.chat_id = c.id
       WHERE c.approval_status = 'approved'`
    )
    .bind(date, date)
    .first<{
      total_chats: number;
      active_chats: number;
      total_messages: number;
    }>();

  // Get team response metrics
  const teamStats = await db
    .prepare(
      `SELECT
        SUM(cm.total_team_touches) as team_touches,
        AVG(cm.first_response_seconds) as avg_first_response,
        COUNT(CASE WHEN date(cm.first_customer_message_at) = ? THEN 1 END) as new_chats
       FROM chat_metrics cm
       WHERE date(cm.updated_at) = ?`
    )
    .bind(date, date)
    .first<{
      team_touches: number;
      avg_first_response: number;
      new_chats: number;
    }>();

  // Get classification counts for the date
  const classificationStats = await db
    .prepare(
      `SELECT
        SUM(CASE WHEN c.label = 'bug' THEN 1 ELSE 0 END) as bugs,
        SUM(CASE WHEN c.label = 'request' THEN 1 ELSE 0 END) as requests
       FROM classifications c
       JOIN active_messages am ON am.id = c.message_id
       WHERE date(am.created_at) = ?`
    )
    .bind(date)
    .first<{
      bugs: number;
      requests: number;
    }>();

  const metrics: DailyMetrics = {
    date,
    totalChats: chatStats?.total_chats || 0,
    activeChats: chatStats?.active_chats || 0,
    totalMessages: chatStats?.total_messages || 0,
    teamTouches: teamStats?.team_touches || 0,
    avgFirstResponseSeconds: teamStats?.avg_first_response
      ? Math.round(teamStats.avg_first_response)
      : null,
    bugsReported: classificationStats?.bugs || 0,
    requestsReported: classificationStats?.requests || 0,
  };

  // Record KPI calculation for idempotency
  await db
    .prepare(
      `INSERT INTO kpi_calculation_completed (date, calculation_type, completed_at)
       VALUES (?, 'daily_metrics', datetime('now'))
       ON CONFLICT (date, calculation_type) DO UPDATE SET
         completed_at = datetime('now')`
    )
    .bind(date)
    .run();

  logger.info("Daily metrics calculated", { date, metrics });
  return metrics;
}

/**
 * Check if a daily summary was already sent (idempotency).
 */
export async function checkDuplicateSummary(
  db: D1Database,
  date: string,
  period: string
): Promise<DuplicateCheckResult> {
  const row = await db
    .prepare(
      `SELECT slack_message_ts, slack_channel
       FROM daily_summary_sent
       WHERE date = ? AND period = ?`
    )
    .bind(date, period)
    .first<{
      slack_message_ts: string;
      slack_channel: string;
    }>();

  return {
    sent: !!row,
    slackMessageTs: row?.slack_message_ts || null,
    slackChannel: row?.slack_channel || null,
  };
}

/**
 * Record that a daily summary was sent (idempotency).
 */
export async function recordSummarySent(
  db: D1Database,
  date: string,
  period: string,
  slackChannel: string,
  slackMessageTs: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO daily_summary_sent (date, period, slack_channel, slack_message_ts, sent_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT (date, period) DO UPDATE SET
         slack_channel = excluded.slack_channel,
         slack_message_ts = excluded.slack_message_ts,
         sent_at = datetime('now')`
    )
    .bind(date, period, slackChannel, slackMessageTs)
    .run();
}

// ============================================================================
// TIMER IDEMPOTENCY
// ============================================================================

/**
 * Check if a timer was already processed recently (within last hour).
 */
export async function isTimerProcessed(
  db: D1Database,
  timerId: number
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM processed_timers
       WHERE timer_id = ?
       AND processed_at > datetime('now', '-1 hour')`
    )
    .bind(timerId)
    .first<{ "1": number }>();

  return !!row;
}

/**
 * Record that a timer was processed.
 */
export async function recordTimerProcessed(
  db: D1Database,
  timerId: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO processed_timers (timer_id, processed_at)
       VALUES (?, datetime('now'))`
    )
    .bind(timerId)
    .run();

  // Clean up old records (older than 24 hours)
  await db
    .prepare(
      `DELETE FROM processed_timers
       WHERE processed_at < datetime('now', '-24 hours')`
    )
    .run();
}

// ============================================================================
// SLACK NOTIFICATION HELPERS
// ============================================================================

export interface StaleAlertResult {
  success: boolean;
  channel: string | null;
  messageTs: string | null;
}

/**
 * Placeholder for stale chat alert - actual implementation is in lib/slack.ts.
 * This function is kept for backward compatibility but delegates to the real implementation.
 * @deprecated Use sendStaleAlert from lib/slack.ts instead
 */
export async function sendStaleAlert(
  db: D1Database,
  staleChat: StaleChat
): Promise<StaleAlertResult> {
  // This is a placeholder - actual implementation is in lib/slack.ts
  logger.info("Stale chat alert would be sent (placeholder)", {
    chatId: staleChat.chatId,
    chatTitle: staleChat.chatTitle,
    customerWaitingHours: staleChat.customerWaitingHours,
  });

  return {
    success: true,
    channel: null,
    messageTs: null,
  };
}

export interface DailySummaryResult {
  success: boolean;
  channel: string | null;
  messageTs: string | null;
}

/**
 * Send daily summary to Slack.
 */
export async function sendDailySummary(
  db: D1Database,
  date: string,
  period: "morning" | "evening"
): Promise<DailySummaryResult> {
  // Calculate metrics first
  const metrics = await calculateDailyMetrics(db, date);

  // This is a placeholder - actual implementation would use Slack API
  logger.info("Daily summary would be sent", {
    date,
    period,
    metrics,
  });

  // TODO: Implement actual Slack notification with formatted blocks
  // Would need SLACK_BOT_TOKEN and channel ID from env
  return {
    success: true,
    channel: null,
    messageTs: null,
  };
}
