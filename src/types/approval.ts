/** Approval flow type definitions. */

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ChatType = "private" | "group" | "supergroup" | "channel";
export type SlackBlocksType = "minimal" | "rich";

export interface PendingApproval {
  id: number;
  chatId: number;
  slackMessageTs: string | null;
  slackChannelId: string | null;
  slackBlocksType: SlackBlocksType;
  requestedBy: {
    name: string;
    username: string | null;
    userId: number;
  };
  chatType: ChatType;
  chatTitle: string | null;
  chatUsername: string | null;
  memberCount: number | null;
  complexityScore: number | null;
  complexityFactors: ComplexityFactors | null;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedBySlackUserId: string | null;
  resolvedBySlackUserName: string | null;
}

export interface ComplexityFactors {
  memberCount: number;
  messageDensity: number; // Messages per hour
  urgencySignals: number; // Count of urgency keywords
  questionCount: number;
  hasLinksOrCode: boolean;
  priorSummaryExists: boolean;
  explanation: string[]; // Human-readable explanation of factors
}

export interface ApprovalDecision {
  action: "approve" | "reject" | "unblacklist";
  chatId: number;
  slackUserId: string;
  slackUserName: string;
  reason?: string;
}

export interface BotMetadata {
  id: number;
  username: string;
  firstName: string;
  canJoinGroups: boolean;
  canReadAllGroupMessages: boolean;
  supportsInlineQueries: boolean;
  fetchedAt: string;
}

export interface BlacklistedChat {
  chatId: number;
  telegramChatId: number;
  chatTitle: string | null;
  chatType: ChatType;
  blacklistedAt: string;
  blacklistedBy: string | null;
  blacklistedReason: string | null;
  requestedByName: string | null;
  requestedByUsername: string | null;
}

export interface DailyStats {
  date: string;
  period: "morning" | "evening";
  totalChats: number;
  approvedChats: number;
  pendingChats: number;
  rejectedChats: number;
  expiredChats: number;
  blacklistedChats: number;
  totalMessages: number;
  uniqueUsers: number;
  activeChats: number;
  approvalDecisions: number;
}

export interface PriorChatSummary {
  chatId: number;
  telegramChatId: number;
  chatTitle: string | null;
  previouslyApprovedAt: string | null;
  totalMessagesExchanged: number;
  lastActivityAt: string | null;
  summaryContent: string | null;
}

export interface ApprovalSlackPayload {
  type: "block_actions" | "view_submission" | "command";
  user: {
    id: string;
    username: string;
    name: string;
  };
  actions?: Array<{
    action_id: string;
    block_id: string;
    value: string;
  }>;
  view?: {
    id: string;
    callback_id: string;
    state: {
      values: Record<string, Record<string, { type: string; selected_options?: Array<{ value: string }>; value?: string }>>;
    };
  };
  command?: string;
  text?: string;
  response_url?: string;
  trigger_id?: string;
}
