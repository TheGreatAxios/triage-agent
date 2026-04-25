import type { Env } from "../types/env";
import type { ResponseAction, PolicyDecision } from "../types/draft";
import type { ClassificationResult, ClassificationLabel } from "../types/classification";

export interface AppConfig {
  /** Seconds to wait before triggering a draft when no human responds */
  noResponseDelaySeconds: number;
  /** Confidence threshold below which we escalate to Slack */
  escalationThreshold: number;
  /** Confidence threshold above which we auto-send */
  autoSendThreshold: number;
  /** Max messages to keep in hot state per chat */
  maxHotMessages: number;
  /** Max summary age in minutes before refresh */
  summaryMaxAgeMinutes: number;
  /** Classification labels that are safe for auto-send when above autoSendThreshold */
  autoSendLabels: ClassificationLabel[];
  /** Confidence reduction per broken link found in draft */
  linkValidationPenalty: number;
  /** Timeout in ms for link validation checks */
  linkValidationTimeout: number;
  /** Milliseconds before agent execution times out (60s default) */
  agentTimeoutMs: number;
  /** Seconds to debounce messages before triggering agent (20s default) */
  agentDebounceSeconds: number;
  /** Max solution attempts before forcing human escalation (3 default) */
  agentMaxSolutionAttempts: number;
}

export const defaultConfig: AppConfig = {
  noResponseDelaySeconds: 60,
  escalationThreshold: 0.4,
  autoSendThreshold: 0.85,
  maxHotMessages: 200,
  summaryMaxAgeMinutes: 30,
  autoSendLabels: ["normal"],
  linkValidationPenalty: 0.1,
  linkValidationTimeout: 5000,
  agentTimeoutMs: 60000,
  agentDebounceSeconds: 20,
  agentMaxSolutionAttempts: 3,
};

export function getConfig(): AppConfig {
  return { ...defaultConfig };
}

/**
 * Determine the response action based on classification confidence and label.
 *
 * - Escalate: label is "bug" or "request" (UNLESS dual confidence is high)
 *             OR confidence < escalationThreshold
 *             OR label is "unknown"
 * - Auto-send: confidence >= autoSendThreshold AND label is in autoSendLabels
 *              OR (bug/request with classification > 0.8 AND response > 0.875)
 * - Draft-only: everything else
 */
export function evaluateResponsePolicy(
  classification: ClassificationResult,
  draftConfidence?: number
): PolicyDecision {
  const config = getConfig();
  const { confidence, label } = classification;

  // BUG/REQUEST: Can auto-send if BOTH confidences are high (dual-confidence)
  if (label === "bug" || label === "request") {
    if (confidence > 0.8 && draftConfidence && draftConfidence > 0.875) {
      return {
        action: "auto_send",
        reason: `High classification confidence (${confidence.toFixed(2)}) + high response quality (${draftConfidence.toFixed(2)})`,
      };
    }
    return {
      action: "escalate",
      reason: `${label} requires review (classification: ${confidence.toFixed(2)}, response: ${draftConfidence?.toFixed(2) || 'N/A'})`,
    };
  }

  if (label === "unknown" || confidence < config.escalationThreshold) {
    return {
      action: "escalate",
      reason:
        label === "unknown"
          ? "Classification label is unknown"
          : `Confidence ${confidence.toFixed(2)} below escalation threshold ${config.escalationThreshold}`,
    };
  }

  if (
    confidence >= config.autoSendThreshold &&
    config.autoSendLabels.includes(label)
  ) {
    return {
      action: "auto_send",
      reason: `Confidence ${confidence.toFixed(2)} above auto-send threshold for label "${label}"`,
    };
  }

  return {
    action: "draft_only",
    reason: `Confidence ${confidence.toFixed(2)} between thresholds; label "${label}" requires review`,
  };
}
