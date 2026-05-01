/** Classification labels for message triage. */
export type ClassificationLabel = "bug" | "request" | "normal" | "unknown";

/** Method used to produce the classification. */
export type ClassificationMethod = "rule" | "model" | "fallback";

/** Structured output from the classification pipeline. */
export interface ClassificationResult {
  /** The assigned label */
  label: ClassificationLabel;
  /** Confidence score 0–1 */
  confidence: number;
  /** Whether rules or model produced this result */
  method: ClassificationMethod;
  /** Human-readable reasoning for the classification */
  reasoning: string;
}

/** Action the triage agent decided to take. */
export type TriageAction = "auto_send" | "escalate" | "draft_only" | "defer";

/** Single-call triage result: classify + draft + action decision. */
export interface TriageResult {
  label: ClassificationLabel;
  confidence: number;
  method: ClassificationMethod;
  reasoning: string;
  action: TriageAction;
  /** Draft response text — null when action is "defer" */
  draft: string | null;
  /** AI self-assessment of draft quality (0–1) — null when no draft */
  draftConfidence: number | null;
}
