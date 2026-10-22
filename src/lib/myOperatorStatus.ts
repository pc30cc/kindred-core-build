/**
 * The signed-in operator's own status, as the account menu's dot shows it
 * (finding R-26). The dot used to be green whatever the truth: an operator
 * who had gone offline by hand, or was outside their own availability
 * schedule (so visitors saw them offline and routing gave them nothing),
 * still saw green and thought chats would come.
 *
 * Two inputs, both the server's:
 *   - their availability (GET /api/availability): the manual status and the
 *     schedule — what visitors see;
 *   - their live presence (GET /api/availability/team/:workspaceId, their
 *     own row): connected and active, idle ("away" after 5 minutes without
 *     interaction), or not connected — what routing reads.
 */
import type { AvailabilityResponse, OperatorPresence } from '@/lib/availability-api';

export type MyOperatorStatus =
  | 'online'
  | 'away'
  | 'offline'
  | 'outside_schedule'
  | 'disconnected'
  | 'unknown';

export function myOperatorStatus(
  availability: AvailabilityResponse | null | undefined,
  presence: OperatorPresence | null | undefined,
): MyOperatorStatus {
  if (!availability?.prefs) return 'unknown';
  const { prefs, status } = availability;
  // Offline by hand (or "invisible": not available when using the app).
  if (prefs.force_offline || prefs.available_when_using_app === false) return 'offline';
  if (status?.state === 'offline') return 'outside_schedule';
  switch (presence?.presence_state) {
    case 'away': return 'away';
    case 'disconnected': return 'disconnected';
    // A presence row that says offline while the settings say available
    // (the schedule just turned): the settings decide.
    default: return 'online';
  }
}

/** The manual choice the menu marks as current: 'offline' when they went offline by hand. */
export function manualChoiceOf(availability: AvailabilityResponse | null | undefined): 'online' | 'offline' | null {
  if (!availability?.prefs) return null;
  return availability.prefs.force_offline || availability.prefs.available_when_using_app === false ? 'offline' : 'online';
}

/** What choosing a status writes (Online makes them available again, whichever switch had turned them off). */
export function prefsForChoice(choice: 'online' | 'offline'): { force_offline: boolean; available_when_using_app?: boolean } {
  return choice === 'offline' ? { force_offline: true } : { force_offline: false, available_when_using_app: true };
}

export const MY_STATUS_DOT_CLASS: Record<MyOperatorStatus, string> = {
  online: 'bg-success',
  away: 'bg-warning',
  offline: 'bg-muted-foreground/60',
  outside_schedule: 'bg-muted-foreground/60',
  disconnected: 'bg-muted-foreground/40 ring-1 ring-success/50',
  unknown: 'bg-muted',
};

const KEY_SUFFIX: Record<Exclude<MyOperatorStatus, 'unknown'>, string> = {
  online: 'Online',
  away: 'Away',
  offline: 'Offline',
  outside_schedule: 'OutsideSchedule',
  disconnected: 'Disconnected',
};

/** `nav.status<X>` and `nav.status<X>Hint`; null while unknown. */
export function myStatusKeys(status: MyOperatorStatus): { label: string; hint: string } | null {
  if (status === 'unknown') return null;
  const suffix = KEY_SUFFIX[status];
  return { label: `nav.status${suffix}`, hint: `nav.status${suffix}Hint` };
}
