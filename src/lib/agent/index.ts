// Unified Agent System Exports
// Tiered Agent System for autonomous support resolution

export {
  UnifiedAgent,
  executeAgent,
  handleAgentOutput,
} from "./unifiedAgent";

export {
  archiveAgentTrace,
  archiveConversationTranscript,
  archiveDailyKPIs,
  archiveRetryTrace,
  persistArchiveReference,
} from "./archive";

export {
  debounceMessage,
  processExpiredDebounces,
  getActiveDebounce,
} from "./debounce";

// Re-export types from agent types
export type {
  AgentInput,
  AgentOutput,
  AgentAction,
  ResolutionSignal,
  AgentContext,
  AgentDecisionRecord,
  BatchedMessage,
} from "../../types/agent";
