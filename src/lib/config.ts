import type { ClassificationLabel } from "../types/classification";

export interface AppConfig {
  /** Seconds to wait before triggering a draft when no human responds */
  noResponseDelaySeconds: number;
  /** Max messages to keep in hot state per chat */
  maxHotMessages: number;
  /** Max summary age in minutes before refresh */
  summaryMaxAgeMinutes: number;
  /** Milliseconds before agent execution times out (60s default) */
  agentTimeoutMs: number;
  /** Seconds to debounce messages before triggering agent (20s default) */
  agentDebounceSeconds: number;
  /** Max solution attempts before forcing human escalation (3 default) */
  agentMaxSolutionAttempts: number;
}

export const defaultConfig: AppConfig = {
  noResponseDelaySeconds: 60,
  maxHotMessages: 200,
  summaryMaxAgeMinutes: 30,
  agentTimeoutMs: 60000,
  agentDebounceSeconds: 20,
  agentMaxSolutionAttempts: 3,
};

export function getConfig(): AppConfig {
  return { ...defaultConfig };
}
