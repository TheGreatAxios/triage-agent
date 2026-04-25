/** Team member record from D1 */
export interface TeamMember {
  id: number;
  telegramUsername: string;
  displayName: string;
  role: string;
  slackUserId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Chat metrics record from D1 */
export interface ChatMetrics {
  id: number;
  chatId: number;
  firstCustomerMessageAt: string | null;
  firstResponseAt: string | null;
  firstResponseSeconds: number | null;
  lastTeamTouchAt: string | null;
  totalTeamTouches: number;
  teamMemberIds: number[];
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Team member daily metrics aggregation */
export interface TeamMemberMetrics {
  id: number;
  teamMemberId: number;
  date: string;
  chatsResponded: number;
  messagesSent: number;
  avgFirstResponseSeconds: number | null;
  bugsHandled: number;
  requestsHandled: number;
  escalationsCreated: number;
  createdAt: string;
  updatedAt: string;
}

/** Stale chat result for alerting */
export interface StaleChat {
  chatId: number;
  chatTitle: string | null;
  customerWaitingHours: number;
  lastTeamTouchAt: string | null;
  lastTeamMemberName: string | null;
}

/** Daily summary tracking record */
export interface DailySummarySent {
  id: number;
  date: string;
  period: "morning" | "evening";
  sentAt: string;
  slackChannel: string | null;
  slackMessageTs: string | null;
}

/** Stale alert tracking record */
export interface StaleAlertSent {
  id: number;
  chatId: number;
  alertType: string;
  sentAt: string;
}

/** KPI calculation tracking record */
export interface KpiCalculationCompleted {
  id: number;
  date: string;
  calculationType: string;
  completedAt: string;
}
