/**
 * THE INACTIVITY CLOSE (owner, 2026-10-23/24; migration 284): the bounds,
 * the vocabulary and the reading of a close, shared by the server, the panel
 * and the reports. Pure: no I/O.
 *
 * A website-widget conversation in which neither the visitor nor the team
 * (people or the AI) has exchanged anything for N hours is closed by the
 * system (server/services/conversationIdleCloseTicker.ts), never while the
 * team still owes an answer (the SQL conversation_idle_check). N is the
 * workspace's widget_settings.inactivity_close_hours (1–48), else the Super
 * Admin's widget_platform_settings.inactivity_close_default_hours (24 by
 * default). Only the Super Admin's switch (inactivity_close_enabled) turns it
 * off, for every workspace at once.
 *
 * A close writes its markers into conversations.metadata (CLOSED_KEYS). They
 * describe the close the conversation is in, so they are read only while its
 * status is `closed`: a reopen clears them (the PATCH, reopenForOperator, the
 * race reopen), and a later close writes its own.
 */

export const INACTIVITY_CLOSE_MIN_HOURS = 1;
export const INACTIVITY_CLOSE_MAX_HOURS = 48;
export const INACTIVITY_CLOSE_DEFAULT_HOURS = 24;
/**
 * A visitor message within this many seconds of an inactivity close raced it
 * (the widget had not heard of the close yet): it reopens that conversation,
 * as it was (conversation_reopen_after_idle_close; the SQL caps it at 600).
 */
export const INACTIVITY_CLOSE_RACE_GRACE_SECONDS = 60;
/**
 * The timer never closes a conversation untouched for longer (its updated_at):
 * that backlog is closed by hand, silently, after the owner saw the list
 * (database/backfill/284_inactivity_backlog_close.sql), which has no bound.
 */
export const INACTIVITY_CLOSE_MAX_UNTOUCHED_DAYS = 30;

/** Who closed it: the system after the quiet period, or an operator (the Inbox's PATCH). */
export type ClosedReason = 'inactivity' | 'operator';
/** Which inactivity close: the timer (with the visitor's line) or the hand-run backlog (silent). */
export type ClosedSource = 'inactivity_timer' | 'inactivity_backlog';
/** What the conversation was when the timer closed it (reports). */
export type ClosedOutcome = 'no_visitor_message' | 'human' | 'ai_resolved' | 'ai_unresolved' | 'unanswered';

/**
 * The conversation metadata keys a close writes:
 *   closed_reason            'inactivity' (the timer, the backlog) | 'operator' (the PATCH);
 *   closed_by                'system' | 'agent';
 *   closed_at                the close time (DB now(), YYYY-MM-DDTHH:MM:SS.mmmZ);
 *   closed_from              open, pending or resolved;
 *   closed_source            'inactivity_timer' | 'inactivity_backlog'; null for an operator's close;
 *   closed_idle_hours        the window that applied;
 *   closed_last_exchange_at  the last exchange the decision found;
 *   closed_outcome           ClosedOutcome;
 *   closed_line_id           the visitor's closed line this close inserted, or null;
 *   closed_prev_stamps       {routing_thread_ended_at, ai_thread_reset_at} as they were
 *                            before the close (the race reopen puts them back).
 * An inactivity close writes these and the two thread-end stamps
 * (routing_thread_ended_at, ai_thread_reset_at), nothing else: never
 * updated_at, never the AI's hold (ai_state, the handoff, the takeover).
 */
export const CLOSED_KEYS = [
  'closed_reason',
  'closed_by',
  'closed_at',
  'closed_from',
  'closed_source',
  'closed_idle_hours',
  'closed_last_exchange_at',
  'closed_outcome',
  'closed_line_id',
  'closed_prev_stamps',
] as const;

export type ClosedKey = (typeof CLOSED_KEYS)[number];

/** Every close marker set to null: a reopen's metadata patch (the conversation is live again). */
export function clearedClosedMarkers(): Record<ClosedKey, null> {
  return Object.fromEntries(CLOSED_KEYS.map((k) => [k, null])) as Record<ClosedKey, null>;
}

/** The markers of an operator's close (the Inbox's PATCH to `closed` from `from`). */
export function operatorCloseMarkers(closedAt: string, from: string): Record<ClosedKey, unknown> {
  return {
    ...clearedClosedMarkers(),
    closed_reason: 'operator',
    closed_by: 'agent',
    closed_at: closedAt,
    closed_from: from,
  };
}

function integerOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function clampHours(n: number): number {
  return Math.min(INACTIVITY_CLOSE_MAX_HOURS, Math.max(INACTIVITY_CLOSE_MIN_HOURS, n));
}

/**
 * The window that applies to a workspace: its own value, else the platform's
 * default, else 24 h, clamped to 1–48 (as the SQL clamps it).
 */
export function effectiveInactivityCloseHours(own: number | null | undefined, platformDefault: number | undefined): number {
  const mine = integerOrNull(own);
  if (mine !== null) return clampHours(mine);
  const platform = integerOrNull(platformDefault);
  return clampHours(platform ?? INACTIVITY_CLOSE_DEFAULT_HOURS);
}

export type ConversationEnd = 'resolved' | 'closed_operator' | 'closed_inactive' | 'closed_inactive_after_resolve';

/**
 * How a conversation ended, for the reports:
 *   resolved                       an operator resolved it;
 *   closed_operator                an operator closed it (or a close before 284, without markers);
 *   closed_inactive                the system closed it after the quiet period, from open or pending
 *                                  ("Closed automatically");
 *   closed_inactive_after_resolve  the system closed one an operator had resolved: still that
 *                                  operator's resolve;
 *   null                           it is open or pending.
 * The markers are read only while the status is `closed`.
 */
export function conversationEndOf(status: string, metadata: unknown): ConversationEnd | null {
  if (status === 'resolved') return 'resolved';
  if (status !== 'closed') return null;
  const meta = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  if (meta.closed_reason !== 'inactivity') return 'closed_operator';
  return meta.closed_from === 'resolved' ? 'closed_inactive_after_resolve' : 'closed_inactive';
}
