/** Slack webhook handlers for interactive components and slash commands. */

import { Hono } from "hono";
import type { AppEnv } from "../types/env";
import type { ApprovalSlackPayload } from "../types/approval";
import { logger } from "../lib/logger";
import { getErrorMessage } from "../lib/errors";
import { verifySlackRequestAsync } from "../lib/slack";
import {
  approveChat,
  rejectChat,
  unblacklistChat,
  batchProcessApprovals,
} from "../lib/approval";
import {
  openBatchApprovalModal,
  openBatchRejectModal,
  postSlackMessage,
} from "../lib/slack";
import {
  buildBlacklistBlocks,
  buildPendingListBlocks,
} from "../lib/slack-blocks";
import {
  getPendingApprovals,
  getBlacklistedChats,
  getPendingApprovalsByFilter,
} from "../lib/persistence";

export const slackRoutes = new Hono<AppEnv>();

/**
 * Parse Slack slash command payload.
 */
function parseSlashCommand(body: string): { command: string; text: string; user_id: string; user_name: string; trigger_id: string; response_url: string } {
  const params = new URLSearchParams(body);
  return {
    command: params.get("command") || "",
    text: params.get("text") || "",
    user_id: params.get("user_id") || "",
    user_name: params.get("user_name") || "",
    trigger_id: params.get("trigger_id") || "",
    response_url: params.get("response_url") || "",
  };
}

/**
 * POST /webhook/slack/interactions
 * Handle Slack interactive components (button clicks, modal submissions).
 */
slackRoutes.post("/interactions", async (c) => {
  const signingSecret = c.env.SLACK_SIGNING_SECRET;
  const timestamp = c.req.header("X-Slack-Request-Timestamp") || "";
  const signature = c.req.header("X-Slack-Signature") || "";

  // Read raw body for verification
  const rawBody = await c.req.text();

  // Verify Slack signature
  const isValid = await verifySlackRequestAsync(signingSecret, timestamp, rawBody, signature);
  if (!isValid) {
    logger.warn("Invalid Slack signature");
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Parse payload (url-encoded)
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  if (!payloadStr) {
    return c.json({ error: "Missing payload" }, 400);
  }

  let payload: ApprovalSlackPayload;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return c.json({ error: "Invalid payload" }, 400);
  }

  // Handle block actions (button clicks)
  if (payload.type === "block_actions" && payload.actions) {
    const action = payload.actions[0];
    if (!action) {
      return c.json({ ok: true });
    }

    const chatId = parseInt(action.value, 10);
    if (isNaN(chatId)) {
      return c.json({ error: "Invalid chat ID" }, 400);
    }

    const decision = {
      chatId,
      slackUserId: payload.user.id,
      slackUserName: payload.user.name || payload.user.username,
      action: action.action_id === "approve_chat" ? "approve" as const :
              action.action_id === "reject_chat" ? "reject" as const :
              action.action_id === "unblacklist_chat" ? "unblacklist" as const :
              "approve" as const,
    };

    // Handle special actions
    if (action.action_id === "open_batch_modal") {
      logger.info("Opening batch modal", { triggerId: payload.trigger_id, user: payload.user });
      const pending = await getPendingApprovals(c.env.DB, "pending");
      logger.info("Found pending approvals", { count: pending.length });

      if (pending.length === 0) {
        return c.json({
          response_type: "ephemeral",
          text: "No pending approvals to batch process.",
        });
      }

      const opened = await openBatchApprovalModal(
        c.env.SLACK_BOT_TOKEN,
        payload.trigger_id || "",
        pending.map((p) => ({
          id: p.id,
          chatId: p.chatId,
          chatTitle: p.chatTitle,
          chatType: p.chatType,
          memberCount: p.memberCount,
          requestedByName: p.requestedBy.name,
          complexityScore: p.complexityScore,
        }))
      );

      logger.info("Batch modal open result", { opened });

      // Return empty 200 OK - modal opened via views.open API
      return c.body(null, 200);
    }

    if (action.action_id === "refresh_pending") {
      // Acknowledge and re-send the list
      const pending = await getPendingApprovals(c.env.DB, "pending");
      const botMeta = await getBotMetadataFromDbOrDefault(c.env);
      const hoursPending = (p: { createdAt: string }) =>
        (Date.now() - new Date(p.createdAt).getTime()) / (1000 * 60 * 60);

      await postSlackMessage(
        c.env.SLACK_BOT_TOKEN,
        payload.user.id, // DM the user
        "Pending approvals:",
        buildPendingListBlocks(
          pending.map((p) => ({
            chatId: p.chatId,
            chatTitle: p.chatTitle,
            chatType: p.chatType,
            memberCount: p.memberCount,
            complexityScore: p.complexityScore,
            requestedByName: p.requestedBy.name,
            hoursPending: hoursPending(p),
          })),
          "all",
          botMeta.username
        )
      );
      return c.json({ ok: true });
    }

    // Handle approval/rejection/unblacklist
    let result: { success: boolean; message: string };

    if (action.action_id === "approve_chat") {
      result = await approveChat(c.env, decision);
    } else if (action.action_id === "reject_chat") {
      result = await rejectChat(c.env, decision);
    } else if (action.action_id === "unblacklist_chat") {
      result = await unblacklistChat(c.env, decision);
    } else {
      return c.json({ error: "Unknown action" }, 400);
    }

    // Return ephemeral message to user
    return c.json({
      response_type: "ephemeral",
      text: result.success ? `✓ ${result.message}` : `✗ ${result.message}`,
    });
  }

  // Handle modal submissions (batch operations)
  if (payload.type === "view_submission" && payload.view) {
    const callbackId = payload.view.callback_id;
    const stateValues = payload.view.state.values;

    logger.info("Modal submission received", { callbackId, user: payload.user, stateValueKeys: Object.keys(stateValues) });

    // Extract selected chat IDs
    const selectedChats: number[] = [];
    for (const blockId of Object.keys(stateValues)) {
      const block = stateValues[blockId];
      for (const actionId of Object.keys(block)) {
        const action = block[actionId];
        logger.debug("Processing block action", { blockId, actionId, actionType: action.type, hasSelectedOptions: !!action.selected_options });
        if (action.selected_options) {
          logger.debug("Found selected options", { count: action.selected_options.length, options: action.selected_options });
          for (const opt of action.selected_options) {
            const chatId = parseInt(opt.value, 10);
            if (!isNaN(chatId)) {
              selectedChats.push(chatId);
            }
          }
        }
      }
    }

    logger.info("Extracted chat IDs from modal", { count: selectedChats.length, chatIds: selectedChats });

    if (selectedChats.length === 0) {
      return c.json({
        response_action: "errors",
        errors: {
          selected_chats: "Please select at least one chat",
        },
      });
    }

    // Security: Limit batch size to prevent abuse
    const MAX_BATCH_SIZE = 100;
    if (selectedChats.length > MAX_BATCH_SIZE) {
      return c.json({
        response_action: "errors",
        errors: {
          selected_chats: `Maximum ${MAX_BATCH_SIZE} chats per batch. Please select fewer chats.`,
        },
      });
    }

    const decisions = selectedChats.map((chatId) => ({
      chatId,
      slackUserId: payload.user.id,
      slackUserName: payload.user.name || payload.user.username || "Unknown",
      action: callbackId === "batch_approval_modal" ? "approve" as const : "reject" as const,
    }));

    // Process batch (async, don't block response)
    logger.info("Starting batch process", { decisionCount: decisions.length, action: decisions[0]?.action });
    c.executionCtx.waitUntil(
      batchProcessApprovals(c.env, decisions).then((results) => {
        logger.info("Batch process completed", { results });
      }).catch((err) => {
        logger.error("Batch approval failed", {
          error: getErrorMessage(err),
        });
      })
    );

    // Acknowledge immediately
    return c.json({
      response_action: "clear",
    });
  }

  return c.json({ ok: true });
});

/**
 * POST /webhook/slack/commands
 * Handle Slack slash commands.
 */
slackRoutes.post("/commands", async (c) => {
  const signingSecret = c.env.SLACK_SIGNING_SECRET;
  const timestamp = c.req.header("X-Slack-Request-Timestamp") || "";
  const signature = c.req.header("X-Slack-Signature") || "";

  const rawBody = await c.req.text();

  const isValid = await verifySlackRequestAsync(signingSecret, timestamp, rawBody, signature);
  if (!isValid) {
    logger.warn("Invalid Slack signature on command");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const command = parseSlashCommand(rawBody);
  const { command: cmd, text, user_id, user_name, trigger_id, response_url } = command;

  logger.info("Slack command received", { command: cmd, user: user_name, text });

  // Handle /pending-chats
  if (cmd === "/pending-chats") {
    const filter = text.trim() || "all";
    let pending;

    if (filter === "all") {
      pending = await getPendingApprovals(c.env.DB, "pending");
    } else {
      pending = await getPendingApprovalsByFilter(c.env.DB, filter);
    }

    const botMeta = await getBotMetadataFromDbOrDefault(c.env);
    const hoursPending = (p: { createdAt: string }) =>
      (Date.now() - new Date(p.createdAt).getTime()) / (1000 * 60 * 60);

    const blocks = buildPendingListBlocks(
      pending.map((p) => ({
        chatId: p.chatId,
        chatTitle: p.chatTitle,
        chatType: p.chatType,
        memberCount: p.memberCount,
        complexityScore: p.complexityScore,
        requestedByName: p.requestedBy.name,
        hoursPending: hoursPending(p),
      })),
      filter,
      botMeta.username
    );

    // Send response via response_url for richer formatting
    c.executionCtx.waitUntil(
      fetch(response_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response_type: "ephemeral",
          blocks,
        }),
      }).catch((err) => {
        logger.error("Failed to send pending chats response", {
          error: getErrorMessage(err),
        });
      })
    );

    // Immediate acknowledgment
    return c.json({
      response_type: "ephemeral",
      text: `Loading pending approvals (${filter})...`,
    });
  }

  // Handle /batch-approve
  if (cmd === "/batch-approve") {
    const pending = await getPendingApprovals(c.env.DB, "pending");

    if (pending.length === 0) {
      return c.json({
        response_type: "ephemeral",
        text: "No pending approvals to batch process. 🎉",
      });
    }

    // Open modal
    const opened = await openBatchApprovalModal(
      c.env.SLACK_BOT_TOKEN,
      trigger_id,
      pending.map((p) => ({
        id: p.id,
        chatId: p.chatId,
        chatTitle: p.chatTitle,
        chatType: p.chatType,
        memberCount: p.memberCount,
        requestedByName: p.requestedBy.name,
        complexityScore: p.complexityScore,
      }))
    );

    if (!opened) {
      return c.json({
        response_type: "ephemeral",
        text: "Failed to open batch approval modal. Please try again.",
      });
    }

    // Return empty 200 OK - modal is already opened via views.open API
    return c.body(null, 200);
  }

  // Handle /batch-reject
  if (cmd === "/batch-reject") {
    const pending = await getPendingApprovals(c.env.DB, "pending");

    if (pending.length === 0) {
      return c.json({
        response_type: "ephemeral",
        text: "No pending approvals to reject.",
      });
    }

    const opened = await openBatchRejectModal(
      c.env.SLACK_BOT_TOKEN,
      trigger_id,
      pending.map((p) => ({
        id: p.id,
        chatId: p.chatId,
        chatTitle: p.chatTitle,
        chatType: p.chatType,
        memberCount: p.memberCount,
      }))
    );

    if (!opened) {
      return c.json({
        response_type: "ephemeral",
        text: "Failed to open batch reject modal.",
      });
    }

    // Return empty 200 OK - modal is already opened via views.open API
    return c.body(null, 200);
  }

  // Handle /rejected-chats (blacklist view)
  if (cmd === "/rejected-chats") {
    const filter = text.trim();
    const blacklisted = await getBlacklistedChats(c.env.DB, filter === "all" ? 100 : 10);
    const botMeta = await getBotMetadataFromDbOrDefault(c.env);

    const blocks = buildBlacklistBlocks(
      blacklisted.map((b) => ({
        chatId: b.chatId,
        chatTitle: b.chatTitle,
        chatType: b.chatType,
        blacklistedAt: b.blacklistedAt,
        blacklistedBy: b.blacklistedBy,
      })),
      botMeta.username
    );

    c.executionCtx.waitUntil(
      fetch(response_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response_type: "ephemeral",
          blocks,
        }),
      }).catch((err) => {
        logger.error("Failed to send rejected chats response", {
          error: getErrorMessage(err),
        });
      })
    );

    return c.json({
      response_type: "ephemeral",
      text: "Loading rejected chats...",
    });
  }

  // Unknown command
  return c.json({
    response_type: "ephemeral",
    text: `Unknown command: ${cmd}. Available: /pending-chats, /batch-approve, /batch-reject, /rejected-chats`,
  });
});

/**
 * Helper to get bot metadata or return default.
 */
async function getBotMetadataFromDbOrDefault(env: {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
}): Promise<{ username: string; firstName: string }> {
  const { getBotMetadataFromDb } = await import("../lib/persistence");
  const cached = await getBotMetadataFromDb(env.DB);
  if (cached) {
    return cached;
  }

  // Return default if not cached
  return { username: "TriageBot", firstName: "Triage Bot" };
}

export default slackRoutes;
