/**
 * "Seen" on the operator's side of a thread (finding I-03).
 *
 * The widget records when the visitor last read the conversation
 * (widget_conversation_reads, POST /api/widget/conversations/:id/read). The
 * server hands it to the Inbox as the conversation's `visitor_last_read_at`
 * (list and detail rows) and announces each new marker on the operators'
 * inbox channel as a `visitor_read` event. The Inbox used to look at a
 * message's `seen_at`, which only ever marks the VISITOR's messages as read
 * by an operator, so an operator never learnt that their reply was read.
 *
 * The thread shows "Seen" once, under the newest team message (an
 * operator's or the AI's) the visitor has read: sent at or before their
 * last read. Both times are the server's clock.
 */

/** The message fields the rule reads. */
export interface SeenCandidate {
  id: string;
  sender_type?: string | null;
  created_at?: string | null;
  /** Older servers' per-message flag, still honoured when it is set. */
  seen_at?: string | null;
}

/** Messages the visitor receives from the team (not their own, not system rows). */
const TEAM_SENDERS = new Set(['agent', 'ai', 'bot']);

function time(value: string | null | undefined): number {
  const at = Date.parse(String(value ?? ''));
  return Number.isFinite(at) ? at : Number.NaN;
}

/**
 * The id of the newest team message the visitor has read, or null: none
 * read yet, or no read marker at all. Messages in thread order (oldest first).
 */
export function lastSeenTeamMessageId(
  messages: readonly SeenCandidate[] | null | undefined,
  visitorLastReadAt: string | null | undefined,
): string | null {
  if (!messages?.length) return null;
  const readAt = time(visitorLastReadAt);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || !TEAM_SENDERS.has(String(m.sender_type ?? ''))) continue;
    const sentAt = time(m.created_at);
    if ((Number.isFinite(readAt) && Number.isFinite(sentAt) && sentAt <= readAt) || !!m.seen_at) {
      return m.id;
    }
  }
  return null;
}

/** Whether the visitor has read this one message (sent at or before their last read). */
export function isReadByVisitor(
  message: Pick<SeenCandidate, 'created_at' | 'seen_at'> & { read_at?: string | null },
  visitorLastReadAt: string | null | undefined,
): boolean {
  if (message.seen_at || message.read_at) return true;
  const readAt = time(visitorLastReadAt);
  const sentAt = time(message.created_at);
  return Number.isFinite(readAt) && Number.isFinite(sentAt) && sentAt <= readAt;
}

/**
 * The later of two read markers (a realtime event and a list row can arrive
 * in either order; a marker never moves back). Invalid or missing values
 * lose to a valid one.
 */
export function laterReadMarker(a: string | null | undefined, b: string | null | undefined): string | null {
  const ta = time(a);
  const tb = time(b);
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? (b as string) : null;
  if (!Number.isFinite(tb)) return a as string;
  return tb > ta ? (b as string) : (a as string);
}
