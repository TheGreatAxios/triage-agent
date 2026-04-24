/** Response policy decision based on classification confidence. */
export type ResponseAction = "auto_send" | "draft_only" | "escalate";

/** A generated draft response ready for policy evaluation. */
export interface Draft {
  /** Internal DB chat ID */
  chatId: number;
  /** The generated response content */
  content: string;
  /** Confidence in the draft quality (0–1) */
  confidence: number;
  /** Current status in the draft lifecycle */
  status: DraftStatus;
  /** AI self-assessment of response quality (0–1) */
  responseConfidence?: number;
  /** Array of tool names that were invoked */
  toolsUsed?: string[];
  /** Summarized tool results */
  toolResults?: Array<{ tool: string; summary: string }>;
}

export type DraftStatus = "pending" | "sent" | "escalated" | "discarded";

/** Result of the response policy evaluation. */
export interface PolicyDecision {
  action: ResponseAction;
  reason: string;
  /** Classification confidence used in the decision (dual-confidence system) */
  classificationConfidence?: number;
  /** Draft/response confidence used in the decision (dual-confidence system) */
  responseConfidence?: number;
}
