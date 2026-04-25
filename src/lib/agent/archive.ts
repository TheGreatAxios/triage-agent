import type { AgentOutput, AgentInput, BatchedMessage } from "../../types/agent";
import { logger } from "../logger";
import { getErrorMessage } from "../errors";

/**
 * Archive an agent trace to R2 for observability and debugging.
 * Stores full reasoning, context, and decisions.
 */
export async function archiveAgentTrace(
  archiveBucket: R2Bucket,
  chatId: number,
  input: AgentInput,
  output: AgentOutput,
  traceId: string
): Promise<string | null> {
  try {
    const timestamp = new Date().toISOString();
    const key = `traces/${chatId}/${timestamp}-${traceId}-agent.jsonl`;

    const trace = {
      timestamp,
      chatId,
      traceId,
      input: {
        messageId: input.messageId,
        text: input.text,
        sender: input.sender,
        isMention: input.isMention,
        batchedMessages: input.batchedMessages?.map((m: BatchedMessage) => ({
          messageId: m.messageId,
          text: m.text?.substring(0, 200), // Truncate for size
        })),
      },
      output: {
        action: output.action,
        confidence: output.confidence,
        resolutionSignal: output.resolutionSignal,
        reasoning: output.reasoning,
        toolsUsed: output.toolsUsed,
        executionTimeMs: output.executionTimeMs,
        isRetry: output.isRetry,
      },
    };

    await archiveBucket.put(key, JSON.stringify(trace), {
      httpMetadata: {
        contentType: "application/json",
      },
      customMetadata: {
        chatId: String(chatId),
        action: output.action,
        resolutionSignal: output.resolutionSignal,
        timestamp,
      },
    });

    logger.debug("Agent trace archived", { key, chatId, traceId });
    return key;
  } catch (err) {
    logger.error("Failed to archive agent trace", {
      chatId,
      error: getErrorMessage(err),
    });
    return null;
  }
}

/**
 * Archive a conversation transcript to R2 in human-readable format.
 */
export async function archiveConversationTranscript(
  archiveBucket: R2Bucket,
  chatId: number,
  telegramChatId: number,
  messages: Array<{
    id: number;
    text: string | null;
    sender: string;
    timestamp: string;
  }>,
  date: string
): Promise<string | null> {
  try {
    const key = `conversations/${chatId}/${date}-conversation.md`;

    // Build human-readable transcript
    let transcript = `# Conversation Transcript\n\n`;
    transcript += `Chat ID: ${chatId} (Telegram: ${telegramChatId})\n`;
    transcript += `Date: ${date}\n`;
    transcript += `Messages: ${messages.length}\n\n`;
    transcript += `---\n\n`;

    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      transcript += `**${msg.sender}** (${time}):\n`;
      transcript += `${msg.text || "[no text]"}\n\n`;
    }

    await archiveBucket.put(key, transcript, {
      httpMetadata: {
        contentType: "text/markdown",
      },
      customMetadata: {
        chatId: String(chatId),
        telegramChatId: String(telegramChatId),
        date,
        messageCount: String(messages.length),
      },
    });

    logger.debug("Conversation archived", { key, chatId, messageCount: messages.length });
    return key;
  } catch (err) {
    logger.error("Failed to archive conversation", {
      chatId,
      error: getErrorMessage(err),
    });
    return null;
  }
}

/**
 * Archive daily KPI metrics to R2.
 */
export async function archiveDailyKPIs(
  archiveBucket: R2Bucket,
  date: string,
  kpis: {
    agentAttempts: number;
    agentResolutions: number;
    agentEscalations: number;
    agentTimeouts: number;
    avgExecutionTimeMs: number;
    deflectionRate: number;
  }
): Promise<string | null> {
  try {
    const key = `kpis/agent-performance/${date}-daily.json`;

    const report = {
      date,
      generatedAt: new Date().toISOString(),
      metrics: {
        agent: {
          attempts: kpis.agentAttempts,
          resolutions: kpis.agentResolutions,
          escalations: kpis.agentEscalations,
          timeouts: kpis.agentTimeouts,
          avgExecutionTimeMs: kpis.avgExecutionTimeMs,
          deflectionRate: kpis.deflectionRate,
        },
      },
    };

    await archiveBucket.put(key, JSON.stringify(report, null, 2), {
      httpMetadata: {
        contentType: "application/json",
      },
      customMetadata: {
        date,
        deflectionRate: String(kpis.deflectionRate),
      },
    });

    logger.debug("Daily KPIs archived", { key, date, deflectionRate: kpis.deflectionRate });
    return key;
  } catch (err) {
    logger.error("Failed to archive daily KPIs", { date, error: getErrorMessage(err) });
    return null;
  }
}

/**
 * Persist an archive reference to D1 for tracking.
 */
export async function persistArchiveReference(
  db: D1Database,
  data: {
    chatId: number;
    r2Key: string;
    archiveType: "trace" | "conversation" | "kpi";
    windowStart: string;
    windowEnd: string;
    messageCount?: number;
    executionCount?: number;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agent_archives (
        chat_id, r2_key, archive_type, window_start, window_end,
        message_count, execution_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      data.chatId,
      data.r2Key,
      data.archiveType,
      data.windowStart,
      data.windowEnd,
      data.messageCount || null,
      data.executionCount || null
    )
    .run();
}

/**
 * Archive a retry attempt separately for debugging timeout issues.
 */
export async function archiveRetryTrace(
  archiveBucket: R2Bucket,
  chatId: number,
  originalError: string,
  retryOutput: AgentOutput,
  traceId: string
): Promise<string | null> {
  try {
    const timestamp = new Date().toISOString();
    const key = `traces/${chatId}/${timestamp}-${traceId}-retry.jsonl`;

    const trace = {
      timestamp,
      chatId,
      traceId,
      type: "retry",
      originalError,
      retryOutput: {
        action: retryOutput.action,
        confidence: retryOutput.confidence,
        reasoning: retryOutput.reasoning,
        executionTimeMs: retryOutput.executionTimeMs,
      },
    };

    await archiveBucket.put(key, JSON.stringify(trace), {
      httpMetadata: {
        contentType: "application/json",
      },
      customMetadata: {
        chatId: String(chatId),
        type: "retry",
        timestamp,
      },
    });

    logger.debug("Retry trace archived", { key, chatId, traceId });
    return key;
  } catch (err) {
    logger.error("Failed to archive retry trace", {
      chatId,
      error: getErrorMessage(err),
    });
    return null;
  }
}
