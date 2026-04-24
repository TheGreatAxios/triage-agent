import { Hono } from "hono";
import type { AppEnv, Env } from "./types/env";
import { webhook } from "./routes/webhook";
import { health } from "./routes/health";
import { processTimers } from "./pipeline/timer";
import { archiveOldMessages } from "./lib/archiver";
import { logger } from "./lib/logger";

const app = new Hono<AppEnv>();

app.route("/webhook", webhook);
app.route("/", health);

app.onError((err, c) => {
  console.error("Unhandled error:", err.message);
  return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      processTimers(env).then((count) => {
        if (count > 0) {
          logger.info("Scheduled timer run complete", { processed: count });
        }
      }).catch((err) => {
        logger.error("Scheduled timer run failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
    );

    ctx.waitUntil(
      archiveOldMessages(env).then((count) => {
        if (count > 0) {
          logger.info("Archival run complete", { archived: count });
        }
      }).catch((err) => {
        logger.error("Archival run failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
    );
  },
};
