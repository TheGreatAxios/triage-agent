export interface Env {
  // Cloudflare Bindings
  DB: D1Database;
  AI: Ai;
  ARCHIVE: R2Bucket;

  // Telegram
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;

  // Escalation & Issue Tracking
  SLACK_WEBHOOK_URL: string;
  LINEAR_API_KEY: string;
  LINEAR_TEAM_ID: string;
  LINEAR_PROJECT_ID?: string;
  LINEAR_TRIAGE_STATE_ID: string;
  LINEAR_LABEL_BUG?: string;
  LINEAR_LABEL_REQUEST?: string;

  // Slack Approval Flow (3 channels)
  SLACK_APPROVAL_WEBHOOK_URL: string;  // Approval requests channel
  SLACK_SUMMARY_WEBHOOK_URL: string;   // Daily summaries channel
  SLACK_SIGNING_SECRET: string;         // Verify Slack interactions
  SLACK_BOT_TOKEN: string;              // Post messages, open modals

  // Bot Configuration
  NOTIFY_ON_APPROVAL?: string;          // "true" to send activation message (default: silent)

  // AI Providers (all optional - only set what you use)
  // Official SDK Providers
  ANTHROPIC_API_KEY?: string;      // Claude models
  GOOGLE_API_KEY?: string;          // Gemini models
  GROQ_API_KEY?: string;             // Groq fast inference
  OPENAI_API_KEY?: string;          // GPT models
  XAI_API_KEY?: string;             // Grok models

  // OpenAI-Compatible Providers
  DEEPINFRA_API_KEY?: string;       // DeepInfra inference
  FIREWORKS_API_KEY?: string;       // Fireworks AI
  HUGGINGFACE_API_KEY?: string;     // HF Inference API
  MINIMAX_API_KEY?: string;         // MiniMax models
  NVIDIA_API_KEY?: string;          // NVIDIA NIM
  OPENROUTER_API_KEY?: string;      // OpenRouter (multi-model access)
  ZAI_API_KEY?: string;             // Zhipu AI (ZAI)

  // Custom/Self-hosted (optional)
  // Use apiKeyEnv in ModelConfig to reference custom env vars
  // Example: OLLAMA_API_KEY, LOCALAI_API_KEY, etc.
}

export type AppEnv = {
  Bindings: Env;
};
