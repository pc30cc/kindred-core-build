/**
 * The colleague calls' clock (docs/operations/TEAM_CALLS.md, "Ring timeout"),
 * two passes on two timers, each run by one replica at a time (its lease).
 *
 * THE RING'S END. Every five seconds: colleague calls still ringing a whole
 * ring (TEAM_CALL_RING_SECONDS, 45 s) after they were placed are marked
 * missed (teamCallLifecycle.ts expireTeamCall): the callee's rung Android
 * phones are told to stop, both members hear it on their realtime channels,
 * the callee gets the missed-call notification, and the room closes. An
 * iPhone stops on its own: it polls the call and ends its CallKit call at
 * `expires_at`.
 *
 * THE ROOM CHECK. Every minute: answered calls (connecting or active) whose
 * answer is more than CONNECT_GRACE_MS old are held against their room, as
 * the provider lists it (`listRoomIdentities`). An answered call ends for
 * both when a member leaves the room, and the LiveKit webhook is what says
 * so; but a webhook can be lost (the backend answering 503 through a deploy,
 * a webhook not configured, an event LiveKit dropped) while both apps died
 * and sent no hang-up, and nothing else would ever end such a call: both
 * members would stay busy for every colleague, and the row would hold one of
 * the plan's `max_concurrent_calls` for good. So:
 *   - both members in the room: the call is on, and one still `connecting`
 *     (its `participant_joined` lost) becomes `active`;
 *   - either missing, or the room gone: it ends (completed, by the system),
 *     as the webhook would have ended it;
 *   - the provider cannot be asked: nothing is decided on a guess, except
 *     that a call answered CONNECT_MAX_MS ago that never became active — no
 *     webhook and no listing ever saw both members in its room — ends.
 * An active call the provider cannot be asked about stays until it can be:
 * the members are not held by it past teamCallPeople.ts's LIVE_CALL_MAX_AGE_MS
 * meanwhile. Ended this way, a call's minutes count to the pass that found
 * it empty, at most a minute or so past its real end.
 *
 * The leases are a duplication guard only, as for every ticker here: each
 * move is a compare-and-set (a miss on `state = 'ringing'` and on the ring
 * being over, an end on the live state it read), so a second replica's pass,
 * a read that found the call expired first (GET /api/team-calls/:id, a late
 * answer), an answer in the ring's last instant or a webhook arriving during
 * a room check can never move a call twice, nor miss it once answered. Which
 * is also why neither pass is in TICKER_CYCLE_SECONDS: a skipped cycle costs
 * a few seconds, never a duplicate.
 */
import type { ServerConfig } from '../config.js';
import { acquireTickerLease, releaseTickerLease } from './observability/tickerLease.js';
import { getServiceClient } from '../supabase.js';
import {
  TEAM_CALL_COLUMNS,
  TEAM_CALL_ENTRY_SOURCE,
  readTeamCallMeta,
  teamCallRingCutoff,
  type TeamCallRow,
} from './calls/teamCall.js';
import {
  expireTeamCall,
  onTeamCallRoomFinished,
  onTeamCallRoomListed,
  type TeamCallMove,
} from './calls/teamCallLifecycle.js';
import { resolveCallProvider } from './calls/providerResolver.js';
import type { CallProviderId } from './calls/providers/types.js';
import { operatorReference, parseParticipantIdentity } from './calls/operatorIdentity.js';

const RING_LEASE = 'team_call_ring';
const ROOM_LEASE = 'team_call_room';

/** Five seconds: a call stops ringing within that of its ring running out. */
const TICK_MS = 5 * 1000;
/** Once the app is serving: a call placed before a restart is missed on the first pass. */
const FIRST_RUN_MS = 15 * 1000;
/** Calls per ring pass; the rest come on the next pass (oldest first). */
const BATCH = 100;

/** A minute: an answered call nothing ended is found within about that of its room emptying. */
const ROOM_CHECK_MS = 60 * 1000;
/** After the ring pass's first run, so a restart's backlog is spread out. */
const ROOM_FIRST_RUN_MS = 30 * 1000;
/**
 * An answer this recent is not checked: both apps are still on their way
 * into the room (a cold start from a VoIP push, the caller's phone hearing of
 * the answer by its next poll).
 */
const CONNECT_GRACE_MS = 90 * 1000;
/**
 * An answered call that nothing ever saw both members in the room of (no
 * `participant_joined` for both, no listing while the provider could not be
 * asked) is not a call this long after the answer — LiveKit's own empty room
 * timeout is as long.
 */
const CONNECT_MAX_MS = 5 * 60 * 1000;
/**
 * Calls per room check, longest answered first. One listing each, a few
 * milliseconds while the provider answers; a provider that does not is asked
 * once per pass (below).
 */
const ROOM_BATCH = 200;

let ringTimer: ReturnType<typeof setInterval> | null = null;
let roomTimer: ReturnType<typeof setInterval> | null = null;

function unref(timer: ReturnType<typeof setInterval>): void {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

export function startTeamCallTicker(config: ServerConfig): void {
  if (ringTimer) return;
  setTimeout(() => void runTeamCallTickOnce(config), FIRST_RUN_MS);
  ringTimer = setInterval(() => void runTeamCallTickOnce(config), TICK_MS);
  unref(ringTimer);
  setTimeout(() => void runTeamCallRoomCheckOnce(config), ROOM_FIRST_RUN_MS);
  roomTimer = setInterval(() => void runTeamCallRoomCheckOnce(config), ROOM_CHECK_MS);
  unref(roomTimer);
}

export function stopTeamCallTicker(): void {
  if (ringTimer) clearInterval(ringTimer);
  if (roomTimer) clearInterval(roomTimer);
  ringTimer = null;
  roomTimer = null;
}

export interface TeamCallTickPass {
  /** Calls found ringing past their ring. */
  due: number;
  /** Calls this pass marked missed. */
  missed: number;
}

/** One ring pass. Exported for its tests; the timer calls it. Never throws. */
export async function runTeamCallTickOnce(config: ServerConfig): Promise<TeamCallTickPass> {
  const pass: TeamCallTickPass = { due: 0, missed: 0 };
  let leased = false;
  try {
    leased = await acquireTickerLease(config, RING_LEASE);
  } catch {
    return pass; // another replica, or a database blip: skip this pass
  }
  if (!leased) return pass;

  try {
    const { data, error } = await getServiceClient(config)
      .from('call_sessions')
      .select(TEAM_CALL_COLUMNS)
      .eq('entry_source', TEAM_CALL_ENTRY_SOURCE)
      .eq('state', 'ringing')
      .lte('created_at', teamCallRingCutoff().toISOString())
      .order('created_at', { ascending: true })
      .limit(BATCH);
    if (error) {
      console.warn('[team-call-ticker] ringing calls unreadable:', error.message);
      return pass;
    }
    for (const row of (data ?? []) as unknown as TeamCallRow[]) {
      pass.due++;
      try {
        const move = await expireTeamCall(config, row);
        if (move.moved) pass.missed++;
        await move.effects;
      } catch (err) {
        console.warn('[team-call-ticker] call not marked missed, left for the next pass:', err instanceof Error ? err.message : err);
      }
    }
    return pass;
  } catch (err) {
    console.warn('[team-call-ticker] pass failed:', err instanceof Error ? err.message : err);
    return pass;
  } finally {
    await releaseTickerLease(config, RING_LEASE).catch(() => {});
  }
}

export interface TeamCallRoomPass {
  /** Answered calls held against their room. */
  checked: number;
  /** Calls still `connecting` that the room showed both members in: now active. */
  activated: number;
  /** Calls this pass ended: a member or the room gone, or never seen in it. */
  ended: number;
}

/**
 * The call's members (user ids) in its room now, from the provider's own
 * list: a member's identity is `internal:<opaque ref>` (operatorIdentity.ts),
 * matched against the reference of each of the two members on this call.
 * Null when this call's provider has no listing; throws when it cannot be
 * asked.
 */
async function membersInRoom(config: ServerConfig, row: TeamCallRow): Promise<Set<string> | null> {
  const provider = resolveCallProvider(row.provider as CallProviderId);
  if (!provider.listRoomIdentities || !row.provider_room_id) return null;
  const identities = await provider.listRoomIdentities(config, row.provider_room_id);
  const meta = readTeamCallMeta(row);
  const members = [meta.caller_user_id, meta.callee_user_id].filter(Boolean);
  const refs = new Map(members.map((userId) => [operatorReference(config, row.id, userId), userId]));
  const present = new Set<string>();
  for (const identity of identities) {
    const parsed = parseParticipantIdentity(identity);
    const userId = (parsed.ref && refs.get(parsed.ref)) || (parsed.uuid && members.includes(parsed.uuid) ? parsed.uuid : null);
    if (userId) present.add(userId);
  }
  return present;
}

/** One room check. Exported for its tests; the timer calls it. Never throws. */
export async function runTeamCallRoomCheckOnce(config: ServerConfig, now: Date = new Date()): Promise<TeamCallRoomPass> {
  const pass: TeamCallRoomPass = { checked: 0, activated: 0, ended: 0 };
  let leased = false;
  try {
    leased = await acquireTickerLease(config, ROOM_LEASE);
  } catch {
    return pass;
  }
  if (!leased) return pass;

  try {
    const { data, error } = await getServiceClient(config)
      .from('call_sessions')
      .select(TEAM_CALL_COLUMNS)
      .eq('entry_source', TEAM_CALL_ENTRY_SOURCE)
      .in('state', ['connecting', 'active'])
      .lte('connected_at', new Date(now.getTime() - CONNECT_GRACE_MS).toISOString())
      .order('connected_at', { ascending: true })
      .limit(ROOM_BATCH);
    if (error) {
      console.warn('[team-call-ticker] answered calls unreadable:', error.message);
      return pass;
    }
    const connectCutoff = now.getTime() - CONNECT_MAX_MS;
    // One provider that does not answer is not asked again in the same pass:
    // its calls wait for the next one, with only the connecting cap applied.
    const unreachable = new Set<string>();
    for (const row of (data ?? []) as unknown as TeamCallRow[]) {
      pass.checked++;
      try {
        let inRoom: Set<string> | null = null;
        if (!unreachable.has(row.provider)) {
          try {
            inRoom = await membersInRoom(config, row);
          } catch (err) {
            unreachable.add(row.provider);
            console.warn('[team-call-ticker] room not listed:', err instanceof Error ? err.message : err);
          }
        }
        let move: TeamCallMove | null = null;
        if (inRoom) {
          move = await onTeamCallRoomListed(config, row, inRoom);
        } else if (row.state === 'connecting' && row.connected_at && Date.parse(row.connected_at) <= connectCutoff) {
          move = await onTeamCallRoomFinished(config, row.id);
        }
        if (!move) continue;
        if (move.moved && move.row.state === 'active') pass.activated++;
        else if (move.moved) pass.ended++;
        await move.effects;
      } catch (err) {
        console.warn('[team-call-ticker] answered call not checked, left for the next pass:', err instanceof Error ? err.message : err);
      }
    }
    return pass;
  } catch (err) {
    console.warn('[team-call-ticker] room check failed:', err instanceof Error ? err.message : err);
    return pass;
  } finally {
    await releaseTickerLease(config, ROOM_LEASE).catch(() => {});
  }
}
