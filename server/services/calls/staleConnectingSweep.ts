/**
 * Calls left `connecting` that nobody ever joined (2026-11-04).
 *
 * A call is `connecting` from the moment it is made for someone to join
 * (widgetCallInvitations.ts: the visitor accepted an operator's invitation)
 * until LiveKit's `room_started` makes it `active` or a visitor's join stamps
 * `connected_at` (livekitWebhook.ts). When nobody joins, or the webhook never
 * comes, nothing ended such a call: the queue's sweep (queue.ts
 * sweepStalePendingCalls) takes `pending`/`ringing` call-centre calls only.
 * The row then counted as live for ever, in every `max_concurrent_calls`
 * count (usageResolvers.ts, team_call_place, call_session_create), and held
 * its operator's in-call markers.
 *
 * So, once a minute (its own timer, one replica at a time by its lease,
 * never inside the call queue's pass), a call of any entry source but a
 * colleague call (whose room check is teamCallTicker.ts) that is still
 * `connecting`, with no `connected_at`, created more than
 * STALE_CONNECTING_CALL_MS ago:
 *   - is held against its room, as the provider lists it
 *     (`listRoomIdentities`): anyone in the room, and the call is real (its
 *     webhooks were lost), so it is left alone; the room empty or gone, and
 *     nobody is in the call;
 *   - a call without a room (its room was never made) has nobody in it;
 *   - a provider that cannot be asked decides nothing: the call waits for a
 *     later pass; a provider with no listing is never read here at all (it
 *     may be a call in progress whose webhooks this provider never sends),
 *     so such rows take no place in a pass;
 * and a call with nobody in it becomes `failed` (ended by the system,
 * `end_reason` 'failed'), from `connecting` with no `connected_at` only (a
 * compare-and-set: a join or a hang-up in between wins). That is what the
 * code does for a join that never happened (widgetCallInvitations.ts), and
 * it bills nothing: tg_call_sessions_bill_minutes adds minutes on a move into
 * `ended` only, and never for a call that was not connected. Then the room is
 * closed, the in-call markers still pointing at this call are cleared (a
 * compare-and-set: an operator now in a newer call keeps theirs), the
 * call-centre operator's count is set right, and `call:ended` goes to the
 * operators' channels only: the visitor's widget would draw a "call ended"
 * line for a call hours old, and silence a new invitation ringing then.
 *
 * Each pass reads up to STALE_CONNECTING_BATCH calls after a cursor (by id)
 * that it keeps between passes and wraps at the end, so calls it keeps (a
 * room with someone in it, an unreachable provider) never hold the newer
 * ones back.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveCallProvider } from './providerResolver.js';
import type { CallProviderId } from './providers/types.js';
import { syncAgentActiveCallCount } from './callStateGuards.js';
import { clearInCallOf } from './availability.js';
import { acquireTickerLease, releaseTickerLease } from '../observability/tickerLease.js';
import { CALL_PROVIDER_CLASSIFICATION } from './providers/types.js';
import { publishOperatorEvent } from '../realtime/publish.js';
import { publishCallEvent as publishCallCenterCallEvent } from '../callCenter/realtime.js';

/**
 * A call `connecting` this long with nobody connected is stale. A join needs
 * a token, and a token lives at most an hour (livekitTwirp.ts
 * mintParticipantToken clamps the TTL to 60..3600 s; the routes ask 600 s),
 * so twice that is well past any join that was going to happen; the room
 * listing above still guards a call that is in progress.
 */
export const STALE_CONNECTING_CALL_MS = 2 * 60 * 60_000;

/** Calls looked at per pass. */
const STALE_CONNECTING_BATCH = 200;

/** The pass's timer and its lease (one replica at a time). */
const SWEEP_MS = 60_000;
const SWEEP_FIRST_RUN_MS = 45_000;
const SWEEP_LEASE = 'call_stale_connecting';

/** Where the next pass starts (an id), kept between passes; null: the start. */
let cursor: string | null = null;

/** For tests: start the next pass from the beginning. */
export function resetStaleConnectingCursor(): void {
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

interface StaleConnectingRow {
  id: string;
  workspace_id: string;
  provider: string | null;
  provider_room_id: string | null;
  context_type: string | null;
  context_id: string | null;
  assigned_agent_id: string | null;
}

export interface StaleConnectingPass {
  /** Stale `connecting` calls looked at. */
  checked: number;
  /** Calls moved to `failed`. */
  failed: number;
  /** Calls left alone: someone in the room, or no answer from the provider. */
  kept: number;
}

/** Whether anyone is in the call's room: true, false, or null when that cannot be known. */
async function anyoneInRoom(config: ServerConfig, row: StaleConnectingRow): Promise<boolean | null> {
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

async function afterFailed(config: ServerConfig, row: StaleConnectingRow, endedAt: string): Promise<void> {
  const sb = getServiceClient(config);
  if (row.provider_room_id && row.provider) {
    try {
      await resolveCallProvider(row.provider as CallProviderId).closeRoom(config, row.provider_room_id);
    } catch { /* already gone */ }
  }
  try {
    await sb.from('call_events').insert({
      call_session_id: row.id,
      event_type: 'failed',
      actor_type: 'internal',
      actor_id: null,
      payload: { reason: 'stale_connecting' },
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
      reason: 'stale_connecting',
      duration_seconds: 0,
      ended_at: endedAt,
    }, { skipConversationChannel: true }).catch(() => {});
  }
  await publishCallCenterCallEvent(config, row.workspace_id, row.id, 'call_ended', {
    call_id: row.id,
    state: 'failed',
    reason: 'stale_connecting',
  });
}

/** One pass. Exported for its tests; startStaleConnectingSweep's timer runs it. Never throws. */
export async function sweepStaleConnectingCalls(config: ServerConfig, now: number = Date.now()): Promise<StaleConnectingPass> {
  const pass: StaleConnectingPass = { checked: 0, failed: 0, kept: 0 };
  const sb = getServiceClient(config);
  const createdBefore = new Date(now - STALE_CONNECTING_CALL_MS).toISOString();
  const providers = listableProviders();
  let q = sb
    .from('call_sessions')
    .select('id, workspace_id, provider, provider_room_id, context_type, context_id, assigned_agent_id')
    .eq('state', 'connecting')
    .is('connected_at', null)
    .neq('entry_source', 'team_call')
    .lt('created_at', createdBefore)
    .or(`provider_room_id.is.null${providers.length ? `,provider.in.(${providers.join(',')})` : ''}`);
  if (cursor) q = q.gt('id', cursor);
  const { data, error } = await q.order('id', { ascending: true }).limit(STALE_CONNECTING_BATCH);
  if (error || !data) return pass;
  // A short page is the end: the next pass starts again from the beginning.
  const rowsRead = data as StaleConnectingRow[];
  cursor = rowsRead.length < STALE_CONNECTING_BATCH ? null : rowsRead[rowsRead.length - 1].id;

  // A provider that does not answer is not asked again in the same pass.
  const unreachable = new Set<string>();
  for (const row of rowsRead) {
    pass.checked++;
    try {
      let occupied: boolean | null = null;
      if (!unreachable.has(String(row.provider))) {
        try {
          occupied = await anyoneInRoom(config, row);
        } catch (err) {
          unreachable.add(String(row.provider));
          console.warn('[calls] stale connecting call: room not listed:', err instanceof Error ? err.message : err);
        }
      }
      if (occupied !== false) { pass.kept++; continue; }

      const endedAt = new Date().toISOString();
      const { data: moved } = await sb
        .from('call_sessions')
        .update({ state: 'failed', ended_at: endedAt, ended_by: 'system', end_reason: 'failed', duration_seconds: 0 })
        .eq('id', row.id)
        .eq('state', 'connecting')
        .is('connected_at', null)
        .select('id')
        .maybeSingle();
      if (!moved) { pass.kept++; continue; }
      pass.failed++;
      await afterFailed(config, row, endedAt);
    } catch (err) {
      console.warn('[calls] stale connecting call not swept, left for the next pass:', err instanceof Error ? err.message : err);
    }
  }
  return pass;
}

/** One leased pass: on one replica at a time. Never throws. */
export async function runStaleConnectingSweepOnce(config: ServerConfig): Promise<StaleConnectingPass | null> {
  let leased = false;
  try {
    leased = await acquireTickerLease(config, SWEEP_LEASE);
  } catch {
    return null;
  }
  if (!leased) return null;
  try {
    return await sweepStaleConnectingCalls(config);
  } catch (err) {
    console.warn('[calls] stale connecting sweep failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    await releaseTickerLease(config, SWEEP_LEASE).catch(() => {});
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** The sweep's own timer, apart from the call queue's pass (server/index.ts). */
export function startStaleConnectingSweep(config: ServerConfig): void {
  if (sweepTimer) return;
  setTimeout(() => void runStaleConnectingSweepOnce(config), SWEEP_FIRST_RUN_MS).unref?.();
  sweepTimer = setInterval(() => void runStaleConnectingSweepOnce(config), SWEEP_MS);
  sweepTimer.unref?.();
}
