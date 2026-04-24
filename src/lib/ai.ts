import type { LanguageModel } from "ai";
import type { Env } from "../types/env";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export type AIProvider = "workers-ai" | "nvidia" | "openai" | "openrouter";

export type AITask = "classify" | "draft" | "summarize";

interface ModelConfig {
  provider: AIProvider;
  model: string;
}

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

export function getModel(env: Env, task: AITask): LanguageModel {
  const config = TASK_MODELS[task];
  return resolveModel(env, config.provider, config.model);
}

export function resolveModel(
  env: Env,
  provider: AIProvider,
  model: string
): LanguageModel {
  switch (provider) {
    case "workers-ai": {
      const workersai = createWorkersAI({ binding: env.AI });
      return workersai(model);
    }
    case "nvidia": {
      const nim = createOpenAICompatible({
        name: "nvidia-nim",
        baseURL: "https://integrate.api.nvidia.com/v1",
        headers: { Authorization: `Bearer ${env.NVIDIA_API_KEY}` },
      });
      return nim.chatModel(model);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
      return openai(model);
    }
    case "openrouter": {
      const openrouter = createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
      });
      return openrouter.chatModel(model);
    }
  }
}
