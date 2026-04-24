/** Classification labels for message triage. */
export type ClassificationLabel = "bug" | "request" | "normal" | "unknown";

/** Method used to produce the classification. */
export type ClassificationMethod = "rule" | "model";

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
