import { Hono } from "hono";
import type { AppEnv } from "../types/env";

export const health = new Hono<AppEnv>();

health.get("/health", (c) => {
  return c.json({ status: "ok", service: "telegram-triage-agent" });
});
