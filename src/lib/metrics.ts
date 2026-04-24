import { logger } from "./logger";

export function trackPipelineMetrics(event: {
  chatId: number;
  stage: string;
  durationMs: number;
  success: boolean;
}): void {
  logger.info("pipeline_metric", {
    chatId: event.chatId,
    stage: event.stage,
    durationMs: event.durationMs,
    success: event.success,
  });
}

export function trackModelUsage(event: {
  task: string;
  provider: string;
  model: string;
  durationMs: number;
}): void {
  logger.info("model_usage", {
    task: event.task,
    provider: event.provider,
    model: event.model,
    durationMs: event.durationMs,
  });
}
