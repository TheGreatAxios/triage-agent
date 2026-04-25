/** Agent decision types for the tiered agent system */

export type AgentAction = "respond" | "escalate" | "debounced" | "ignore";

export type ResolutionSignal = "resolved" | "acknowledgment" | "unresolved" | "neutral" | "follow_up_needed" | "none";

/** Output from the unified agent execution */
export interface AgentOutput {
  action: AgentAction;
  content?: string;  // Response text if action=respond
  reasoning: string;
  confidence: number;
  resolutionSignal: ResolutionSignal;
  toolsUsed: string[];
  executionTimeMs: number;
  isRetry: boolean;
}

/** Input to the unified agent */
export interface AgentInput {
  chatId: number;
  telegramChatId: number;
  messageId: number;
  text: string;
  sender: {
    id: number;
    name: string;
    username?: string;
    isBot: boolean;
  };
  timestamp: string;
  isMention: boolean;
  disableReasoning?: boolean;  // Set to true on retry after timeout
  batchedMessages?: BatchedMessage[];  // Multiple messages if debounced
}

/** A batched message from debounce period */
export interface BatchedMessage {
  messageId: number;
  text: string;
  sender: {
    id: number;
    name: string;
    username?: string;
    isBot: boolean;
  };
  timestamp: string;
}

/** Tool definition for the agent */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: unknown) => Promise<unknown>;
}

/** Context for agent execution */
export interface AgentContext {
  chatId: number;
  conversationHistory: string[];
  previousDrafts: PreviousDraft[];
  solutionAttemptCount: number;
  threadConfidenceScore: number;
  resolutionStatus: string;
}

/** Previous draft information */
export interface PreviousDraft {
  draftId: number;
  content: string;
  confidence: number;
  sentAt: string;
  userResponse?: string;
}

/** Agent decision record for database persistence */
export interface AgentDecisionRecord {
  chatId: number;
  messageId: number;
  action: AgentAction;
  content?: string;
  reasoning: string;
  confidence: number;
  resolutionSignal: ResolutionSignal;
  toolsUsed: string[];
  executionTimeMs: number;
  isRetry: boolean;
  traceKey?: string;
}
