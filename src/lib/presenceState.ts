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

/**
 * What a teammate's presence reads as. The server's `away` is one of two
 * things that route differently, told apart by its reason: idle (no
 * activity for a few minutes: a fallback for new chats) or "Away from desk"
 * (their own choice, `manual_away`: nothing new). Each has its own name; a
 * row without a reason (an older server, the activity report) keeps the
 * plain `away`, which names both.
 */
export type PresenceLabel = OperatorPresenceState | 'idle' | 'manualAway';

export function presenceLabelOf(p: Pick<OperatorPresence, 'presence_state' | 'state' | 'reason'> | undefined | null): PresenceLabel {
  const state = presenceStateOf(p as OperatorPresence | null | undefined);
  if (state !== 'away' || !p?.reason) return state;
  return p.reason === 'manual_away' ? 'manualAway' : 'idle';
}

export function presenceLabelKey(label: PresenceLabel): string {
  return `presenceState.${label}`;
}

export function presenceHintKey(label: PresenceLabel): string {
  return `presenceState.${label}Hint`;
}
