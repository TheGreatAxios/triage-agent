import type { TelegramUpdate } from "../types/telegram";
import type { InternalEvent } from "../types/events";
import type { Env } from "../types/env";
import { normalizeUpdate } from "../lib/normalizer";
import { persistEvent, persistClassification, getChatByTelegramId } from "../lib/persistence";
import { classifyMessage } from "../lib/classifier";
import { updateConversationState, scheduleNoResponseTimer, cancelTimers } from "../lib/state";
import { handleResponse } from "./respond";
import { trackPipelineMetrics } from "../lib/metrics";
import { logger } from "../lib/logger";
import { handleBotAddedToChat, handleBotRemovedFromChat } from "../lib/approval";

/**
 * Full ingestion pipeline: validate → normalize → persist.
 * Returns the normalized event if processed, null if skipped.
 */
export async function ingestUpdate(
  env: Env,
  update: TelegramUpdate
): Promise<InternalEvent | null> {
  // Handle bot being added/removed from chats first
  if (update.my_chat_member || update.chat_member) {
    const wasAdded = await handleBotAddedToChat(env, update);
    if (wasAdded) {
      // Approval request sent, stop processing
      return null;
    }

    const wasRemoved = await handleBotRemovedFromChat(env, update);
    if (wasRemoved) {
      // Chat removed, stop processing
      return null;
    }
  }

  // Check if update is processable as a message
  if (!isProcessableUpdate(update)) {
    logger.debug("Skipping non-processable update", { update_id: update.update_id });
    return null;
  }

  const event = normalizeUpdate(update);
  if (!event) {
    logger.debug("Normalizer returned null", { update_id: update.update_id });
    return null;
  }

  const message = update.message ?? update.edited_message;
  if (!message) return null;

  // APPROVAL GATE: Check if chat is approved before processing messages
  const chatRecord = await getChatByTelegramId(env.DB, message.chat.id);
  if (!chatRecord || chatRecord.approval_status !== "approved") {
    logger.info("Ignoring message from unapproved chat", {
      telegram_chat_id: message.chat.id,
      chat_title: message.chat.title,
      approval_status: chatRecord?.approval_status || "unknown",
    });
    return null; // Bot acts invisible in unapproved chats
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
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  try {
    await updateConversationState(env.DB, dbChatId, event);

    // Cancel any pending timers when a human responds
    if (!event.sender.isBot) {
      await cancelTimers(env.DB, dbChatId);
    }
  } catch (err) {
    logger.error("Failed to update conversation state", {
      update_id: event.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let classification;
  const classifyStart = Date.now();
  try {
    classification = await classifyMessage(env, event);
    await persistClassification(env.DB, dbMessageId, dbChatId, classification);
    trackPipelineMetrics({ chatId: event.chatId, stage: "classify", durationMs: Date.now() - classifyStart, success: true });
  } catch (err) {
    trackPipelineMetrics({ chatId: event.chatId, stage: "classify", durationMs: Date.now() - classifyStart, success: false });
    logger.error("Failed to classify message", {
      update_id: event.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Skip response handling for bot messages
  if (!classification || event.sender.isBot) {
    return event;
  }

  // Bug/Request: immediate triage (Slack + Linear)
  // Normal: schedule timer for delayed draft (60s wait for potential human response)
  if (classification.label === "bug" || classification.label === "request") {
    const respondStart = Date.now();
    try {
      await handleResponse(env, dbChatId, classification);
      trackPipelineMetrics({ chatId: event.chatId, stage: "respond", durationMs: Date.now() - respondStart, success: true });
    } catch (err) {
      trackPipelineMetrics({ chatId: event.chatId, stage: "respond", durationMs: Date.now() - respondStart, success: false });
      logger.error("Failed to handle response for bug/request", {
        update_id: event.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (classification.label === "normal") {
    // Schedule timer to check for human response and draft if needed
    try {
      await scheduleNoResponseTimer(env.DB, dbChatId, "no_response");
    } catch (err) {
      logger.error("Failed to schedule timer for normal message", {
        update_id: event.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return event;
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
