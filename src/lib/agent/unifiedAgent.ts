import { generateText } from "ai";
import type { Env } from "../../types/env";
import type {
  AgentInput,
  AgentOutput,
  AgentAction,
  ResolutionSignal,
  AgentContext,
  AgentDecisionRecord,
} from "../../types/agent";
import type { ClassificationResult } from "../../types/classification";
import { getModel } from "../ai";
import { logger } from "../logger";
import { getConfig } from "../config";
import { getErrorMessage } from "../errors";
import { getOrRefreshSummary } from "../summary";
import {
  getRecentMessagesWithSenders,
  getRecentDraftsWithResponses,
  buildMessageContext,
} from "../queries";
import { getConversationState } from "../state";
import { escalateToSlack, getChatTitle } from "../escalation";
import { sendTelegramMessage } from "../drafter";
import { createTriageIssue, persistLinearLink } from "../linear";
import { persistAgentDecision } from "../persistence";
import { archiveAgentTrace, archiveRetryTrace } from "./archive";

// ============================================================================
// AGENT SYSTEM PROMPT
// ============================================================================

const AGENT_SYSTEM_PROMPT = `You are an autonomous support agent for a Telegram community.
Your goal: classify messages, detect resolution signals, generate responses, and escalate when needed.

CAPABILITIES:
- Classify: bug, request, normal, unknown
- Detect resolution signals from user responses
- Generate friendly, casual responses (never "botty")
- Escalate to humans when uncertain or after 3 failed solutions

RESOLUTION SIGNALS (detect from user messages):
- "resolved": User confirms problem is fixed ("works now!", "fixed it", "solved")
- "acknowledgment": User confirms understanding ("thanks", "got it", "👍", "makes sense")
- "unresolved": Problem persists ("still broken", "didn't work", "same error")
- "neutral": No clear signal (questions, unrelated messages)
- "follow_up_needed": Needs clarification ("what do you mean?", "how?")

ESCALATION TRIGGERS (must escalate to human):
- unresolved signal received
- 3+ solution attempts without resolution
- confidence < 0.4 after retry
- timeout on both execution attempts
- ambiguous classification with low confidence

TONE REQUIREMENTS:
- Casual, friendly, helpful
- Use emojis naturally (🎉 ✅ 💪 🔧)
- Never say "marked as resolved" or "ticket closed"
- Examples: "Awesome! 🎉 Glad that worked!", "Got it - let me help with that 🔧"

Respond in JSON format:
{
  "action": "respond|escalate|ignore",
  "content": "your response text if action=respond",
  "reasoning": "explanation of your decision",
  "confidence": 0.0-1.0,
  "resolutionSignal": "resolved|acknowledgment|unresolved|neutral|follow_up_needed|none"
}`;

const AGENT_SYSTEM_PROMPT_NO_REASONING = `You are an autonomous support agent for a Telegram community.
Your goal: classify messages, detect resolution signals, generate responses, and escalate when needed.

QUICK DECISION MODE (no deep reasoning):
- If user confirms fix works → action: respond with celebration
- If user says thanks/got it → action: respond briefly
- If user says still broken/didn't work → action: escalate
- If unclear or 3+ attempts → action: escalate
- Otherwise → action: respond helpfully

TONE: Casual, friendly, use emojis naturally.

Respond in JSON format:
{
  "action": "respond|escalate|ignore",
  "content": "your response text if action=respond",
  "reasoning": "brief explanation",
  "confidence": 0.0-1.0,
  "resolutionSignal": "resolved|acknowledgment|unresolved|neutral|follow_up_needed|none"
}`;

// ============================================================================
// UNIFIED AGENT CLASS
// ============================================================================

export class UnifiedAgent {
  private env: Env;
  private toolCache: Map<string, unknown> = new Map();

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Execute the agent with timeout and retry logic.
   * First attempt: Full reasoning with 60s timeout
   * On timeout: Retry with reasoning disabled (simpler, faster)
   */
  async execute(input: AgentInput): Promise<AgentOutput> {
    const config = getConfig();
    const startTime = Date.now();

    try {
      // Attempt 1: Full reasoning
      const result = await this.executeWithTimeout(
        input,
        config.agentTimeoutMs,
        false
      );
      return {
        ...result,
        executionTimeMs: Date.now() - startTime,
        isRetry: false,
      };
    } catch (err) {
      if (getErrorMessage(err).includes("timeout")) {
        logger.warn("Agent timeout, retrying without reasoning", {
          chatId: input.chatId,
        });

        try {
          // Attempt 2: Retry without reasoning
          const retryResult = await this.executeWithTimeout(
            input,
            config.agentTimeoutMs,
            true
          );
          return {
            ...retryResult,
            executionTimeMs: Date.now() - startTime,
            isRetry: true,
          };
        } catch (retryErr) {
          logger.error("Agent retry failed, escalating to human", {
            chatId: input.chatId,
            error: getErrorMessage(retryErr),
          });

          return {
            action: "escalate",
            reasoning: "Agent timeout - unable to process after retry",
            confidence: 0,
            resolutionSignal: "none",
            toolsUsed: [],
            executionTimeMs: Date.now() - startTime,
            isRetry: true,
          };
        }
      }

      throw err;
    }
  }

  private async executeWithTimeout(
    input: AgentInput,
    timeoutMs: number,
    disableReasoning: boolean
  ): Promise<Omit<AgentOutput, "executionTimeMs" | "isRetry">> {
    return Promise.race([
      this.runAgent(input, disableReasoning),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AGENT_TIMEOUT")), timeoutMs)
      ),
    ]);
  }

  private async runAgent(
    input: AgentInput,
    disableReasoning: boolean
  ): Promise<Omit<AgentOutput, "executionTimeMs" | "isRetry">> {
    const startTime = Date.now();

    // Build context
    const context = await this.buildAgentContext(input);

    // Build prompt with context
    const prompt = this.buildPrompt(input, context);

    // Execute model
    const model = getModel(this.env, "agent");
    const systemPrompt = disableReasoning
      ? AGENT_SYSTEM_PROMPT_NO_REASONING
      : AGENT_SYSTEM_PROMPT;

    const { text } = await generateText({
      model,
      system: systemPrompt,
      prompt,
      maxOutputTokens: 500,
      temperature: disableReasoning ? 0.3 : 0.7,
      providerOptions: {
        openai: {
          reasoningEffort: disableReasoning ? "none" : "low",
          serviceTier: "flex",
        },
      },
    });

    // Parse response
    const parsed = this.parseAgentResponse(text);
    if (!parsed) {
      return {
        action: "escalate",
        reasoning: "Failed to parse agent response",
        confidence: 0,
        resolutionSignal: "none",
        toolsUsed: [],
      };
    }

    // Check solution attempt limit
    const config = getConfig();
    if (context.solutionAttemptCount >= config.agentMaxSolutionAttempts) {
      return {
        action: "escalate",
        content: parsed.content,
        reasoning: `Maximum solution attempts (${config.agentMaxSolutionAttempts}) reached. Escalating to human.`,
        confidence: parsed.confidence,
        resolutionSignal: parsed.resolutionSignal as ResolutionSignal,
        toolsUsed: [],
      };
    }

    // Auto-escalate on unresolved signal
    if (parsed.resolutionSignal === "unresolved") {
      return {
        action: "escalate",
        content: parsed.content,
        reasoning: "User indicated previous solution did not resolve issue",
        confidence: parsed.confidence,
        resolutionSignal: "unresolved",
        toolsUsed: [],
      };
    }

    return {
      action: parsed.action as AgentAction,
      content: parsed.content,
      reasoning: parsed.reasoning,
      confidence: parsed.confidence,
      resolutionSignal: parsed.resolutionSignal as ResolutionSignal,
      toolsUsed: [], // Simplified for now, can add tool use later
    };
  }

  private buildPrompt(input: AgentInput, context: AgentContext): string {
    let prompt = `Chat ID: ${input.chatId}\n`;
    prompt += `Current message: "${input.text}"\n`;
    prompt += `From: ${input.sender.name} (@${input.sender.username || "unknown"})\n\n`;

    if (input.batchedMessages && input.batchedMessages.length > 0) {
      prompt += "Recent messages (batched):\n";
      for (const msg of input.batchedMessages.slice(-5)) {
        prompt += `- ${msg.sender.name}: "${msg.text}"\n`;
      }
      prompt += "\n";
    }

    if (context.conversationHistory.length > 0) {
      prompt += "Conversation history:\n";
      for (const msg of context.conversationHistory.slice(-10)) {
        prompt += `- ${msg}\n`;
      }
      prompt += "\n";
    }

    if (context.previousDrafts.length > 0) {
      prompt += "Previous agent responses:\n";
      for (const draft of context.previousDrafts.slice(-3)) {
        prompt += `- Draft: "${draft.content.substring(0, 100)}..." (confidence: ${draft.confidence})\n`;
        if (draft.userResponse) {
          prompt += `  User response: "${draft.userResponse}"\n`;
        }
      }
      prompt += `\nSolution attempts so far: ${context.solutionAttemptCount}\n\n`;
    }

    prompt += "Analyze this message and respond in the required JSON format.";

    return prompt;
  }

  private async buildAgentContext(input: AgentInput): Promise<AgentContext> {
    // Get conversation state
    const state = await getConversationState(this.env.DB, input.chatId);

    // Get recent messages
    const messages = await getRecentMessagesWithSenders(this.env.DB, {
      chatId: input.chatId,
      limit: 15,
      order: "desc",
    });

    // Build history as array of formatted messages
    const conversationHistory = messages.reverse().map(
      (m) => `[${m.display_name}]: ${m.text ?? ""}`
    );

    // Get previous drafts with user responses
    const previousDrafts = await getRecentDraftsWithResponses(
      this.env.DB,
      input.chatId,
      5
    );

    return {
      chatId: input.chatId,
      conversationHistory,
      previousDrafts,
      solutionAttemptCount: state?.solutionAttemptCount || 0,
      threadConfidenceScore: state?.threadConfidenceScore || 0,
      resolutionStatus: state?.resolutionStatus || "na",
    };
  }

  private parseAgentResponse(
    text: string
  ): {
    action: string;
    content?: string;
    reasoning: string;
    confidence: number;
    resolutionSignal: string;
  } | null {
    try {
      // Extract JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

      // Validate required fields
      if (typeof parsed.action !== "string") return null;
      if (typeof parsed.reasoning !== "string") return null;

      const confidence =
        typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5;

      return {
        action: parsed.action,
        content: typeof parsed.content === "string" ? parsed.content : undefined,
        reasoning: parsed.reasoning,
        confidence,
        resolutionSignal:
          typeof parsed.resolutionSignal === "string"
            ? parsed.resolutionSignal
            : "none",
      };
    } catch {
      return null;
    }
  }
}

// ============================================================================
// AGENT EXECUTION WITH PERSISTENCE
// ============================================================================

/**
 * Execute the unified agent and persist the decision.
 * This is the main entry point for agent execution.
 */
export async function executeAgent(
  env: Env,
  input: AgentInput
): Promise<AgentOutput> {
  const agent = new UnifiedAgent(env);
  const output = await agent.execute(input);

  // Persist the decision
  const decision: AgentDecisionRecord = {
    chatId: input.chatId,
    messageId: input.messageId,
    action: output.action,
    content: output.content,
    reasoning: output.reasoning,
    confidence: output.confidence,
    resolutionSignal: output.resolutionSignal,
    toolsUsed: output.toolsUsed,
    executionTimeMs: output.executionTimeMs,
    isRetry: output.isRetry,
  };

  try {
    await persistAgentDecision(env.DB, decision);
  } catch (err) {
    logger.error("Failed to persist agent decision", {
      chatId: input.chatId,
      error: getErrorMessage(err),
    });
  }

  // Archive trace to R2 for observability
  try {
    const traceId = `agent-${input.messageId}`;
    const traceKey = await archiveAgentTrace(
      env.ARCHIVE,
      input.chatId,
      input,
      output,
      traceId
    );

    if (traceKey) {
      logger.debug("Agent trace archived to R2", { traceKey, chatId: input.chatId });
    }

    // If this was a retry, also archive the retry trace
    if (output.isRetry) {
      const retryKey = await archiveRetryTrace(
        env.ARCHIVE,
        input.chatId,
        "Agent timeout - retry without reasoning",
        output,
        traceId
      );

      if (retryKey) {
        logger.debug("Agent retry trace archived to R2", { retryKey, chatId: input.chatId });
      }
    }
  } catch (err) {
    // Non-fatal: archive failures shouldn't break the flow
    logger.warn("Failed to archive agent trace", {
      chatId: input.chatId,
      error: getErrorMessage(err),
    });
  }

  return output;
}

/**
 * Handle the agent output - send response, escalate, or ignore.
 */
export async function handleAgentOutput(
  env: Env,
  chatId: number,
  dbMessageId: number,
  output: AgentOutput,
  classification: ClassificationResult
): Promise<void> {
  switch (output.action) {
    case "respond": {
      if (!output.content) {
        logger.warn("Agent responded but no content provided", { chatId });
        return;
      }

      // Send via Telegram
      const telegramChatId = await getTelegramChatIdFromDb(env.DB, chatId);
      if (!telegramChatId) {
        logger.error("Cannot send agent response: Telegram chat ID not found", {
          chatId,
        });
        return;
      }

      const sent = await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        telegramChatId,
        output.content
      );

      if (sent) {
        logger.info("Agent response sent", {
          chatId,
          confidence: output.confidence,
          resolutionSignal: output.resolutionSignal,
        });
      } else {
        logger.error("Failed to send agent response", { chatId });
      }
      break;
    }

    case "escalate": {
      // Get context for escalation
      const [chatTitle, recentMessages] = await Promise.all([
        getChatTitle(env.DB, chatId),
        getRecentMessagesWithSenders(env.DB, { chatId, limit: 5, order: "desc" }),
      ]);

      // Build escalation context
      const formattedMessages = recentMessages.map(
        (m) => `${m.display_name}: ${m.text}`
      );

      await escalateToSlack(env.DB, env.SLACK_WEBHOOK_URL, {
        chatId,
        chatTitle,
        draftId: null,
        draftContent: output.content || null,
        classification,
        reason: output.reasoning,
        recentMessages: formattedMessages,
        responseConfidence: output.confidence,
      });

      // Create Linear triage issue
      if (classification.label === "bug" || classification.label === "request") {
        try {
          const issue = await createTriageIssue(
            env,
            chatTitle,
            classification,
            formattedMessages
          );

          if (issue && dbMessageId) {
            await persistLinearLink(env.DB, chatId, dbMessageId, issue.issueId, issue.issueUrl);
          }
        } catch (err) {
          logger.error("Failed to create Linear triage issue from agent escalation", {
            chatId,
            error: getErrorMessage(err),
          });
        }
      }

      logger.info("Agent escalated to human", {
        chatId,
        reasoning: output.reasoning,
        confidence: output.confidence,
      });
      break;
    }

    case "ignore": {
      logger.info("Agent decided to ignore message", {
        chatId,
        reasoning: output.reasoning,
      });
      break;
    }

    case "debounced": {
      logger.info("Message debounced for batching", { chatId });
      break;
    }
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function getTelegramChatIdFromDb(
  db: D1Database,
  chatId: number
): Promise<number | null> {
  const row = await db
    .prepare("SELECT telegram_chat_id FROM chats WHERE id = ?")
    .bind(chatId)
    .first<{ telegram_chat_id: number }>();

  return row?.telegram_chat_id ?? null;
}
