/**
 * A conversation's status as every operator surface names it (finding I-01).
 *
 * The Inbox, the contact page and drawer, the timeline and the dashboard
 * each used to name the same state differently: the Inbox said «در حال
 * مکالمه» / "Active" for open, the contact page said «بسته‌شده» for a
 * resolved conversation the Inbox called «حل شده». One set of keys now:
 * `inbox.open`, `inbox.pending`, `inbox.resolved`, `inbox.closed`
 * (fa «باز», «در انتظار بازدیدکننده», «حل‌شده», «بسته»; en Open, Waiting on
 * visitor, Resolved, Closed). The visitor's widget has its own words
 * (public/widget); this is the operators' side.
 */

export const CONVERSATION_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;

export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

const FALLBACK: Record<ConversationStatus, string> = {
  open: 'Open',
  pending: 'Waiting on visitor',
  resolved: 'Resolved',
  closed: 'Closed',
};

/** A stored status, or 'open' for a missing or unknown one (the lists' default). */
export function normalizeConversationStatus(status: unknown): ConversationStatus {
  return (CONVERSATION_STATUSES as readonly string[]).includes(String(status))
    ? (status as ConversationStatus)
    : 'open';
}

/**
 * The status's name in the interface language. The translator answers a
 * missing key with the key itself; the English name is used then.
 */
export function conversationStatusLabel(t: (key: string) => string, status: unknown): string {
  const value = normalizeConversationStatus(status);
  const key = `inbox.${value}`;
  const text = t(key);
  return text && text !== key ? text : FALLBACK[value];
}

/** Badge colours per status (shared by the contact page and drawer). */
export const CONVERSATION_STATUS_BADGE: Record<ConversationStatus, string> = {
  open: 'bg-success/15 text-success',
  pending: 'bg-warning/15 text-warning',
  resolved: 'bg-info/15 text-info',
  closed: 'bg-muted text-muted-foreground',
};
