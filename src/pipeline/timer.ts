import type { Env } from "../types/env";
import type { ClassificationResult } from "../types/classification";
import { getFiredTimers, markTimerFired } from "../lib/state";
import { handleResponse } from "./respond";
import { logger } from "../lib/logger";

/**
 * Process all fired timers (called from scheduled handler).
 * For each fired timer, classify the latest message and run the response pipeline.
 */
export async function processTimers(env: Env): Promise<number> {
  const timers = await getFiredTimers(env.DB);

  if (timers.length === 0) return 0;

  logger.info("Processing fired timers", { count: timers.length });

  let processed = 0;

  for (const timer of timers) {
    try {
      const classification = await getLatestClassification(env.DB, timer.chatId);

      if (classification) {
        await handleResponse(env, timer.chatId, classification);
      } else {
        logger.warn("No classification found for timer chat", {
          timerId: timer.id,
          chatId: timer.chatId,
        });
      }

      await markTimerFired(env.DB, timer.id);
      processed++;

      logger.info("Timer processed", {
        timerId: timer.id,
        chatId: timer.chatId,
        type: timer.type,
      });
    } catch (err) {
      logger.error("Timer processing failed", {
        timerId: timer.id,
        chatId: timer.chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return processed;
}

async function getLatestClassification(
  db: D1Database,
  chatId: number
): Promise<ClassificationResult | null> {
  const row = await db
    .prepare(
      `SELECT label, confidence, method
       FROM classifications
       WHERE chat_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(chatId)
    .first<{ label: string; confidence: number; method: string }>();

  if (!row) return null;

  // Validate label is a valid ClassificationLabel
  const validLabels: ClassificationResult["label"][] = ["bug", "request", "normal", "unknown"];
  if (!validLabels.includes(row.label as ClassificationResult["label"])) {
    logger.warn("Invalid classification label in database", { label: row.label, chatId });
    return null;
  }

  // Validate method is a valid ClassificationMethod
  const validMethods: ClassificationResult["method"][] = ["rule", "model"];
  if (!validMethods.includes(row.method as ClassificationResult["method"])) {
    logger.warn("Invalid classification method in database", { method: row.method, chatId });
    return null;
  }

  return {
    label: row.label as ClassificationResult["label"],
    confidence: row.confidence,
    method: row.method as ClassificationResult["method"],
    reasoning: "From latest classification",
  };
}
