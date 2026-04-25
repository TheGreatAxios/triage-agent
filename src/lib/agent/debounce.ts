import type { Env } from "../../types/env";
import type { AgentInput, BatchedMessage } from "../../types/agent";
import type { InternalEvent } from "../../types/events";
import { logger } from "../logger";
import { getErrorMessage } from "../errors";
import { getConfig } from "../config";

/**
 * Check if there's an active debounce for this chat.
 * Returns existing debounce info or null if no active debounce.
 */
export async function getActiveDebounce(
  db: D1Database,
  chatId: number
): Promise<{
  id: number;
  firstMessageAt: string;
  lastMessageAt: string;
  messageCount: number;
} | null> {
  const row = await db
    .prepare(
      `SELECT id, first_message_at, last_message_at, message_count
       FROM agent_debounces
       WHERE chat_id = ? AND status = 'active'`
    )
    .bind(chatId)
    .first<{
      id: number;
      first_message_at: string;
      last_message_at: string;
      message_count: number;
    }>();

  return row
    ? {
        id: row.id,
        firstMessageAt: row.first_message_at,
        lastMessageAt: row.last_message_at,
        messageCount: row.message_count,
      }
    : null;
}

/**
 * Create or update a debounce record for message batching.
 * Returns the debounce ID and whether this triggered the agent.
 */
export async function debounceMessage(
  db: D1Database,
  chatId: number,
  event: InternalEvent,
  dbMessageId: number
): Promise<{
  debounceId: number;
  shouldTriggerAgent: boolean;
  batchedMessages: BatchedMessage[];
}> {
  const config = getConfig();
  const now = new Date().toISOString();

  // Check for existing debounce
  const existing = await getActiveDebounce(db, chatId);

  if (existing) {
    // Update existing debounce
    await db
      .prepare(
        `UPDATE agent_debounces
         SET last_message_at = ?, message_count = message_count + 1
         WHERE id = ?`
      )
      .bind(now, existing.id)
      .run();

    // Check if debounce period has elapsed
    const firstMessageTime = new Date(existing.firstMessageAt).getTime();
    const elapsedMs = Date.now() - firstMessageTime;
    const shouldTriggerAgent = elapsedMs >= config.agentDebounceSeconds * 1000;

    // Get all batched messages
    const batchedMessages = await getBatchedMessages(db, chatId, existing.firstMessageAt);

    if (shouldTriggerAgent) {
      // Mark as triggered
      await db
        .prepare(
          `UPDATE agent_debounces SET status = 'triggered', triggered_at = ? WHERE id = ?`
        )
        .bind(now, existing.id)
        .run();
    }

    return {
      debounceId: existing.id,
      shouldTriggerAgent,
      batchedMessages,
    };
  } else {
    // Create new debounce
    await db
      .prepare(
        `INSERT INTO agent_debounces (chat_id, first_message_at, last_message_at, message_count, status)
         VALUES (?, ?, ?, 1, 'active')`
      )
      .bind(chatId, now, now)
      .run();

    const row = await db
      .prepare(
        `SELECT id FROM agent_debounces WHERE chat_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`
      )
      .bind(chatId)
      .first<{ id: number }>();

    // First message always waits for more or timeout
    return {
      debounceId: row?.id || 0,
      shouldTriggerAgent: false,
      batchedMessages: [
        {
          messageId: dbMessageId,
          text: event.text,
          sender: {
            id: event.sender.id,
            name: event.sender.name,
            username: event.sender.username,
            isBot: event.sender.isBot,
          },
          timestamp: event.timestamp,
        },
      ],
    };
  }
}

/**
 * Get all messages in the current debounce window.
 */
async function getBatchedMessages(
  db: D1Database,
  chatId: number,
  since: string
): Promise<BatchedMessage[]> {
  const { results } = await db
    .prepare(
      `SELECT
        am.id as message_id,
        am.text,
        cp.display_name as sender_name,
        am.created_at as timestamp
       FROM active_messages am
       JOIN chat_participants cp ON cp.id = am.sender_id
       WHERE am.chat_id = ? AND am.created_at >= ?
       ORDER BY am.created_at ASC`
    )
    .bind(chatId, since)
    .all<{
      message_id: number;
      text: string;
      sender_name: string;
      timestamp: string;
    }>();

  return (results || []).map((row) => ({
    messageId: row.message_id,
    text: row.text,
    sender: {
      id: 0, // Not needed for agent context
      name: row.sender_name,
      isBot: false,
    },
    timestamp: row.timestamp,
  }));
}

/**
 * Process expired debounces (trigger agent for messages that waited too long).
 * Called by the scheduled timer job.
 */
export async function processExpiredDebounces(
  db: D1Database,
  env: Env
): Promise<void> {
  const config = getConfig();
  const now = new Date().toISOString();

  // Find debounces that have exceeded the debounce window
  const { results } = await db
    .prepare(
      `SELECT id, chat_id, first_message_at, message_count
       FROM agent_debounces
       WHERE status = 'active'
       AND datetime(first_message_at, '+${config.agentDebounceSeconds} seconds') <= datetime('now')`
    )
    .all<{
      id: number;
      chat_id: number;
      first_message_at: string;
      message_count: number;
    }>();

  if (!results || results.length === 0) {
    return;
  }

  logger.info(`Processing ${results.length} expired debounces`, {
    count: results.length,
  });

  // Trigger agent for each expired debounce
  for (const debounce of results) {
    try {
      // Get the batched messages
      const batchedMessages = await getBatchedMessages(
        db,
        debounce.chat_id,
        debounce.first_message_at
      );

      if (batchedMessages.length === 0) {
        // No messages found, cancel the debounce
        await db
          .prepare(`UPDATE agent_debounces SET status = 'cancelled' WHERE id = ?`)
          .bind(debounce.id)
          .run();
        continue;
      }

      // Mark as triggered
      await db
        .prepare(
          `UPDATE agent_debounces SET status = 'triggered', triggered_at = ? WHERE id = ?`
        )
        .bind(now, debounce.id)
        .run();

      // Import and execute agent dynamically to avoid circular dependencies
      const { executeAgent, handleAgentOutput } = await import("./unifiedAgent");
      const { getChatById } = await import("../persistence");

      const chat = await getChatById(db, debounce.chat_id);
      if (!chat) {
        logger.error("Chat not found for debounced messages", {
          chatId: debounce.chat_id,
        });
        continue;
      }

      // Build agent input with batched messages
      const lastMessage = batchedMessages[batchedMessages.length - 1];
      const agentInput: AgentInput = {
        chatId: debounce.chat_id,
        telegramChatId: chat.telegram_chat_id,
        messageId: lastMessage.messageId,
        text: lastMessage.text,
        sender: lastMessage.sender,
        timestamp: lastMessage.timestamp,
        isMention: false,
        batchedMessages: batchedMessages.slice(0, -1), // All but the last
      };

      // Execute agent
      const agentOutput = await executeAgent(env, agentInput);

      // Create a dummy classification for handleAgentOutput
      const classification = {
        label: "normal" as const,
        confidence: 0.5,
        method: "rule" as const,
        reasoning: "Debounced messages - batched for agent analysis",
      };

      await handleAgentOutput(env, debounce.chat_id, lastMessage.messageId, agentOutput, classification);

      logger.info("Agent processed debounced messages", {
        chatId: debounce.chat_id,
        messageCount: batchedMessages.length,
        action: agentOutput.action,
      });
    } catch (err) {
      logger.error("Failed to process expired debounce", {
        debounceId: debounce.id,
        chatId: debounce.chat_id,
        error: getErrorMessage(err),
      });

      // Mark as cancelled to prevent reprocessing
      await db
        .prepare(`UPDATE agent_debounces SET status = 'cancelled' WHERE id = ?`)
        .bind(debounce.id)
        .run();
    }
  }
}
