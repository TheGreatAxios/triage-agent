import type { ClassificationLabel } from "../types/classification";

export interface AppConfig {
  /** Seconds to wait before triggering a draft when no human responds */
  noResponseDelaySeconds: number;
  /** Max messages to keep in hot state per chat */
  maxHotMessages: number;
  /** Max summary age in minutes before refresh */
  summaryMaxAgeMinutes: number;
}

export const defaultConfig: AppConfig = {
  noResponseDelaySeconds: 60,
  maxHotMessages: 200,
  summaryMaxAgeMinutes: 30,
};

export function getConfig(): AppConfig {
  return { ...defaultConfig };
}
