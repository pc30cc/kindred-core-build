/**
 * Canonical `entry_source` vocabulary for call surfaces.
 *
 * The standalone Call Center is the only non-chat call surface, so these
 * constants exist so its queries never hardcode the literal in a dozen places:
 *
 *   - CALL_CENTER_ENTRY_SOURCES → operational Call Center surfaces (queue
 *     visibility, routing, ringing, call lists, answering, lifecycle).
 *   - WIDGET_ONLY_ENTRY_SOURCE → widget-specific counters, entitlements,
 *     concurrency limits and recording control.
 *
 * The two lists are deliberately kept separate: a future second call surface
 * belongs in CALL_CENTER_ENTRY_SOURCES only, so widget plan semantics cannot
 * change by accident.
 */

export const ENTRY_SOURCE_CALL_WIDGET = 'call_widget' as const;

/** Operational Call Center surfaces. */
export const CALL_CENTER_ENTRY_SOURCES: readonly string[] = Object.freeze([
  ENTRY_SOURCE_CALL_WIDGET,
]);

/** Widget-only semantics — never widen this. */
export const WIDGET_ONLY_ENTRY_SOURCE = ENTRY_SOURCE_CALL_WIDGET;

export function isCallCenterEntrySource(value: unknown): boolean {
  return typeof value === 'string' && CALL_CENTER_ENTRY_SOURCES.includes(value);
}
