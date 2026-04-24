import { Hono } from "hono";
import type { AppEnv, Env } from "./types/env";
import { webhook } from "./routes/webhook";
import { health } from "./routes/health";
import { processTimers } from "./pipeline/timer";
import { archiveOldMessages } from "./lib/archiver";
import { logger } from "./lib/logger";

const app = new Hono<AppEnv>();

// Security: Block all requests to undefined routes before they reach handlers
// This ensures any non-matching route returns 404 immediately
app.use("/*", async (c, next) => {
  const path = c.req.path;
  const method = c.req.method;

  // Define explicitly allowed routes
  const allowedRoutes = [
    { path: "/webhook/telegram", methods: ["POST"] },
    { path: "/health", methods: ["GET"] },
    { path: "/", methods: ["GET"] }, // Health check at root if needed
  ];

  // Check if this is an explicitly defined route
  const isAllowed = allowedRoutes.some(
    (route) => route.path === path && route.methods.includes(method)
  );

  if (!isAllowed) {
    logger.warn("Blocked request to undefined route", {
      path,
      method,
      sourceIp: c.req.header("cf-connecting-ip") || "unknown",
      userAgent: c.req.header("user-agent")?.slice(0, 100) || "none",
    });

    // Return 404 without any body details that could aid reconnaissance
    return c.json({ error: "Not found" }, 404, {
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
  }

  // Add security headers to all responses
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");

  await next();
});

app.route("/webhook", webhook);
app.route("/", health);

app.onError((err, c) => {
  logger.error("Unhandled error", {
    error: err instanceof Error ? err.message : String(err),
    path: c.req.path,
    method: c.req.method,
  });
  return c.json({ error: "Internal server error" }, 500);
});

// Final catch-all for any routes that slip through
app.notFound((c) => {
  logger.warn("Route not found (final catch)", {
    path: c.req.path,
    method: c.req.method,
  });
  return c.json({ error: "Not found" }, 404);
});

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
