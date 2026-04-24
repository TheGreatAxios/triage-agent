import { Hono } from "hono";
import type { AppEnv } from "../types/env";
import type { TelegramUpdate } from "../types/telegram";
import { verifyTelegramWebhook } from "../lib/telegram";
import { checkRateLimit } from "../lib/rate-limiter";
import { ingestUpdate } from "../pipeline/ingest";
import { logger } from "../lib/logger";

/**
 * Telegram webhook handler.
 *
 * TODO: When adding multi-source support, refactor to:
 * 1. Extract Telegram-specific logic to a TelegramAdapter class
 * 2. Route /webhook/:source to appropriate adapter via SourceRegistry
 * 3. Keep verification logic in adapter (verifyTelegramWebhook -> adapter.verify)
 */

export const webhook = new Hono<AppEnv>();

webhook.post("/telegram", async (c) => {
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  const secretHeader = c.req.header("X-Telegram-Bot-Api-Secret-Token");

  if (!verifyTelegramWebhook(secret, secretHeader)) {
    logger.warn("Webhook verification failed");
    return c.json({ error: "Unauthorized" }, 401);
  }

  let update: TelegramUpdate;
  try {
    update = await c.req.json<TelegramUpdate>();
  } catch {
    logger.warn("Malformed webhook payload");
    return c.json({ error: "Bad request" }, 400);
  }

  if (!update.update_id) {
    logger.warn("Missing update_id in payload");
    return c.json({ error: "Bad request" }, 400);
  }

  logger.info("Received Telegram update", { update_id: update.update_id });

  const chatId = update.message?.chat.id ?? update.edited_message?.chat.id;
  if (chatId) {
    const allowed = await checkRateLimit(c.env.DB, chatId);
    if (!allowed) {
      return c.json({ ok: true });
    }
  }

  c.executionCtx.waitUntil(
    ingestUpdate(c.env, update).catch((err) => {
      logger.error("Ingestion pipeline error", {
        update_id: update.update_id,
        error: err instanceof Error ? err.message : String(err),
      });
    })
  );

  return c.json({ ok: true });
});
