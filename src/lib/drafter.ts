import type { DraftStatus } from "../types/draft";
import { logger } from "./logger";
import { DatabaseError, getErrorMessage } from "./errors";

/**
 * Persist a draft to the database.
 * Used by the triage pipeline after the LLM returns a draft.
 */
export async function persistDraft(
  db: D1Database,
  chatId: number,
  content: string,
  confidence: number,
  responseConfidence: number,
  status: DraftStatus,
  toolsUsed?: string[],
  toolResults?: Array<{ tool: string; summary: string }>,
  options?: {
    classificationLabel?: string;
    classificationConfidence?: number;
    reasoning?: string;
    method?: string;
  },
): Promise<number> {
  try {
    await db
      .prepare(
        `INSERT INTO drafts (chat_id, content, confidence, response_confidence, status, tools_used, tool_results,
          classification_label, classification_confidence, reasoning, method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        chatId,
        content,
        confidence,
        responseConfidence,
        status,
        toolsUsed ? JSON.stringify(toolsUsed) : null,
        toolResults ? JSON.stringify(toolResults) : null,
        options?.classificationLabel ?? null,
        options?.classificationConfidence ?? null,
        options?.reasoning ?? null,
        options?.method ?? null,
      )
      .run();

    const row = await db
      .prepare(
        `SELECT id FROM drafts WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .bind(chatId)
      .first<{ id: number }>();

    if (!row) {
      throw new DatabaseError(
        `Draft was inserted but could not be retrieved`,
        "SELECT",
        "drafts",
        { chatId }
      );
    }

    return row.id;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(
      `Failed to persist draft for chat ${chatId}`,
      "INSERT",
      "drafts",
      { chatId, error: getErrorMessage(err) }
    );
  }
}

/**
 * Mark a draft as sent after successful Telegram delivery.
 */
export async function markDraftSent(db: D1Database, draftId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE drafts SET status = 'sent', sent_at = datetime('now') WHERE id = ?`
    )
    .bind(draftId)
    .run();
}

/**
 * Send a message to a Telegram chat via the Bot API.
 */
export async function sendTelegramMessage(
  botToken: string,
  chatTelegramId: number,
  text: string
): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatTelegramId,
        text,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.error("Telegram sendMessage failed", {
        status: resp.status,
        body,
      });
      return false;
    }

    return true;
  } catch (err) {
    logger.error("Telegram sendMessage error", {
      error: getErrorMessage(err),
    });
    return false;
  }
}
