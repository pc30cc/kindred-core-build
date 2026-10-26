/**
 * The inactivity close of website-widget conversations (migration 284): its
 * bounds, the metadata keys a close writes, and how a closed conversation
 * ended. Pure, so the server (zod, the ticker, the reports) and the panel
 * (the settings, the Overview) draw the same lines.
 *
 * A conversation in which neither the visitor nor the team (people or the
 * AI) has exchanged anything for the workspace's window (1 to 48 hours,
 * NULL = the Super Admin's default) is closed by the system, never while
 * the team owes an answer. The close markers are read only while the status
 * is `closed`.
 */

export const INACTIVITY_CLOSE_MIN_HOURS = 1;
export const INACTIVITY_CLOSE_MAX_HOURS = 48;
export const INACTIVITY_CLOSE_DEFAULT_HOURS = 24;
export const INACTIVITY_CLOSE_RACE_GRACE_SECONDS = 60;
export const INACTIVITY_CLOSE_MAX_UNTOUCHED_DAYS = 30; // the timer's bound; the backlog has none

/** Who closed it: the timer or the backlog ('inactivity'), or an operator's PATCH. */
export type ClosedReason = 'inactivity' | 'operator';

/** Every conversation metadata key a close writes (and a reopen clears). */
export const CLOSED_KEYS = ['closed_reason', 'closed_by', 'closed_at', 'closed_from', 'closed_source',
  'closed_idle_hours', 'closed_last_exchange_at', 'closed_outcome', 'closed_line_id', 'closed_prev_stamps'] as const;

const finiteHours = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The window that applies: the workspace's own hours, else the platform
 * default, else 24; always a whole number within 1..48.
 */
export function effectiveInactivityCloseHours(own: number | null | undefined, platformDefault: number | undefined): number {
  const hours = finiteHours(own) ?? finiteHours(platformDefault) ?? INACTIVITY_CLOSE_DEFAULT_HOURS;
  return Math.min(INACTIVITY_CLOSE_MAX_HOURS, Math.max(INACTIVITY_CLOSE_MIN_HOURS, Math.round(hours)));
}

/**
 * How a conversation ended, for the reports:
 *   - `resolved`;
 *   - `closed_inactive`: the timer closed it while it was open or pending
 *     (counted as "Closed automatically");
 *   - `closed_inactive_after_resolve`: the timer closed a resolved one (it
 *     stays the operator's resolve);
 *   - `closed_operator`: any other close (an operator's, or a legacy close
 *     without a reason);
 *   - null while it is open or pending.
 */
export function conversationEndOf(
  status: string,
  metadata: unknown,
): 'resolved' | 'closed_operator' | 'closed_inactive' | 'closed_inactive_after_resolve' | null {
  if (status === 'resolved') return 'resolved';
  if (status !== 'closed') return null;
  const meta = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  if (meta.closed_reason !== 'inactivity') return 'closed_operator';
  return meta.closed_from === 'resolved' ? 'closed_inactive_after_resolve' : 'closed_inactive';
}
