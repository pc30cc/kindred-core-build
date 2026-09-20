/**
 * Canonical `entry_source` vocabulary for call surfaces.
 *
 * Historically the standalone Call Center was the only non-chat call surface,
 * so its queries hardcoded `entry_source = 'call_widget'`. Telephony adds a
 * SECOND Call Center surface, and the two must be separated carefully:
 *
 *   - CALL_CENTER_ENTRY_SOURCES → operational Call Center surfaces (queue
 *     visibility, routing, ringing, call lists, answering, lifecycle). These
 *     include telephony.
 *   - WIDGET_ONLY_ENTRY_SOURCE → widget-specific counters, entitlements,
 *     concurrency limits and recording control. These MUST stay widget-only so
 *     existing plan semantics do not silently change.
 *
 * Future telephony providers add nothing here: provider identity lives in
 * `call_sessions.metadata.telephony.provider`, never in `entry_source`.
 */

export const ENTRY_SOURCE_CALL_WIDGET = 'call_widget' as const;
export const ENTRY_SOURCE_TELEPHONY = 'telephony' as const;

/** Operational Call Center surfaces (group A). */
export const CALL_CENTER_ENTRY_SOURCES: readonly string[] = Object.freeze([
  ENTRY_SOURCE_CALL_WIDGET,
  ENTRY_SOURCE_TELEPHONY,
]);

/** Widget-only semantics (group B) — never widen this. */
export const WIDGET_ONLY_ENTRY_SOURCE = ENTRY_SOURCE_CALL_WIDGET;

export function isCallCenterEntrySource(value: unknown): boolean {
  return typeof value === 'string' && CALL_CENTER_ENTRY_SOURCES.includes(value);
}

export function isTelephonyEntrySource(value: unknown): boolean {
  return value === ENTRY_SOURCE_TELEPHONY;
}
