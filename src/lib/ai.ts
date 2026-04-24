import type { LanguageModel } from "ai";
import type { Env } from "../types/env";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { logger } from "./logger";

export type AIProvider =
  | "workers-ai"
  | "openai"
  | "anthropic"
  | "google"
  | "groq"
  | "openrouter"
  | "nvidia"
  | "custom"
  | "deepinfra"
  | "minimax"
  | "zai"
  | "fireworks"
  | "huggingface"
  | "xai";

export type AITask = "classify" | "draft" | "summarize";

export interface ModelConfig {
  provider: AIProvider;
  model: string;
  /** Override the default base URL for the provider */
  baseURL?: string;
  /** Custom environment variable name for API key (defaults to provider standard) */
  apiKeyEnv?: string;
}

/**
 * Task-to-model routing configuration.
 *
 * Each AI task can use a different provider and model.
 * Mix and match for cost/performance optimization.
 *
 * Examples:
 * - classify: { provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" }
 * - draft: { provider: "nvidia", model: "meta/llama-3.3-70b-instruct" }
 * - summarize: { provider: "openai", model: "gpt-4o-mini" }
 *
 * Self-hosted example:
 * - classify: { provider: "custom", model: "llama3.1:8b", baseURL: "http://localhost:11434/v1" }
 */
/**
 * Multi-tier fallback strategy optimized for free tier:
 *
 * TIER 1 (Primary):
 * - classify: IBM Granite 4.0 (cheapest CF model: 1,542 neurons/M input)
 * - draft:    NVIDIA step-3.5-flash (40 req/min limit)
 * - summarize: OpenRouter gemma-4-26b-a4b-it:free
 *
 * TIER 2 (Fallback - if primary fails/quota exceeded):
 * - All tasks: OpenRouter free models (google/gemma-3-27b-it:free)
 *
 * TIER 3 (Emergency - if all else fails):
 * - All tasks: OpenAI gpt-5.4-nano (flex tier, reasoning=none)
 */
const TASK_MODELS: Record<AITask, [ModelConfig, ModelConfig, ModelConfig]> = {
  classify: [
    // Tier 1: IBM Granite 4.0 - cheapest CF Workers model (1,542 neurons/M input)
    { provider: "workers-ai", model: "@cf/ibm-granite/granite-4.0-h-micro" },
    // Tier 2: OpenRouter free model
    { provider: "openrouter", model: "google/gemma-3-27b-it:free" },
    // Tier 3: OpenAI gpt-5.4-nano with flex tier, reasoningEffort=none
    { provider: "openai", model: "gpt-5.4-nano" },
  ],
  draft: [
    // Tier 1: NVIDIA step-3.5-flash (40 req/min limit)
    { provider: "nvidia", model: "stepfun-ai/step-3.5-flash" },
    // Tier 2: OpenRouter free model
    { provider: "openrouter", model: "google/gemma-3-27b-it:free" },
    // Tier 3: OpenAI gpt-5.4-nano with flex tier, reasoningEffort=none
    { provider: "openai", model: "gpt-5.4-nano" },
  ],
  summarize: [
    // Tier 1: OpenRouter gemma-4-26b-a4b-it:free
    { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" },
    // Tier 2: OpenRouter fallback free model
    { provider: "openrouter", model: "google/gemma-3-27b-it:free" },
    // Tier 3: OpenAI gpt-5.4-nano with flex tier, reasoningEffort=none
    { provider: "openai", model: "gpt-5.4-nano" },
  ],
};

/**
 * Get the language model for a specific AI task.
 * Tries tier 1, falls back to tier 2, then tier 3 if needed.
 */
export function getModel(env: Env, task: AITask): LanguageModel {
  const configs = TASK_MODELS[task];

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const tier = i + 1;

    try {
      // Check if API key exists for non-Workers-AI providers
      if (config.provider !== "workers-ai" && config.provider !== "custom") {
        const keyName = getProviderApiKeyName(config.provider);
        if (!env[keyName as keyof Env]) {
          logger.debug(`Tier ${tier} skipped - no API key`, { task, provider: config.provider });
          continue;
        }
      }

      logger.debug("AI model selected", {
        task,
        tier,
        provider: config.provider,
        model: config.model,
      });

      return resolveModel(env, config);
    } catch (err) {
      logger.warn(`Tier ${tier} failed, trying next`, {
        task,
        provider: config.provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new Error(`No available model for task: ${task}`);
}

function getProviderApiKeyName(provider: AIProvider): string {
  const keyMap: Record<string, string> = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_API_KEY",
    "groq": "GROQ_API_KEY",
    "xai": "XAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "nvidia": "NVIDIA_API_KEY",
    "deepinfra": "DEEPINFRA_API_KEY",
    "minimax": "MINIMAX_API_KEY",
    "zai": "ZAI_API_KEY",
    "fireworks": "FIREWORKS_API_KEY",
    "huggingface": "HUGGINGFACE_API_KEY",
  };
  return keyMap[provider] || `${provider.toUpperCase()}_API_KEY`;
}

/**
 * Resolve a model configuration to a LanguageModel instance.
 * Supports official SDKs for major providers and OpenAI-compatible mode for others.
 */
export function resolveModel(env: Env, config: ModelConfig): LanguageModel {
  const { provider, model, baseURL, apiKeyEnv } = config;

  // Helper to get API key from custom env var or default
  const getApiKey = (defaultEnv: keyof Env): string => {
    const keyName = apiKeyEnv ?? defaultEnv;
    const value = env[keyName as keyof Env];
    if (!value && provider !== "workers-ai" && provider !== "custom") {
      throw new Error(`Missing API key: ${keyName}`);
    }
    return value as string;
  };

  switch (provider) {
    case "workers-ai": {
      const workersai = createWorkersAI({ binding: env.AI });
      return workersai(model);
    }

    case "openai": {
      const openai = createOpenAI({
        apiKey: getApiKey("OPENAI_API_KEY"),
        baseURL,
      });
      // For gpt-5.4-nano: reasoningEffort=none, serviceTier=flex for minimum cost
      // Note: reasoningEffort and serviceTier are passed via providerOptions in generateText
      return openai.responses(model);
    }

    case "anthropic": {
      const anthropic = createAnthropic({
        apiKey: getApiKey("ANTHROPIC_API_KEY"),
        baseURL,
      });
      return anthropic(model) as unknown as LanguageModel;
    }

    case "google": {
      const google = createGoogleGenerativeAI({
        apiKey: getApiKey("GOOGLE_API_KEY"),
        baseURL,
      });
      return google(model) as unknown as LanguageModel;
    }

    case "groq": {
      const groq = createGroq({
        apiKey: getApiKey("GROQ_API_KEY"),
        baseURL,
      });
      return groq(model) as unknown as LanguageModel;
    }

    case "xai": {
      const xai = createXai({
        apiKey: getApiKey("XAI_API_KEY"),
        baseURL,
      });
      return xai(model) as unknown as LanguageModel;
    }

    case "openrouter": {
      const openrouter = createOpenRouter({
        apiKey: getApiKey("OPENROUTER_API_KEY"),
      });
      return openrouter(model) as unknown as LanguageModel;
    }

    case "nvidia": {
      const nim = createOpenAICompatible({
        name: "nvidia-nim",
        baseURL: baseURL ?? "https://integrate.api.nvidia.com/v1",
        headers: {
          Authorization: `Bearer ${getApiKey("NVIDIA_API_KEY")}`,
        },
      });
      return nim.chatModel(model);
    }

    case "deepinfra": {
      const deepinfra = createOpenAICompatible({
        name: "deepinfra",
        baseURL: baseURL ?? "https://api.deepinfra.com/v1/openai",
        headers: {
          Authorization: `Bearer ${getApiKey("DEEPINFRA_API_KEY")}`,
        },
      });
      return deepinfra.chatModel(model);
    }

    case "minimax": {
      const minimax = createOpenAICompatible({
        name: "minimax",
        baseURL: baseURL ?? "https://api.minimax.chat/v1",
        headers: {
          Authorization: `Bearer ${getApiKey("MINIMAX_API_KEY")}`,
        },
      });
      return minimax.chatModel(model);
    }

    case "zai": {
      // Zhipu AI (ZAI) - OpenAI-compatible
      const zai = createOpenAICompatible({
        name: "zai",
        baseURL: baseURL ?? "https://open.bigmodel.cn/api/paas/v4",
        headers: {
          Authorization: `Bearer ${getApiKey("ZAI_API_KEY")}`,
        },
      });
      return zai.chatModel(model);
    }

    case "fireworks": {
      const fireworks = createOpenAICompatible({
        name: "fireworks",
        baseURL: baseURL ?? "https://api.fireworks.ai/inference/v1",
        headers: {
          Authorization: `Bearer ${getApiKey("FIREWORKS_API_KEY")}`,
        },
      });
      return fireworks.chatModel(model);
    }

    case "huggingface": {
      // Hugging Face Inference API - OpenAI-compatible
      const huggingface = createOpenAICompatible({
        name: "huggingface",
        baseURL: baseURL ?? "https://api-inference.huggingface.co/v1",
        headers: {
          Authorization: `Bearer ${getApiKey("HUGGINGFACE_API_KEY")}`,
        },
      });
      return huggingface.chatModel(model);
    }

    case "custom": {
      // Generic OpenAI-compatible endpoint (Ollama, LocalAI, etc.)
      if (!baseURL) {
        throw new Error("Custom provider requires baseURL");
      }
      const customKey = apiKeyEnv ? getApiKey(apiKeyEnv as keyof Env) : "";
      const custom = createOpenAICompatible({
        name: "custom",
        baseURL,
        headers: customKey
          ? { Authorization: `Bearer ${customKey}` }
          : undefined,
      });
      return custom.chatModel(model);
    }

    default: {
      // Exhaustiveness check: TypeScript will error if we add a provider without handling it
      const _exhaustiveCheck: never = provider;
      throw new Error(`Unsupported AI provider: ${String(_exhaustiveCheck)}`);
    }
  }
}

/**
 * Get the current task model configuration (primary/tier 1).
 * Useful for debugging and monitoring.
 */
export function getTaskModels(): Record<AITask, ModelConfig> {
  return {
    classify: TASK_MODELS.classify[0],
    draft: TASK_MODELS.draft[0],
    summarize: TASK_MODELS.summarize[0],
  };
}

/**
 * Get full tiered configuration for a task.
 */
export function getTaskTiers(task: AITask): ModelConfig[] {
  return [...TASK_MODELS[task]];
}

/**
 * Update task model configuration at runtime.
 * Use with caution - changes are not persisted.
 * This updates only tier 1 (primary).
 */
export function setTaskModel(task: AITask, config: ModelConfig): void {
  TASK_MODELS[task][0] = config;
  logger.info("Task model updated", { task, config });
}
