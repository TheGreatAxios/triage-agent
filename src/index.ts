import { Hono } from "hono";
import type { AppEnv, Env } from "./types/env";
import { webhook } from "./routes/webhook";
import { health } from "./routes/health";
import slackRoutes from "./routes/slack";
import { processTimers, checkApprovalExpirations, sendDailySummaryIfScheduled } from "./pipeline/timer";
import { archiveOldMessages } from "./lib/archiver";
import { reconcileCounters, cleanupOldReconciliationLogs } from "./lib/counters/reconciliation";
import { runDailyRollup } from "./lib/counters/rollup";
import { processTriageMessage } from "./pipeline/triage";
import { logger } from "./lib/logger";
import { getErrorMessage } from "./lib/errors";
import type { TriageQueueMessage } from "./types/queue";

const app = new Hono<AppEnv>();

// Security: Block all requests to undefined routes before they reach handlers
// This ensures any non-matching route returns 404 immediately
app.use("/*", async (c, next) => {
  const path = c.req.path;
  const method = c.req.method;

  // Define explicitly allowed routes
  const allowedRoutes = [
    { path: "/webhook/telegram", methods: ["POST"] },
    { path: "/webhook/slack/interactions", methods: ["POST"] },
    { path: "/webhook/slack/commands", methods: ["POST"] },
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
app.route("/webhook/slack", slackRoutes);
app.route("/", health);

app.onError((err, c) => {
  logger.error("Unhandled error", {
    error: getErrorMessage(err),
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
  async queue(batch: MessageBatch<TriageQueueMessage>, env: Env, ctx: ExecutionContext) {
    for (const message of batch.messages) {
      ctx.waitUntil(
        processTriageMessage(env, message.body).then(() => {
          message.ack();
        }).catch((err) => {
          logger.error("Queue triage failed — will retry", {
            messageId: message.id,
            dbChatId: message.body.dbChatId,
            error: getErrorMessage(err),
          });
          message.retry({ delaySeconds: 5 });
        })
      );
    }
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      processTimers(env).then((count) => {
        if (count > 0) {
          logger.info("Scheduled timer run complete", { processed: count });
        }
      }).catch((err) => {
        logger.error("Scheduled timer run failed", {
          error: getErrorMessage(err),
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
          error: getErrorMessage(err),
        });
      })
    );

    // Check for expired pending approvals (72 hour timeout)
    ctx.waitUntil(
      checkApprovalExpirations(env).then((count) => {
        if (count > 0) {
          logger.info("Approval expiration check complete", { expired: count });
        }
      }).catch((err) => {
        logger.error("Approval expiration check failed", {
          error: getErrorMessage(err),
        });
      })
    );

    // Determine which daily summary to send based on cron schedule
    // 8 AM PST = 16:00 UTC (morning summary)
    // 4 PM PST = 00:00 UTC next day (evening summary)
    const hour = new Date().getUTCHours();
    const period: "morning" | "evening" | null = hour === 16 ? "morning" : hour === 0 ? "evening" : null;

    if (period) {
      ctx.waitUntil(
        sendDailySummaryIfScheduled(env, period).catch((err) => {
          logger.error("Daily summary failed", {
            period,
            error: getErrorMessage(err),
          });
        })
      );
    }

    // Daily stats rollup (runs at 00:00 UTC - midnight)
    // Aggregates yesterday's stats into monthly totals and cleans up old data
    const isMidnight = hour === 0;
    if (isMidnight) {
      ctx.waitUntil(
        runDailyRollup(env).then((result) => {
          logger.info("Daily stats rollup complete", result);
        }).catch((err) => {
          logger.error("Daily stats rollup failed", {
            error: getErrorMessage(err),
          });
        })
      );
    }

    // Weekly counter reconciliation (runs Sunday at 03:00 UTC)
    // Verifies counters are accurate and fixes any drift
    const dayOfWeek = new Date().getUTCDay();
    const isSunday3AM = dayOfWeek === 0 && hour === 3;
    if (isSunday3AM) {
      ctx.waitUntil(
        reconcileCounters(env).then((result) => {
          logger.info("Counter reconciliation complete", result);
        }).then(() => {
          // Clean up old logs after reconciliation
          return cleanupOldReconciliationLogs(env);
        }).catch((err) => {
          logger.error("Counter reconciliation failed", {
            error: getErrorMessage(err),
          });
        })
      );
    }
  },
};
