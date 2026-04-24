import type { TelegramUpdate } from "../types/telegram";
import type { InternalEvent } from "../types/events";
import type { Env } from "../types/env";
import { normalizeUpdate } from "../lib/normalizer";
import { persistEvent, persistClassification } from "../lib/persistence";
import { classifyMessage } from "../lib/classifier";
import { updateConversationState, scheduleNoResponseTimer, cancelTimers } from "../lib/state";
import { handleResponse } from "./respond";
import { trackPipelineMetrics } from "../lib/metrics";
import { logger } from "../lib/logger";

/**
 * Full ingestion pipeline: validate → normalize → persist.
 * Returns the normalized event if processed, null if skipped.
 */
export async function ingestUpdate(
  env: Env,
  update: TelegramUpdate
): Promise<InternalEvent | null> {
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

    if (!event.sender.isBot) {
      await cancelTimers(env.DB, dbChatId);
    }

    if (event.isMention && !event.sender.isBot) {
      await scheduleNoResponseTimer(env.DB, dbChatId, "mention");
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

  if (classification && event.isMention && !event.sender.isBot) {
    const respondStart = Date.now();
    try {
      await handleResponse(env, dbChatId, classification);
      trackPipelineMetrics({ chatId: event.chatId, stage: "respond", durationMs: Date.now() - respondStart, success: true });
    } catch (err) {
      trackPipelineMetrics({ chatId: event.chatId, stage: "respond", durationMs: Date.now() - respondStart, success: false });
      logger.error("Failed to handle response", {
        update_id: event.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return event;
}

function isProcessableUpdate(update: TelegramUpdate): boolean {
  const message = update.message ?? update.edited_message;
  if (!message) return false;
  if (!message.from) return false;
  if (!message.text) return false;
  return true;
}
