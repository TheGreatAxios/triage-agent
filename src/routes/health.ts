import { Hono } from "hono";
import type { AppEnv } from "../types/env";
import { getModel, getTaskTiers } from "../lib/ai";
import { generateText } from "ai";

export const health = new Hono<AppEnv>();

health.get("/health", (c) => {
  return c.json({ status: "ok", service: "telegram-triage-agent" });
});

/**
 * AI health check - tests if Workers AI binding and models are accessible
 */
health.get("/health/ai", async (c) => {
  const env = c.env;
  const results: Record<string, { status: string; error?: string; response?: string }> = {};

  for (const task of ["triage", "classify", "draft"] as const) {
    try {
      const model = getModel(env, task);
      const { text } = await generateText({
        model,
        prompt: "Say 'ok' and nothing else.",
        maxOutputTokens: 10,
      });
      results[task] = { status: "ok", response: text.slice(0, 50) };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results[task] = { status: "error", error };
    }
  }

  const allOk = Object.values(results).every((r) => r.status === "ok");
  return c.json(
    {
      status: allOk ? "ok" : "degraded",
      ai: results,
      tiers: {
        triage: getTaskTiers("triage").map((t) => ({ provider: t.provider, model: t.model })),
        classify: getTaskTiers("classify").map((t) => ({ provider: t.provider, model: t.model })),
        draft: getTaskTiers("draft").map((t) => ({ provider: t.provider, model: t.model })),
      },
    },
    allOk ? 200 : 503
  );
});
