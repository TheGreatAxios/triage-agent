import type { TelegramUpdate } from "../types/telegram";
import type { InternalEvent } from "../types/events";
import type { Env } from "../types/env";
import { normalizeUpdate } from "../lib/normalizer";
import { persistEvent, getChatByTelegramId } from "../lib/persistence";
import { updateConversationState, cancelTimers } from "../lib/state";
import { trackPipelineMetrics } from "../lib/metrics";
import { logger } from "../lib/logger";
import { handleBotAddedToChat, handleBotRemovedFromChat } from "../lib/approval";
import { getErrorMessage } from "../lib/errors";
import {
  isTeamMember,
  recordTeamTouch,
  ensureFirstCustomerMessage,
  getTeamMemberByUsername,
} from "../lib/team";
import { processTriageMessage } from "./triage";
import { sendErrorAlert } from "../lib/escalation";

/**
 * Ingest a Telegram update: validate → normalize → persist → state update → triage.
 * Runs entirely within a single waitUntil — Workers AI completes in 1-3s.
 */
export async function ingestUpdate(
  env: Env,
  update: TelegramUpdate
): Promise<void> {
  const pipelineStart = Date.now();
  const stageTimes: Record<string, number> = {};
  const stageStart = Date.now();

  // Handle bot being added/removed from chats first
  if (update.my_chat_member || update.chat_member) {
    const wasAdded = await handleBotAddedToChat(env, update);
    if (wasAdded) return;

    const wasRemoved = await handleBotRemovedFromChat(env, update);
    if (wasRemoved) return;
  }

  // Check if update is processable as a message
  if (!isProcessableUpdate(update)) {
    logger.debug("Skipping non-processable update", { update_id: update.update_id });
    return;
  }
  stageTimes.validation = Date.now() - stageStart;

  // Normalize the update to internal event format
  const event = normalizeUpdate(update);
  if (!event) {
    logger.debug("Normalizer returned null", { update_id: update.update_id });
    return;
  }

  const message = update.message ?? update.edited_message;
  if (!message) return;

  // IDEMPOTENCY: Check if this exact message was already processed
  const idempotencyStart = Date.now();
  const existingMessage = await env.DB.prepare(
    `SELECT am.id FROM active_messages am
     JOIN chats c ON c.id = am.chat_id
     WHERE am.telegram_message_id = ? AND c.telegram_chat_id = ?`
  ).bind(event.messageId, event.chatId).first<{ id: number }>();

  if (existingMessage) {
    logger.info("Message already processed — skipping", { messageId: event.messageId, chatId: event.chatId });
    return;
  }
  stageTimes.idempotency = Date.now() - idempotencyStart;

  // APPROVAL GATE: Check if chat is approved before processing messages
  const approvalStart = Date.now();
  const chatRecord = await getChatByTelegramId(env.DB, message.chat.id);
  if (!chatRecord || chatRecord.approval_status !== "approved") {
    logger.info("Ignoring message from unapproved chat", {
      telegram_chat_id: message.chat.id,
      chat_title: message.chat.title,
      approval_status: chatRecord?.approval_status || "unknown",
    });
    return;
  }
  stageTimes.approval_gate = Date.now() - approvalStart;

  let dbChatId: number;
  let dbMessageId: number;

  const persistStart = Date.now();
  try {
    const result = await persistEvent(env.DB, event, message.chat);
    dbChatId = result.chatId;
    dbMessageId = result.messageId;
    trackPipelineMetrics({ chatId: event.chatId, stage: "persist", durationMs: Date.now() - persistStart, success: true });
  } catch (err) {
    trackPipelineMetrics({ chatId: event.chatId, stage: "persist", durationMs: Date.now() - persistStart, success: false });
    logger.error("Failed to persist event", {
      update_id: event.id,
      error: getErrorMessage(err),
    });
    throw err;
  }
  stageTimes.persist = Date.now() - persistStart;

  // TEAM DETECTION: Check if sender is a team member
  const teamStart = Date.now();
  const senderUsername = event.sender.username || event.sender.name;
  const isTeam = await isTeamMember(env.DB, senderUsername);

  if (isTeam) {
    const teamMember = await getTeamMemberByUsername(env.DB, senderUsername);
    if (teamMember) {
      await recordTeamTouch(env.DB, dbChatId, teamMember.id, event.timestamp);
      await cancelTimers(env.DB, dbChatId);
      logger.info("Team member response — skipping AI pipeline", { chatId: dbChatId, teamMember: teamMember.telegramUsername, pipeline_duration_ms: Date.now() - pipelineStart });
      return;
    }
  } else {
    await ensureFirstCustomerMessage(env.DB, dbChatId, senderUsername, event.timestamp);
  }
  stageTimes.team_detection = Date.now() - teamStart;

  const stateStart = Date.now();
  try {
    await updateConversationState(env.DB, dbChatId, event);
    if (!event.sender.isBot && !isTeam) {
      await cancelTimers(env.DB, dbChatId);
    }
  } catch (err) {
    logger.error("Failed to update conversation state", {
      update_id: event.id,
      error: getErrorMessage(err),
    });
  }
  stageTimes.state_update = Date.now() - stateStart;

  // Skip AI pipeline for bot messages
  if (event.sender.isBot) {
    logger.info("Pipeline complete — bot message", { chatId: dbChatId, total_duration_ms: Date.now() - pipelineStart, stages: stageTimes });
    return;
  }

  // Guard: ensure AI binding is available before invoking LLM triage
  if (!env.AI) {
    logger.error("AI binding not available — skipping triage", {
      update_id: update.update_id,
      chatId: dbChatId,
    });
    // Escalate so the user knows AI triage is silently failing
    sendErrorAlert(
      env.DB,
      env.SLACK_WEBHOOK_URL,
      {
        chatId: dbChatId,
        errorType: "ConfigError",
        errorMessage: "AI binding not available — skipping triage. Messages will be persisted but not AI-classified.",
        messageText: event.text,
        sender: event.sender.username || event.sender.name,
      },
    ).catch((escalateErr) => {
      logger.error("Failed to escalate AI binding error to Slack", {
        chatId: dbChatId,
        error: getErrorMessage(escalateErr),
      });
    });
    return;
  }

  // Run triage inline — Workers AI calls complete in 1-3s, well within waitUntil limits
  const triageStart = Date.now();
  await processTriageMessage(env, {
    dbChatId,
    dbMessageId,
    telegramChatId: event.chatId,
    text: event.text,
    sender: {
      id: event.sender.id,
      username: event.sender.username ?? null,
      name: event.sender.name,
      isBot: event.sender.isBot,
    },
    updateId: update.update_id,
    messageId: event.messageId,
    timestamp: event.timestamp,
  });
  stageTimes.triage = Date.now() - triageStart;

  const totalDuration = Date.now() - pipelineStart;
  logger.info("Pipeline complete", {
    chatId: dbChatId,
    messageId: event.messageId,
    total_duration_ms: totalDuration,
    stages: stageTimes,
    within_waituntil_limit: totalDuration < 25000, // Log if approaching 30s limit
  });
}

function isProcessableUpdate(update: TelegramUpdate): boolean {
  const message = update.message ?? update.edited_message;
  if (!message) {
    logger.info("Skipping: no message or edited_message", { update_id: update.update_id });
    return false;
  }
  if (!message.from) {
    logger.info("Skipping: no sender (channel post?)", { update_id: update.update_id, chat_id: message.chat?.id });
    return false;
  }
  if (!message.text) {
    logger.info("Skipping: no text content", { update_id: update.update_id, chat_id: message.chat?.id, type: message.chat?.type });
    return false;
  }
  return true;
}
