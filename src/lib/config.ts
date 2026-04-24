import type { Env } from "../types/env";
import type { ResponseAction } from "../types/draft";
import type { ClassificationLabel } from "../types/classification";

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
}

export const defaultConfig: AppConfig = {
  noResponseDelaySeconds: 60,
  escalationThreshold: 0.4,
  autoSendThreshold: 0.85,
  maxHotMessages: 200,
  summaryMaxAgeMinutes: 30,
  autoSendLabels: ["normal"],
};

export function getConfig(): AppConfig {
  return { ...defaultConfig };
}

/**
 * Determine the response action based on classification confidence and label.
 *
 * - Escalate: label is "bug" or "request" (always relevant, notify Slack)
 *             OR confidence < escalationThreshold
 *             OR label is "unknown"
 * - Auto-send: confidence >= autoSendThreshold AND label is in autoSendLabels
 * - Draft-only: everything else
 */
export function evaluateResponsePolicy(
  confidence: number,
  label: ClassificationLabel
): { action: ResponseAction; reason: string } {
  const config = getConfig();

  // Always escalate bugs and requests to Slack (relevant items need visibility)
  if (label === "bug" || label === "request") {
    return {
      action: "escalate",
      reason: `Relevant classification "${label}" requires Slack notification`,
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
