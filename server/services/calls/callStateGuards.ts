/**
 * The call state machine's guards, shared by every route that moves a
 * call_sessions row (audit 2026-11-04, calls-1/2/6/9).
 *
 * A call is LIVE while it is `pending`, `ringing`, `connecting` or `active`,
 * and over once it is `ended`, `failed`, `cancelled` or `missed`. An over call
 * never comes back: every write that moves a call goes from a live state only
 * (a compare-and-set on the state), so
 *
 *   - the billing trigger `tg_call_sessions_bill_minutes`, which adds the
 *     call's minutes on every move into `ended`, adds them once: a call that
 *     ended cannot become `active` again and end a second time (calls-1);
 *   - an ended call's time and end stay as they ended (calls-9).
 *
 * Migration 298 (`298_call_state_guards.sql`) holds the same line in the
 * database: an over call is never moved back to a live state, whatever writes.
 *
 * Colleague calls (`entry_source = 'team_call'`) have their own machine
 * (teamCallLifecycle.ts) with the same rule; the helpers here are for the
 * other calls (chat calls, the call-centre widget's calls).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveCallProvider } from './providerResolver.js';
import type { CallProviderId } from './providers/types.js';
import { CALL_CENTER_ENTRY_SOURCES } from '../../../shared/callCenter/entrySources.js';

/** A call that is still on (or still waiting to be). The values of `public.call_state`. */
export const LIVE_CALL_STATES = ['pending', 'ringing', 'connecting', 'active'] as const;

/** A call that is over. It never moves again. */
export const TERMINAL_CALL_STATES = ['ended', 'failed', 'cancelled', 'missed'] as const;

/** Live states in which an operator holds the call (what an operator's active call count counts). */
export const OPERATOR_HELD_CALL_STATES = ['ringing', 'connecting', 'active'] as const;

export function isLiveCallState(state: unknown): boolean {
  return (LIVE_CALL_STATES as readonly string[]).includes(String(state ?? ''));
}

export function isTerminalCallState(state: unknown): boolean {
  return (TERMINAL_CALL_STATES as readonly string[]).includes(String(state ?? ''));
}

/**
 * A room of a call that is over came back: LiveKit makes a room again when
 * someone joins it with a token that has not expired yet (`auto_create`,
 * docker-compose.livekit.yml), so a visitor or member keeping a call's token
 * could otherwise meet again in its room after the end, uncounted. The room
 * is closed at once, which disconnects whoever is in it. A live call keeps
 * its room. Best-effort: a close that fails is logged, and the next join's
 * webhook tries again. True when it closed one. (The colleague-call version
 * is teamCallLifecycle.ts closeRoomOfFinishedTeamCall.)
 */
export async function closeRoomOfFinishedCall(
  config: ServerConfig,
  row: { state?: string | null; provider?: string | null; provider_room_id?: string | null } | null,
  roomName: string | null | undefined,
): Promise<boolean> {
  if (!row || !row.provider_room_id || !row.provider) return false;
  if (!isTerminalCallState(row.state)) return false;
  if (roomName && roomName !== row.provider_room_id) return false;
  try {
    await resolveCallProvider(row.provider as CallProviderId).closeRoom(config, row.provider_room_id);
    return true;
  } catch (err) {
    console.warn('[calls] closing the room of a finished call failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * An operator's `call_center_agent_presence.active_call_count`, set from the
 * calls they hold now (call-centre calls assigned to them in a held state)
 * rather than counted up and down: every way a call ends (the operator, the
 * visitor, LiveKit's room_finished, a transfer, a takeover) then leaves the
 * count right, and a count that drifted is put right on the operator's next
 * call (calls-6). Never throws; a failed read leaves the stored count alone.
 */
export async function syncAgentActiveCallCount(
  config: ServerConfig,
  workspaceId: string,
  userId: string | null | undefined,
): Promise<void> {
  if (!workspaceId || !userId) return;
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('call_sessions')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('assigned_agent_id', userId)
      .in('entry_source', CALL_CENTER_ENTRY_SOURCES as string[])
      .in('state', OPERATOR_HELD_CALL_STATES as unknown as string[])
      .limit(1000);
    if (error || !Array.isArray(data)) return;
    const count = data.length;
    await sb
      .from('call_center_agent_presence')
      .update({ active_call_count: Math.max(0, count) })
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId);
  } catch {
    /* best-effort: routing reads the count, nothing depends on this write */
  }
}
