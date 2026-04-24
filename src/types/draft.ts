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
}

export type DraftStatus = "pending" | "sent" | "escalated" | "discarded";

/** Result of the response policy evaluation. */
export interface PolicyDecision {
  action: ResponseAction;
  reason: string;
}
