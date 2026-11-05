/**
 * Calls left `active` after everyone left (owner, 2026-11-05).
 *
 * A call-centre or chat call is ended by LiveKit's `room_finished`
 * (livekitWebhook.ts) when nobody hung up through the API. When that webhook
 * is lost, nothing ended the call: it stayed `active` for ever, counted in
 * every `max_concurrent_calls` count (usageResolvers.ts, team_call_place,
 * call_session_create), held its operator's in-call markers, and an end
 * written later would bill from `connected_at` to that later moment.
 *
 * The owner's rule: such a call ends at its last participant's leave. So,
 * once a minute (its own timer, one replica at a time by its lease, beside
 * staleConnectingSweep.ts and never inside the call queue's pass), a call of
 * any entry source but a colleague call (teamCallTicker.ts checks those
 * rooms) that is `active`:
 *
 *   - is read for its last sign of life (lastSignOfLife below): the latest
 *     `call_events` row of the call, `connected_at` and `started_at`, a
 *     `participant_left` for a connection the same identity's new connection
 *     replaced (DUPLICATE_IDENTITY) left out; while that is less than
 *     STALE_ACTIVE_QUIET_MS old, the call is not touched;
 *   - is held against its room, as the provider lists it
 *     (`listRoomIdentities`), exactly as staleConnectingSweep.ts does: anyone
 *     in the room and the call is real, so it is kept; the provider not
 *     answering decides nothing, so it is kept for a later pass; a provider
 *     with no listing is never read here at all; the room empty or gone (or
 *     a call without a room) and nobody is in the call;
 *   - then becomes `ended` (ended by the system, `end_reason`
 *     'system_ended'), from `active` only (a compare-and-set: a hang-up or a
 *     late `room_finished` in between wins), with `ended_at` its end time
 *     (endTimeOf below) and `duration_seconds` measured to it from
 *     `connected_at` (else `started_at`), as `room_finished` measures it.
 *
 * The end time is never the time of the pass. It is the latest real
 * `lk.participant_left` (the last participant's leave; `call_participants.
 * left_at` carries the same moment but is cleared by a rejoin and kept on one
 * row per identity, so the event log is the record read), or, if an event
 * that shows someone in the call came after it (a join whose own leave was
 * lost too), that event; with no leave recorded at all, the latest such event,
 * else `connected_at`. Only events on an allow-list count (PRESENCE_EVENTS
 * below): an operator's note or spam mark written after the people left never
 * moves the end. It is never before `connected_at`/`started_at`. tg_call_sessions_bill_minutes
 * bills CEIL((ended_at − connected_at)/60) once, on the move into `ended`,
 * and 298's trigger keeps an over call over, so a second pass or a late
 * `room_finished` bills nothing again.
 *
 * Then, as for any end: the room is closed, an `ended` call event is written,
 * the in-call markers still pointing at this call are cleared (a
 * compare-and-set: an operator now in a newer call keeps theirs), the
 * call-centre operator's count is set right, `call:ended` goes to the
 * operators' channels only (the visitor's widget would draw a "call ended"
 * line for a call long over), and the call centre's `call_ended`.
 *
 * Each pass reads up to STALE_ACTIVE_BATCH calls after a cursor (by id) that
 * it keeps between passes and wraps at the end, so calls it keeps never hold
 * the others back.
 *
 * docs/operations/CALL_SWEEPS.md describes this sweep beside the others.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveCallProvider } from './providerResolver.js';
import type { CallProviderId } from './providers/types.js';
import { CALL_PROVIDER_CLASSIFICATION } from './providers/types.js';
import { syncAgentActiveCallCount } from './callStateGuards.js';
import { clearInCallOf } from './availability.js';
import { acquireTickerLease, releaseTickerLease } from '../observability/tickerLease.js';
import { publishOperatorEvent } from '../realtime/publish.js';
import { publishCallEvent as publishCallCenterCallEvent } from '../callCenter/realtime.js';

/**
 * How long a call must show no sign of life before the sweep may end it.
 * When the last participant leaves, LiveKit closes the room after its
 * departure timeout (20 s by default) and sends `room_finished`; a room
 * nobody joined closes after `empty_timeout` (300 s, livekitProvider.ts
 * createRoom). Ten minutes is twice the longest of those, which leaves the
 * webhook (and its retries) every chance to end the call the normal way, and
 * a client that dropped and is rejoining time to be in the room again. The
 * wait costs nothing on the bill (the call ends at its last leave, not at the
 * pass), only a slot of the concurrency limit for those minutes.
 */
export const STALE_ACTIVE_QUIET_MS = 10 * 60_000;

/** Calls looked at per pass. */
const STALE_ACTIVE_BATCH = 200;
/** A call's events read for its sign of life (newest first). */
const EVENTS_READ = 500;

/** The pass's timer and its lease (one replica at a time). */
const SWEEP_MS = 60_000;
const SWEEP_FIRST_RUN_MS = 50_000;
const SWEEP_LEASE = 'call_stale_active';

/** The reason in the call event and the panels' event. */
const REASON = 'stale_active';

/** Where the next pass starts (an id), kept between passes; null: the start. */
let cursor: string | null = null;

/** For tests: start the next pass from the beginning. */
export function resetStaleActiveCursor(): void {
  cursor = null;
}

/** Providers whose rooms can be listed: only their calls (or calls without a room) are read. */
function listableProviders(): string[] {
  return (Object.keys(CALL_PROVIDER_CLASSIFICATION) as CallProviderId[]).filter((id) => {
    try {
      return typeof resolveCallProvider(id).listRoomIdentities === 'function';
    } catch {
      return false;
    }
  });
}

interface StaleActiveRow {
  id: string;
  workspace_id: string;
  provider: string | null;
  provider_room_id: string | null;
  context_type: string | null;
  context_id: string | null;
  assigned_agent_id: string | null;
  connected_at: string | null;
  started_at: string | null;
  created_at: string | null;
}

export interface CallEventRow {
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface StaleActivePass {
  /** `active` calls looked at (old enough to be read). */
  checked: number;
  /** Calls moved to `ended`. */
  ended: number;
  /** Calls left alone: a recent sign of life, someone in the room, or no answer from the provider. */
  kept: number;
}

const ms = (iso: unknown): number | null => {
  if (typeof iso !== 'string') return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

/** A `participant_left` of a connection replaced by the same identity's new one: not a leave. */
function isReplacedLeave(ev: CallEventRow): boolean {
  return ev.event_type === 'lk.participant_left' && ev.payload?.disconnect_reason === 'DUPLICATE_IDENTITY';
}

/** When the call started counting: `connected_at`, else `started_at` (as room_finished measures it). */
function anchorOf(row: Pick<StaleActiveRow, 'connected_at' | 'started_at'>): number | null {
  return ms(row.connected_at) ?? ms(row.started_at);
}

/**
 * The latest moment anything shows the call was going on, for the quiet
 * time only: every event counts here (an operator's note only delays the
 * sweep), but not for the end time (endTimeOf).
 */
export function lastSignOfLife(
  row: Pick<StaleActiveRow, 'connected_at' | 'started_at' | 'created_at'>,
  events: CallEventRow[],
): number | null {
  let latest: number | null = null;
  const take = (t: number | null) => { if (t !== null && (latest === null || t > latest)) latest = t; };
  for (const ev of events) if (!isReplacedLeave(ev)) take(ms(ev.created_at));
  take(ms(row.connected_at));
  take(ms(row.started_at));
  if (latest === null) take(ms(row.created_at));
  return latest;
}

/**
 * Events that show someone in the call, the only ones an end time is taken
 * from (an allow-list): LiveKit's room start, joins and leaves (a replaced
 * connection's leave left out), the visitor's join (callWidget.ts), the
 * operator's accept, takeover and assignment on accept (callCenter.ts) and a
 * transfer done (routing.ts). Everything else an operator may write while
 * the server still has the call live, and after the people left (a note, a
 * spam mark, a recording or transfer request), says nothing about the call
 * going on, so it never moves the end, and the bill, forward. LiveKit's
 * egress events are left out too: an egress ends when its upload is done,
 * after the room.
 */
const PRESENCE_EVENTS: ReadonlySet<string> = new Set([
  'lk.room_started',
  'lk.participant_joined',
  'lk.participant_left',
  'visitor_joined',
  'call_accepted',
  'call_assigned_on_accept',
  'call_takeover',
  'call_transferred',
]);

function isPresence(ev: CallEventRow): boolean {
  return PRESENCE_EVENTS.has(ev.event_type) && !isReplacedLeave(ev);
}

/**
 * The call's end: its last participant's leave, or a later event that shows
 * someone still in it (a join, whose leave was lost too); with no leave
 * recorded, the latest event that shows someone in it, else `connected_at`
 * (else `started_at`). Never before its anchor. Null when nothing at all is
 * known (the call is then kept).
 */
export function endTimeOf(
  row: Pick<StaleActiveRow, 'connected_at' | 'started_at' | 'created_at'>,
  events: CallEventRow[],
): { at: number; source: 'participant_left' | 'participant_joined' | 'last_sign_of_life' } | null {
  let lastLeave: number | null = null;
  let latest: { at: number; type: string } | null = null;
  for (const ev of events) {
    const t = ms(ev.created_at);
    if (t === null || !isPresence(ev)) continue;
    if (ev.event_type === 'lk.participant_left' && (lastLeave === null || t > lastLeave)) lastLeave = t;
    if (latest === null || t > latest.at) latest = { at: t, type: ev.event_type };
  }
  const anchor = anchorOf(row);
  const notBeforeAnchor = (t: number) => (anchor !== null && t < anchor ? anchor : t);
  if (latest !== null) {
    const source = lastLeave === null ? 'last_sign_of_life'
      : latest.at === lastLeave ? 'participant_left'
        : latest.type === 'lk.participant_joined' ? 'participant_joined' : 'last_sign_of_life';
    return { at: notBeforeAnchor(latest.at), source };
  }
  return anchor === null ? null : { at: anchor, source: 'last_sign_of_life' };
}

/** Whether anyone is in the call's room: true, false, or null when that cannot be known. Throws when the provider does not answer. */
async function anyoneInRoom(config: ServerConfig, row: StaleActiveRow): Promise<boolean | null> {
  if (!row.provider_room_id) return false;
  let provider;
  try {
    provider = resolveCallProvider(row.provider as CallProviderId);
  } catch {
    return null;
  }
  if (!provider.listRoomIdentities) return null;
  const identities = await provider.listRoomIdentities(config, row.provider_room_id);
  return identities.length > 0;
}

async function afterEnded(
  config: ServerConfig,
  row: StaleActiveRow,
  endedAt: string,
  durationSeconds: number,
  source: string,
): Promise<void> {
  const sb = getServiceClient(config);
  if (row.provider_room_id && row.provider) {
    try {
      await resolveCallProvider(row.provider as CallProviderId).closeRoom(config, row.provider_room_id);
    } catch { /* already gone */ }
  }
  try {
    await sb.from('call_events').insert({
      call_session_id: row.id,
      event_type: 'ended',
      actor_type: 'internal',
      actor_id: null,
      payload: { reason: REASON, end_reason: 'system_ended', ended_at: endedAt, end_time_source: source, duration_seconds: durationSeconds },
    });
  } catch { /* best effort */ }
  await clearInCallOf(config, row.workspace_id, row.id);
  if (row.assigned_agent_id) await syncAgentActiveCallCount(config, row.workspace_id, row.assigned_agent_id);
  if (row.context_type === 'conversation' && row.context_id) {
    await publishOperatorEvent(config, {
      kind: 'call:ended',
      conversation_id: row.context_id,
      workspace_id: row.workspace_id,
      actor_id: null,
      call_session_id: row.id,
      ended_by: 'system',
      reason: REASON,
      duration_seconds: durationSeconds,
      ended_at: endedAt,
    }, { skipConversationChannel: true }).catch(() => {});
  }
  await publishCallCenterCallEvent(config, row.workspace_id, row.id, 'call_ended', {
    call_id: row.id,
    state: 'ended',
    reason: REASON,
  });
}

/** One pass. Exported for its tests; startStaleActiveSweep's timer runs it. Never throws. */
export async function sweepStaleActiveCalls(config: ServerConfig, now: number = Date.now()): Promise<StaleActivePass> {
  const pass: StaleActivePass = { checked: 0, ended: 0, kept: 0 };
  const sb = getServiceClient(config);
  const quietBefore = now - STALE_ACTIVE_QUIET_MS;
  const providers = listableProviders();
  // A call created within the quiet time has a sign of life within it.
  let q = sb
    .from('call_sessions')
    .select('id, workspace_id, provider, provider_room_id, context_type, context_id, assigned_agent_id, connected_at, started_at, created_at')
    .eq('state', 'active')
    .neq('entry_source', 'team_call')
    .lt('created_at', new Date(quietBefore).toISOString())
    .or(`provider_room_id.is.null${providers.length ? `,provider.in.(${providers.join(',')})` : ''}`);
  if (cursor) q = q.gt('id', cursor);
  const { data, error } = await q.order('id', { ascending: true }).limit(STALE_ACTIVE_BATCH);
  if (error || !data) return pass;
  const rowsRead = data as StaleActiveRow[];
  cursor = rowsRead.length < STALE_ACTIVE_BATCH ? null : rowsRead[rowsRead.length - 1].id;

  const unreachable = new Set<string>();
  for (const row of rowsRead) {
    pass.checked++;
    try {
      const { data: evData, error: evError } = await sb
        .from('call_events')
        .select('event_type, payload, created_at')
        .eq('call_session_id', row.id)
        .order('created_at', { ascending: false })
        .limit(EVENTS_READ);
      if (evError) { pass.kept++; continue; }
      const events = (evData ?? []) as CallEventRow[];
      const life = lastSignOfLife(row, events);
      if (life === null || life > quietBefore) { pass.kept++; continue; }
      const end = endTimeOf(row, events);
      if (!end) { pass.kept++; continue; }

      let occupied: boolean | null = null;
      if (!unreachable.has(String(row.provider))) {
        try {
          occupied = await anyoneInRoom(config, row);
        } catch (err) {
          unreachable.add(String(row.provider));
          console.warn('[calls] stale active call: room not listed:', err instanceof Error ? err.message : err);
        }
      }
      if (occupied !== false) { pass.kept++; continue; }

      const endedAt = new Date(end.at).toISOString();
      const anchor = anchorOf(row);
      const durationSeconds = anchor === null ? 0 : Math.max(0, Math.round((end.at - anchor) / 1000));
      const { data: moved } = await sb
        .from('call_sessions')
        .update({ state: 'ended', ended_at: endedAt, ended_by: 'system', end_reason: 'system_ended', duration_seconds: durationSeconds })
        .eq('id', row.id)
        .eq('state', 'active')
        .select('id')
        .maybeSingle();
      if (!moved) { pass.kept++; continue; }
      pass.ended++;
      console.info('[calls] stale active call ended', { call_session_id: row.id, ended_at: endedAt, source: end.source });
      await afterEnded(config, row, endedAt, durationSeconds, end.source);
    } catch (err) {
      console.warn('[calls] stale active call not swept, left for the next pass:', err instanceof Error ? err.message : err);
    }
  }
  return pass;
}

/** One leased pass: on one replica at a time. Never throws. */
export async function runStaleActiveSweepOnce(config: ServerConfig): Promise<StaleActivePass | null> {
  let leased = false;
  try {
    leased = await acquireTickerLease(config, SWEEP_LEASE);
  } catch {
    return null;
  }
  if (!leased) return null;
  try {
    return await sweepStaleActiveCalls(config);
  } catch (err) {
    console.warn('[calls] stale active sweep failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    await releaseTickerLease(config, SWEEP_LEASE).catch(() => {});
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** The sweep's own timer, apart from the call queue's pass (server/index.ts). */
export function startStaleActiveSweep(config: ServerConfig): void {
  if (sweepTimer) return;
  setTimeout(() => void runStaleActiveSweepOnce(config), SWEEP_FIRST_RUN_MS).unref?.();
  sweepTimer = setInterval(() => void runStaleActiveSweepOnce(config), SWEEP_MS);
  sweepTimer.unref?.();
}
