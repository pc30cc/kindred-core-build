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
 * So, once a minute (queueTicker.ts), a call of any entry source but a
 * colleague call (whose room check is teamCallTicker.ts) that is still
 * `connecting`, with no `connected_at`, created more than
 * STALE_CONNECTING_CALL_MS ago:
 *   - is held against its room, as the provider lists it
 *     (`listRoomIdentities`): anyone in the room, and the call is real (its
 *     webhooks were lost), so it is left alone; the room empty or gone, and
 *     nobody is in the call;
 *   - a call without a room (its room was never made) has nobody in it;
 *   - a provider that cannot be asked, or that has no listing, decides
 *     nothing: the call waits (it may be a call in progress whose webhooks
 *     this provider never sends);
 * and a call with nobody in it becomes `failed` (ended by the system,
 * `end_reason` 'failed'), from `connecting` with no `connected_at` only (a
 * compare-and-set: a join or a hang-up in between wins). That is what the
 * code does for a join that never happened (widgetCallInvitations.ts), and
 * it bills nothing: tg_call_sessions_bill_minutes adds minutes on a move into
 * `ended` only, and never for a call that was not connected. Then the room is
 * closed, the operators' in-call markers and the call-centre operator's count
 * are cleared, and `call:ended` is published as an ended call publishes it,
 * so every panel and the widget drop the call.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveCallProvider } from './providerResolver.js';
import type { CallProviderId } from './providers/types.js';
import { syncAgentActiveCallCount } from './callStateGuards.js';
import { clearInCall } from './availability.js';
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
  try {
    const { data: parts } = await sb
      .from('call_participants')
      .select('participant_id, participant_type')
      .eq('call_session_id', row.id);
    for (const p of (parts ?? []) as Array<{ participant_type?: string; participant_id?: string | null }>) {
      if (p.participant_type === 'operator' && p.participant_id) {
        await clearInCall(config, row.workspace_id, p.participant_id).catch(() => {});
      }
    }
  } catch { /* best effort */ }
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
    }).catch(() => {});
  }
  await publishCallCenterCallEvent(config, row.workspace_id, row.id, 'call_ended', {
    call_id: row.id,
    state: 'failed',
    reason: 'stale_connecting',
  });
}

/** One pass. Exported for its tests; the call queue's ticker runs it. Never throws. */
export async function sweepStaleConnectingCalls(config: ServerConfig, now: number = Date.now()): Promise<StaleConnectingPass> {
  const pass: StaleConnectingPass = { checked: 0, failed: 0, kept: 0 };
  const sb = getServiceClient(config);
  const createdBefore = new Date(now - STALE_CONNECTING_CALL_MS).toISOString();
  const { data, error } = await sb
    .from('call_sessions')
    .select('id, workspace_id, provider, provider_room_id, context_type, context_id, assigned_agent_id')
    .eq('state', 'connecting')
    .is('connected_at', null)
    .neq('entry_source', 'team_call')
    .lt('created_at', createdBefore)
    .order('created_at', { ascending: true })
    .limit(STALE_CONNECTING_BATCH);
  if (error || !data) return pass;

  // A provider that does not answer is not asked again in the same pass.
  const unreachable = new Set<string>();
  for (const row of data as StaleConnectingRow[]) {
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
