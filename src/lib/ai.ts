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
const TASK_MODELS: Record<AITask, ModelConfig> = {
  classify: {
    provider: "workers-ai",
    model: "@cf/meta/llama-3.1-8b-instruct",
  },
  draft: {
    provider: "workers-ai",
    model: "@cf/meta/llama-3.1-8b-instruct",
  },
  summarize: {
    provider: "workers-ai",
    model: "@cf/meta/llama-3.1-8b-instruct",
  },
};

/**
 * Get the language model for a specific AI task.
 * Routes to the configured provider and model.
 */
export function getModel(env: Env, task: AITask): LanguageModel {
  const config = TASK_MODELS[task];
  logger.debug("AI model selected", {
    task,
    provider: config.provider,
    model: config.model,
    baseURL: config.baseURL ?? "default",
  });
  return resolveModel(env, config);
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
      return openai(model);
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
 * Get the current task model configuration.
 * Useful for debugging and monitoring.
 */
export function getTaskModels(): Record<AITask, ModelConfig> {
  return { ...TASK_MODELS };
}

/**
 * Update task model configuration at runtime.
 * Use with caution - changes are not persisted.
 */
export function setTaskModel(task: AITask, config: ModelConfig): void {
  TASK_MODELS[task] = config;
  logger.info("Task model updated", { task, config });
}
