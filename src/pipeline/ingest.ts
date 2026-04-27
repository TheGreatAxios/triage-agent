import type { TelegramUpdate } from "../types/telegram";
import type { InternalEvent } from "../types/events";
import type { Env } from "../types/env";
import { normalizeUpdate } from "../lib/normalizer";
import { persistEvent, persistClassification, getChatByTelegramId } from "../lib/persistence";
import { triageMessage } from "../lib/classifier";
import { updateConversationState, cancelTimers } from "../lib/state";
import { handleTriageResult } from "./respond";
import { trackPipelineMetrics } from "../lib/metrics";
import { logger } from "../lib/logger";
import { handleBotAddedToChat, handleBotRemovedFromChat } from "../lib/approval";
import { getErrorMessage } from "../lib/errors";
import { createPostHogClient, shutdownPostHog } from "../lib/telemetry";
import {
  isTeamMember,
  recordTeamTouch,
  ensureFirstCustomerMessage,
  getTeamMemberByUsername,
} from "../lib/team";
import { getOrRefreshSummary } from "../lib/summary";
import { getRecentMessagesWithSenders, buildMessageContext } from "../lib/queries";

/**
 * Full ingestion pipeline: validate → normalize → persist → triage → act.
 * Single LLM call for classify + draft + action decision.
 */
export async function ingestUpdate(
  env: Env,
  update: TelegramUpdate
): Promise<InternalEvent | null> {
  // Handle bot being added/removed from chats first
  if (update.my_chat_member || update.chat_member) {
    const wasAdded = await handleBotAddedToChat(env, update);
    if (wasAdded) return null;

    const wasRemoved = await handleBotRemovedFromChat(env, update);
    if (wasRemoved) return null;
  }

  // Check if update is processable as a message
  if (!isProcessableUpdate(update)) {
    logger.debug("Skipping non-processable update", { update_id: update.update_id });
    return null;
  }

  // Normalize the update to internal event format
  const event = normalizeUpdate(update);
  if (!event) {
    logger.debug("Normalizer returned null", { update_id: update.update_id });
    return null;
  }

  const message = update.message ?? update.edited_message;
  if (!message) return null;

  // IDEMPOTENCY: Check if this exact message was already processed
  const existingMessage = await env.DB.prepare(
    `SELECT am.id FROM active_messages am
     JOIN chats c ON c.id = am.chat_id
     WHERE am.telegram_message_id = ? AND c.telegram_chat_id = ?`
  ).bind(event.messageId, event.chatId).first<{ id: number }>();

  if (existingMessage) {
    logger.info("Message already processed — skipping", { messageId: event.messageId, chatId: event.chatId });
    return event;
  }

  // APPROVAL GATE: Check if chat is approved before processing messages
  const chatRecord = await getChatByTelegramId(env.DB, message.chat.id);
  if (!chatRecord || chatRecord.approval_status !== "approved") {
    logger.info("Ignoring message from unapproved chat", {
      telegram_chat_id: message.chat.id,
      chat_title: message.chat.title,
      approval_status: chatRecord?.approval_status || "unknown",
    });
    return null;
  }

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

  // TEAM DETECTION: Check if sender is a team member
  const senderUsername = event.sender.username || event.sender.name;
  const isTeam = await isTeamMember(env.DB, senderUsername);

  if (isTeam) {
    const teamMember = await getTeamMemberByUsername(env.DB, senderUsername);
    if (teamMember) {
      await recordTeamTouch(env.DB, dbChatId, teamMember.id, event.timestamp);
      await cancelTimers(env.DB, dbChatId);
      logger.info("Team member response — skipping AI pipeline", { chatId: dbChatId, teamMember: teamMember.telegramUsername });
      return event;
    }
  } else {
    await ensureFirstCustomerMessage(env.DB, dbChatId, senderUsername, event.timestamp);
  }

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

  // Skip AI pipeline for bot messages
  if (event.sender.isBot) return event;

  // ============================================================================
  // TRIAGE: Single LLM call — classify + draft + action
  // ============================================================================

  const triageStart = Date.now();
  const posthog = createPostHogClient(env);

  try {
    // Build conversation context for the LLM
    const context = await buildContext(env.DB, dbChatId);

    const triage = await triageMessage(env, event, context, posthog);

    // Persist classification for analytics / timer lookups
    await persistClassification(env.DB, dbMessageId, dbChatId, {
      label: triage.label,
      confidence: triage.confidence,
      method: triage.method,
      reasoning: triage.reasoning,
    });

    trackPipelineMetrics({ chatId: event.chatId, stage: "triage", durationMs: Date.now() - triageStart, success: true });

    // Act on the result
    await handleTriageResult(env, dbChatId, triage, dbMessageId);
  } catch (err) {
    trackPipelineMetrics({ chatId: event.chatId, stage: "triage", durationMs: Date.now() - triageStart, success: false });
    logger.error("Triage pipeline failed", {
      update_id: event.id,
      error: getErrorMessage(err),
    });
  } finally {
    // Flush PostHog telemetry — must happen before waitUntil expires
    await shutdownPostHog(posthog);
  }

  return event;
}

/**
 * Build conversation context string for the triage LLM.
 */
async function buildContext(db: D1Database, chatId: number): Promise<string> {
  const summary = await getOrRefreshSummary(db, chatId);

  const messages = await getRecentMessagesWithSenders(db, {
    chatId,
    limit: 10,
    order: "desc",
  });

  const recentMessages = buildMessageContext(messages.reverse());

  let context = "";
  if (summary) {
    context += `Summary:\n${summary.content}\n\n`;
  }
  context += `Recent messages:\n${recentMessages}`;

  return context;
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
