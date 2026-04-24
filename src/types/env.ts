export interface Env {
  DB: D1Database;
  AI: Ai;
  ARCHIVE: R2Bucket;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  SLACK_WEBHOOK_URL: string;
  LINEAR_API_KEY: string;
  NVIDIA_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

export type AppEnv = {
  Bindings: Env;
};
