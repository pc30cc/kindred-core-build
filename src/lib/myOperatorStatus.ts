/**
 * The signed-in operator's own status, as the account menu's dot shows it
 * (finding R-26). The dot used to be green whatever the truth: an operator
 * who had gone offline by hand, or was outside their own availability
 * schedule (so visitors saw them offline and routing gave them nothing),
 * still saw green and thought chats would come.
 *
 * Two inputs, both the server's:
 *   - their availability (GET /api/availability): the manual status
 *     (Online, "Away from desk" — migration 282 —, Offline) and the
 *     schedule — what visitors see;
 *   - their live presence (GET /api/availability/team/:workspaceId, their
 *     own row): connected and active, idle ("away" after 5 minutes without
 *     interaction, named "Idle", never "Away from desk"), or not connected —
 *     what routing reads.
 */
import type { AvailabilityResponse, OperatorPresence } from '@/lib/availability-api';

export type MyOperatorStatus =
  | 'online'
  | 'away'
  | 'manual_away'
  | 'offline'
  | 'outside_schedule'
  | 'disconnected'
  | 'unknown';

/** The statuses an operator can choose in the account menu. */
export type ManualStatusChoice = 'online' | 'away' | 'offline';

export const MANUAL_STATUS_CHOICES: readonly ManualStatusChoice[] = ['online', 'away', 'offline'];

export function myOperatorStatus(
  availability: AvailabilityResponse | null | undefined,
  presence: OperatorPresence | null | undefined,
): MyOperatorStatus {
  if (!availability?.prefs) return 'unknown';
  const { prefs, status } = availability;
  // Offline by hand (or "invisible": not available when using the app).
  if (prefs.force_offline || prefs.available_when_using_app === false) return 'offline';
  // Away by their own choice: no new chats whatever the schedule says.
  if (prefs.manual_away === true) return 'manual_away';
  if (status?.state === 'offline') return 'outside_schedule';
  switch (presence?.presence_state) {
    case 'away': return 'away';
    case 'disconnected': return 'disconnected';
    // A presence row that says offline while the settings say available
    // (the schedule just turned): the settings decide.
    default: return 'online';
  }
}

/** The manual choice the menu marks as current. */
export function manualChoiceOf(availability: AvailabilityResponse | null | undefined): ManualStatusChoice | null {
  if (!availability?.prefs) return null;
  const { prefs } = availability;
  if (prefs.force_offline || prefs.available_when_using_app === false) return 'offline';
  return prefs.manual_away === true ? 'away' : 'online';
}

/**
 * What choosing a status writes. Online makes them available again,
 * whichever switch had turned them off; each choice also sets "Away from
 * desk", so exactly one of the three is current.
 */
export function prefsForChoice(choice: ManualStatusChoice): { force_offline: boolean; available_when_using_app?: boolean; manual_away: boolean } {
  if (choice === 'offline') return { force_offline: true, manual_away: false };
  return { force_offline: false, available_when_using_app: true, manual_away: choice === 'away' };
}

export const MY_STATUS_DOT_CLASS: Record<MyOperatorStatus, string> = {
  online: 'bg-success',
  away: 'bg-warning',
  manual_away: 'bg-warning',
  offline: 'bg-muted-foreground/60',
  outside_schedule: 'bg-muted-foreground/60',
  disconnected: 'bg-muted-foreground/40 ring-1 ring-success/50',
  unknown: 'bg-muted',
};

/** The dot of each choice in the menu. */
export const CHOICE_DOT_CLASS: Record<ManualStatusChoice, string> = {
  online: MY_STATUS_DOT_CLASS.online,
  away: MY_STATUS_DOT_CLASS.manual_away,
  offline: MY_STATUS_DOT_CLASS.offline,
};

const STATUS_KEYS: Record<Exclude<MyOperatorStatus, 'unknown'>, { label: string; hint: string }> = {
  online: { label: 'nav.statusOnline', hint: 'nav.statusOnlineHint' },
  // Idle (automatic) and "Away from desk" (their choice) route differently:
  // each has its own name, so the choice never reads as the idle fallback.
  away: { label: 'nav.statusIdle', hint: 'nav.statusIdleHint' },
  manual_away: { label: 'nav.statusAway', hint: 'nav.statusManualAwayHint' },
  offline: { label: 'nav.statusOffline', hint: 'nav.statusOfflineHint' },
  outside_schedule: { label: 'nav.statusOutsideSchedule', hint: 'nav.statusOutsideScheduleHint' },
  disconnected: { label: 'nav.statusDisconnected', hint: 'nav.statusDisconnectedHint' },
};

/** The label and hint keys (`nav.status…`); null while unknown. */
export function myStatusKeys(status: MyOperatorStatus): { label: string; hint: string } | null {
  if (status === 'unknown') return null;
  return STATUS_KEYS[status];
}

/** A choice's menu label, the toast once it is saved, and its explanation. */
export const CHOICE_KEYS: Record<ManualStatusChoice, { label: string; done: string; hint: string }> = {
  online: { label: 'nav.statusOnline', done: 'nav.statusNowOnline', hint: 'nav.statusOnlineHint' },
  away: { label: 'nav.statusAway', done: 'nav.statusNowAway', hint: 'nav.statusManualAwayHint' },
  offline: { label: 'nav.statusOffline', done: 'nav.statusNowOffline', hint: 'nav.statusOfflineHint' },
};
