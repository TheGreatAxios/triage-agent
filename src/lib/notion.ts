/**
 * Notion integration — single database, child-block append model.
 *
 * DB A: Projects — one page per Telegram chat
 *   • Triage items (bugs, requests) appended as child blocks
 *   • Summaries appended as child blocks
 *   • Everything lives on one page — one-to-many via blocks, not relations
 *
 * Project matching flow:
 *   1. Check D1 cache (notion_project_map) for known chat→page mapping
 *   2. If cached → append blocks directly
 *   3. If not cached → search Notion DB by title
 *      a. Matches found → send Slack suggestion: [Confirm] [Create New] [Skip]
 *      b. No matches → send Slack suggestion: [Create New] [Skip]
 *   4. On confirm/create → cache mapping in D1 + append blocks
 *   5. Subsequent events auto-append (cached)
 *
 * All Notion calls guarded by NOTION_API_KEY + NOTION_PROJECTS_DB_ID.
 * Never throws — returns null/false on failure.
 */

import type { Env } from "../types/env";
import type { ClassificationLabel } from "../types/classification";
import { logger } from "./logger";
import { getErrorMessage } from "./errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotionPageResult {
  pageId: string;
  pageUrl: string;
}

export interface NotionProjectMatch {
  pageId: string;
  title: string;
  url: string;
}

export interface NotionProjectSuggestion {
  chatId: number;
  chatTitle: string;
  matches: NotionProjectMatch[];
  /** Pending block payload to append once project is confirmed */
  pendingBlocks: unknown[];
  pendingType: "triage" | "summary";
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isConfigured(env: Env): boolean {
  return !!(env.NOTION_API_KEY && env.NOTION_PROJECTS_DB_ID);
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// Project Lookup & Creation
// ---------------------------------------------------------------------------

/**
 * Search Notion DB for projects whose title contains the chat title.
 * Returns up to 3 matches ranked by relevance.
 */
export async function findProjectMatches(
  env: Env,
  chatTitle: string,
): Promise<NotionProjectMatch[]> {
  if (!isConfigured(env)) return [];

  try {
    const searchTerms = extractSearchTerms(chatTitle);
    const allMatches: NotionProjectMatch[] = [];

    for (const term of searchTerms) {
      const resp = await fetch(
        `https://api.notion.com/v1/databases/${env.NOTION_PROJECTS_DB_ID}/query`,
        {
          method: "POST",
          headers: headers(env.NOTION_API_KEY!),
          body: JSON.stringify({
            page_size: 5,
            filter: {
              property: "Title",
              title: { contains: term },
            },
          }),
        },
      );

      if (!resp.ok) {
        const body = await resp.text();
        logger.error("Notion project search failed", { status: resp.status, body });
        continue;
      }

      const json = (await resp.json()) as { results: Array<Record<string, unknown>> };
      for (const page of json.results) {
        const props = page.properties as Record<string, Record<string, unknown>> | undefined;
        const titleArr = (props?.Title?.title as Array<{ plain_text: string }>) ?? [];
        const title = titleArr.map((t) => t.plain_text).join("");

        if (!allMatches.some((m) => m.pageId === (page.id as string))) {
          allMatches.push({
            pageId: page.id as string,
            title,
            url: page.url as string,
          });
        }
      }
    }

    // Rank: exact match first
    allMatches.sort((a, b) => {
      const aExact = a.title.toLowerCase() === chatTitle.toLowerCase() ? 0 : 1;
      const bExact = b.title.toLowerCase() === chatTitle.toLowerCase() ? 0 : 1;
      return aExact - bExact;
    });

    return allMatches.slice(0, 3);
  } catch (err) {
    logger.error("Notion project search error", { error: getErrorMessage(err) });
    return [];
  }
}

/**
 * Create a new Project page in Notion.
 */
export async function createProject(
  env: Env,
  chatTitle: string,
  chatType: string,
  telegramChatId: number,
): Promise<NotionPageResult | null> {
  if (!isConfigured(env)) return null;

  try {
    const resp = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: headers(env.NOTION_API_KEY!),
      body: JSON.stringify({
        parent: { database_id: env.NOTION_PROJECTS_DB_ID },
        properties: {
          Title: { title: [{ text: { content: chatTitle } }] },
          Source: { select: { name: "telegram" } },
          "Chat Type": { select: { name: chatType } },
          "Chat ID": { number: telegramChatId },
          Status: { status: { name: "Active" } },
        },
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.error("Notion project creation failed", { status: resp.status, body });
      return null;
    }

    const json = (await resp.json()) as { id: string; url: string; object: string };
    if (json.object !== "page") return null;

    logger.info("Notion project created", { pageId: json.id, pageUrl: json.url });
    return { pageId: json.id, pageUrl: json.url };
  } catch (err) {
    logger.error("Notion project creation error", { error: getErrorMessage(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Child Block Appends (the "comments" model)
// ---------------------------------------------------------------------------

/**
 * Append triage item as child blocks to a project page.
 *
 * Renders as a callout block with bug/request details + recent messages.
 */
export async function appendTriageBlock(
  env: Env,
  projectPageId: string,
  classification: { label: ClassificationLabel; confidence: number; reasoning: string },
  recentMessages: string[],
): Promise<boolean> {
  if (!isConfigured(env)) return false;

  const emoji = classification.label === "bug" ? "🐛" : "✨";
  const label = classification.label.toUpperCase();
  const confidence = `${(classification.confidence * 100).toFixed(0)}%`;
  const messageContext =
    recentMessages.length > 0 ? recentMessages.join("\n") : "No recent messages available.";

  const blocks = [
    { type: "divider" },
    {
      type: "callout",
      icon: { type: "emoji", emoji },
      rich_text: [
        {
          type: "text",
          text: { content: `${label} — ${confidence} confidence\n${classification.reasoning}` },
        },
      ],
    },
    {
      type: "code",
      rich_text: [{ type: "text", text: { content: messageContext.slice(0, 2000) } }],
    },
  ];

  return appendBlocks(env, projectPageId, blocks);
}

/**
 * Append summary as child blocks to a project page.
 *
 * Renders as a toggle with the summary content.
 */
export async function appendSummaryBlock(
  env: Env,
  projectPageId: string,
  summaryContent: string,
  messageCount: number,
): Promise<boolean> {
  if (!isConfigured(env)) return false;

  const now = new Date().toISOString().split("T")[0];

  const blocks = [
    {
      type: "toggle",
      toggle: {
        rich_text: [
          {
            type: "text",
            text: { content: `📝 Summary (${now}) — ${messageCount} messages` },
            annotations: { bold: true },
          },
        ],
        children: [
          {
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: summaryContent.slice(0, 2000) } }],
            },
          },
        ],
      },
    },
  ];

  return appendBlocks(env, projectPageId, blocks);
}

/**
 * Low-level: append blocks to any Notion block/page.
 */
async function appendBlocks(
  env: Env,
  blockId: string,
  blocks: unknown[],
): Promise<boolean> {
  try {
    const resp = await fetch(`https://api.notion.com/v1/blocks/${blockId}/children`, {
      method: "PATCH",
      headers: headers(env.NOTION_API_KEY!),
      body: JSON.stringify({ children: blocks }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.error("Notion block append failed", { status: resp.status, body, blockId });
      return false;
    }

    logger.info("Notion blocks appended", { blockId, count: blocks.length });
    return true;
  } catch (err) {
    logger.error("Notion block append error", { error: getErrorMessage(err), blockId });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Orchestration: match → append (or queue Slack suggestion)
// ---------------------------------------------------------------------------

/**
 * High-level: append a triage item to the right Notion project page.
 *
 * 1. Check D1 cache → auto-append if known
 * 2. No cache → search Notion, return suggestion for Slack
 */
export async function pushTriageToNotion(
  env: Env,
  chatId: number,
  chatTitle: string | null,
  classification: { label: ClassificationLabel; confidence: number; reasoning: string },
  recentMessages: string[],
): Promise<{ appended: boolean; suggestion?: NotionProjectSuggestion }> {
  if (!isConfigured(env)) return { appended: false };

  // Check cache
  const cachedPageId = await getProjectPageId(env.DB, chatId);
  if (cachedPageId) {
    const appended = await appendTriageBlock(env, cachedPageId, classification, recentMessages);
    return { appended };
  }

  // No cache — search for matches (caller will send Slack suggestion)
  const suggestion = await suggestProjectLink(env, chatId, chatTitle, "triage", [
    classification,
    recentMessages,
  ]);

  return { appended: false, suggestion: suggestion ?? undefined };
}

/**
 * High-level: append a summary to the right Notion project page.
 *
 * 1. Check D1 cache → auto-append if known
 * 2. No cache → search Notion, return suggestion for Slack
 */
export async function pushSummaryToNotion(
  env: Env,
  chatId: number,
  chatTitle: string | null,
  summaryContent: string,
  messageCount: number,
): Promise<{ appended: boolean; suggestion?: NotionProjectSuggestion }> {
  if (!isConfigured(env)) return { appended: false };

  // Check cache
  const cachedPageId = await getProjectPageId(env.DB, chatId);
  if (cachedPageId) {
    const appended = await appendSummaryBlock(env, cachedPageId, summaryContent, messageCount);
    return { appended };
  }

  // No cache — search for matches
  const suggestion = await suggestProjectLink(env, chatId, chatTitle, "summary", [
    summaryContent,
    messageCount,
  ]);

  return { appended: false, suggestion: suggestion ?? undefined };
}

/**
 * Build a project suggestion by searching Notion.
 * Internal helper — used by pushTriageToNotion and pushSummaryToNotion.
 */
async function suggestProjectLink(
  env: Env,
  chatId: number,
  chatTitle: string | null,
  blockType: "triage" | "summary",
  _payload: unknown[],
): Promise<NotionProjectSuggestion | null> {
  if (!chatTitle) return null;

  const matches = await findProjectMatches(env, chatTitle);

  return {
    chatId,
    chatTitle,
    matches,
    pendingBlocks: [],
    pendingType: blockType,
  };
}

// ---------------------------------------------------------------------------
// Slack Confirmation → Notion Action
// ---------------------------------------------------------------------------

/**
 * Called when Slack user confirms a project match.
 * Caches the mapping and replays the pending block append.
 *
 * @param triagePayload - [classification, recentMessages] for triage, [content, count] for summary
 */
export async function confirmProjectAndAppend(
  env: Env,
  chatId: number,
  projectPageId: string,
  blockType: "triage" | "summary",
  triagePayload: unknown[],
): Promise<boolean> {
  // Cache the mapping
  await persistProjectMapping(env.DB, chatId, projectPageId);

  if (blockType === "triage") {
    const [classification, recentMessages] = triagePayload as [
      { label: ClassificationLabel; confidence: number; reasoning: string },
      string[],
    ];
    return appendTriageBlock(env, projectPageId, classification, recentMessages);
  } else {
    const [content, count] = triagePayload as [string, number];
    return appendSummaryBlock(env, projectPageId, content, count);
  }
}

// ---------------------------------------------------------------------------
// D1 Persistence
// ---------------------------------------------------------------------------

/**
 * Persist a Notion page link in D1 (for audit trail).
 */
export async function persistNotionLink(
  db: D1Database,
  chatId: number,
  messageId: number,
  pageId: string,
  pageUrl: string,
  pageType: "project" | "block_triage" | "block_summary",
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notion_links (chat_id, message_id, notion_page_id, notion_page_url, page_type)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(chatId, messageId, pageId, pageUrl, pageType)
    .run();
}

/**
 * Cache chat → Notion project page mapping in D1.
 */
export async function persistProjectMapping(
  db: D1Database,
  chatId: number,
  projectPageId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notion_project_map (chat_id, notion_page_id)
       VALUES (?, ?)
       ON CONFLICT (chat_id) DO UPDATE SET notion_page_id = excluded.notion_page_id, updated_at = datetime('now')`,
    )
    .bind(chatId, projectPageId)
    .run();
}

/**
 * Get cached Notion project page ID for a chat.
 */
export async function getProjectPageId(db: D1Database, chatId: number): Promise<string | null> {
  const row = await db
    .prepare(`SELECT notion_page_id FROM notion_project_map WHERE chat_id = ?`)
    .bind(chatId)
    .first<{ notion_page_id: string }>();
  return row?.notion_page_id ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSearchTerms(title: string): string[] {
  const cleaned = title.trim().replace(/[^\w\s]/g, "");
  const words = cleaned.split(/\s+/).filter(Boolean);
  const terms: string[] = [];

  if (cleaned.length <= 100) terms.push(cleaned);
  if (words.length > 1) {
    const short = words.slice(0, 3).join(" ");
    if (!terms.includes(short)) terms.push(short);
  }
  const significant = words.find((w) => w.length > 3);
  if (significant && !terms.includes(significant)) terms.push(significant);

  return terms.slice(0, 3);
}
