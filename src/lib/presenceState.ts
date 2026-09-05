/**
 * Presentation helpers for INTERNAL operator presence.
 *
 * These four states describe whether a teammate is really in the panel right
 * now. They are NOT what visitors see — visitor-facing availability comes from
 * manual status + personal schedule and lives on `customer_availability`.
 */
import type { OperatorPresence, OperatorPresenceState } from '@/lib/availability-api';

export const PRESENCE_DOT_CLASS: Record<OperatorPresenceState, string> = {
  active: 'bg-emerald-500',
  away: 'bg-amber-500',
  disconnected: 'bg-muted-foreground/40 ring-1 ring-emerald-500/50',
  offline: 'bg-muted-foreground/40',
};

export function presenceStateOf(p: OperatorPresence | undefined | null): OperatorPresenceState {
  if (!p) return 'offline';
  if (p.presence_state) return p.presence_state;
  // Older API payloads only carried the legacy boolean-ish `state`.
  return p.state === 'online' ? 'active' : 'offline';
}

export function presenceLabelKey(state: OperatorPresenceState): string {
  return `presenceState.${state}`;
}

export function presenceHintKey(state: OperatorPresenceState): string {
  return `presenceState.${state}Hint`;
}
