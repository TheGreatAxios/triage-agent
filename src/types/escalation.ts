/** Status tracking for Slack escalations. */
export type EscalationStatus = "pending" | "acknowledged" | "resolved" | "expired";

export interface Escalation {
  id: number;
  chatId: number;
  draftId: number | null;
  reason: string;
  slackMessageTs: string | null;
  status: EscalationStatus;
  resolvedAt: string | null;
  createdAt: string;
}
