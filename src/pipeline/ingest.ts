import type { TelegramUpdate } from "../types/telegram";
import type { InternalEvent } from "../types/events";
import type { Env } from "../types/env";
import type { AgentInput } from "../types/agent";
import { normalizeUpdate } from "../lib/normalizer";
import { persistEvent, persistClassification, getChatByTelegramId } from "../lib/persistence";
import { classifyMessage, shouldElevateToAgent } from "../lib/classifier";
import { updateConversationState, scheduleNoResponseTimer, cancelTimers, getConversationState } from "../lib/state";
import { handleResponse } from "./respond";
import { trackPipelineMetrics } from "../lib/metrics";
import { logger } from "../lib/logger";
import { handleBotAddedToChat, handleBotRemovedFromChat } from "../lib/approval";
import { getErrorMessage } from "../lib/errors";
import { loadMCPServers, executeTools, formatToolContext, type ToolResult } from "../lib/mcp";
import {
  isTeamMember,
  recordTeamTouch,
  ensureFirstCustomerMessage,
  getTeamMemberByUsername,
} from "../lib/team";
import { executeAgent, handleAgentOutput } from "../lib/agent/unifiedAgent";
import { debounceMessage, processExpiredDebounces } from "../lib/agent/debounce";
import { getConfig } from "../lib/config";

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
    logger.info("Message already processed - skipping", { messageId: event.messageId, chatId: event.chatId });
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
      error: getErrorMessage(err),
    });
    throw err;
  }

  // TEAM DETECTION: Check if sender is a team member
  const senderUsername = event.sender.username || event.sender.name;
  const isTeam = await isTeamMember(env.DB, senderUsername);

  if (isTeam) {
    // Get team member details
    const teamMember = await getTeamMemberByUsername(env.DB, senderUsername);
    if (teamMember) {
      // Record this touch
      await recordTeamTouch(env.DB, dbChatId, teamMember.id, event.timestamp);

      // Cancel any pending timers since human is handling
      await cancelTimers(env.DB, dbChatId);

      logger.info("Team member response - skipping AI pipeline", { chatId: dbChatId, teamMember: teamMember.telegramUsername });

      // Skip AI processing entirely - human is handling
      return event;
    }
  } else {
    // Not a team member - this might be the first customer message
    await ensureFirstCustomerMessage(env.DB, dbChatId, senderUsername, event.timestamp);
  }

  try {
    await updateConversationState(env.DB, dbChatId, event);

    // Cancel any pending timers when a human responds (non-bot, non-team)
    if (!event.sender.isBot && !isTeam) {
      await cancelTimers(env.DB, dbChatId);
    }
  } catch (err) {
    logger.error("Failed to update conversation state", {
      update_id: event.id,
      error: getErrorMessage(err),
    });
  }

  // ============================================================================
  // TIERED CLASSIFICATION & RESPONSE PIPELINE
  // ============================================================================

  let classification;
  const classifyStart = Date.now();
  try {
    // TIER 1 & 2: Regex pre-filter + Rule-based classification
    classification = await classifyMessage(env, event);
    await persistClassification(env.DB, dbMessageId, dbChatId, classification);
    trackPipelineMetrics({ chatId: event.chatId, stage: "classify", durationMs: Date.now() - classifyStart, success: true });
  } catch (err) {
    trackPipelineMetrics({ chatId: event.chatId, stage: "classify", durationMs: Date.now() - classifyStart, success: false });
    logger.error("Failed to classify message", {
      update_id: event.id,
      error: getErrorMessage(err),
    });
  }

  // Skip response handling for bot messages
  if (!classification || event.sender.isBot) {
    return event;
  }

  // TIER 3: Check if we should elevate to Unified Agent
  if (shouldElevateToAgent(classification)) {
    // Apply debounce to batch rapid messages
    const debounceResult = await debounceMessage(env.DB, dbChatId, event, dbMessageId);

    if (!debounceResult.shouldTriggerAgent) {
      // Message debounced - agent will be triggered after debounce period
      logger.debug("Message debounced for agent batching", {
        chatId: dbChatId,
        debounceId: debounceResult.debounceId,
        batchedCount: debounceResult.batchedMessages.length,
      });
      return event;
    }

    // Debounce elapsed - trigger agent with batched context
    const agentStart = Date.now();
    try {
      // Build agent input with batched messages
      const lastMessage = debounceResult.batchedMessages[debounceResult.batchedMessages.length - 1] || {
        messageId: dbMessageId,
        text: event.text,
        sender: {
          id: event.sender.id,
          name: event.sender.name,
          username: event.sender.username,
          isBot: event.sender.isBot,
        },
        timestamp: event.timestamp,
      };

      const agentInput: AgentInput = {
        chatId: dbChatId,
        telegramChatId: event.chatId,
        messageId: lastMessage.messageId,
        text: lastMessage.text,
        sender: lastMessage.sender,
        timestamp: lastMessage.timestamp,
        isMention: event.isMention,
        batchedMessages: debounceResult.batchedMessages.slice(0, -1),
      };

      // Execute unified agent
      const agentOutput = await executeAgent(env, agentInput);

      // Handle agent decision
      await handleAgentOutput(env, dbChatId, lastMessage.messageId, agentOutput, classification);

      trackPipelineMetrics({
        chatId: event.chatId,
        stage: "agent",
        durationMs: Date.now() - agentStart,
        success: agentOutput.action !== "escalate" || agentOutput.confidence > 0,
      });

      logger.info("Unified Agent processed batched messages", {
        chatId: dbChatId,
        batchedCount: debounceResult.batchedMessages.length,
        action: agentOutput.action,
        confidence: agentOutput.confidence,
        resolutionSignal: agentOutput.resolutionSignal,
        executionTimeMs: agentOutput.executionTimeMs,
      });
    } catch (err) {
      trackPipelineMetrics({ chatId: event.chatId, stage: "agent", durationMs: Date.now() - agentStart, success: false });
      logger.error("Unified Agent execution failed", {
        chatId: dbChatId,
        error: getErrorMessage(err),
      });

      // Fallback: escalate to human on agent failure
      try {
        const { escalateToSlack, getChatTitle } = await import("../lib/escalation");
        const [chatTitle, recentMessages] = await Promise.all([
          getChatTitle(env.DB, dbChatId),
          import("../lib/queries").then((mod) =>
            mod.getFormattedMessagesForEscalation(env.DB, dbChatId, 5)
          ),
        ]);

        await escalateToSlack(env.DB, env.SLACK_WEBHOOK_URL, {
          chatId: dbChatId,
          chatTitle,
          draftId: null,
          draftContent: "Agent failed - manual review needed",
          classification,
          reason: `Agent execution failed: ${getErrorMessage(err)}`,
          recentMessages,
          responseConfidence: 0,
        });
      } catch (escalationErr) {
        logger.error("Agent fallback escalation also failed", {
          chatId: dbChatId,
          error: getErrorMessage(escalationErr),
        });
      }
    }

    return event;
  }

  // LEGACY FLOW: Handle Tier 1/2 classifications (bug, request, normal)
  // Bug/Request: immediate triage (Slack + Linear)
  // Normal: schedule timer for delayed draft (60s wait for potential human response)
  if (classification.label === "bug" || classification.label === "request") {
    const respondStart = Date.now();
    try {
      // Load and execute MCP tools in parallel for additional context
      const mcpServers = await loadMCPServers(
        env.DB,
        "default",
        classification.label,
        classification.confidence
      );

      let toolContext = "";
      let toolResults: ToolResult[] = [];
      if (mcpServers.length > 0) {
        toolResults = await executeTools(env, mcpServers, event.text);
        toolContext = formatToolContext(toolResults);

        logger.debug("MCP tools executed", {
          chatId: dbChatId,
          toolsUsed: toolResults.map((r) => r.tool).join(","),
          resultsCount: toolResults.filter((r) => r.result).length,
        });
      }

      await handleResponse(env, dbChatId, classification, dbMessageId, toolContext, toolResults);
      trackPipelineMetrics({ chatId: event.chatId, stage: "respond", durationMs: Date.now() - respondStart, success: true });
    } catch (err) {
      trackPipelineMetrics({ chatId: event.chatId, stage: "respond", durationMs: Date.now() - respondStart, success: false });
      logger.error("Failed to handle response for bug/request", {
        update_id: event.id,
        error: getErrorMessage(err),
      });
    }
  } else if (classification.label === "normal") {
    // Schedule timer to check for human response and draft if needed
    try {
      await scheduleNoResponseTimer(env.DB, dbChatId, "no_response");
    } catch (err) {
      logger.error("Failed to schedule timer for normal message", {
        update_id: event.id,
        error: getErrorMessage(err),
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
