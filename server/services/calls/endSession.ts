/**
 * Pass A — Centralized "end call" lifecycle helper.
 *
 * Single idempotent path used by every endpoint that terminates a call:
 *   - POST /api/calls/:id/end             (operator)
 *   - POST /api/calls/:id/hangup          (legacy alias, kept for back-compat)
 *   - POST /api/widget/call-invitations/:id/end (visitor)
 *
 * Responsibilities:
 *   1. Compute final duration from connected_at → started_at → created_at
 *      (whichever is the earliest known "the call existed" anchor).
 *   2. Persist ended_at, ended_by, ended_by_user_id, end_reason,
 *      duration_seconds, state='ended' — only if the row hasn't already
 *      been ended (idempotent: re-runs return the existing summary).
 *   3. Best-effort close the provider room. Failures here NEVER throw.
 *   4. Best-effort emit a `call:ended` operator event on the per-conversation
 *      channel + workspace inbox channel. Failures NEVER throw.
 *   5. Release the operator's busy-lock (clearInCall) when applicable.
 *
 * The function never throws — every result is an `EndCallSummary` so the
 * route layer can return a stable response on the very first call AND on
 * any subsequent retry from the same client.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveCallProvider } from './providerResolver.js';
import { publishOperatorEvent } from '../realtime/publish.js';
import { clearInCall } from './availability.js';

export type EndCallReason =
  | 'operator_ended'
  | 'visitor_ended'
  | 'system_ended'
  | 'failed';

export type EndCallActor = 'operator' | 'visitor' | 'system';

export interface EndCallInput {
  callId: string;
  reason: EndCallReason;
  endedBy: EndCallActor;
  /** Operator user id when endedBy === 'operator', else null. */
  endedByUserId?: string | null;
}

export interface EndCallSummary {
  ok: true;
  call_session_id: string;
  conversation_id: string | null;
  workspace_id: string;
  state: 'ended';
  ended_at: string;
  ended_by: EndCallActor;
  end_reason: EndCallReason;
  duration_seconds: number;
  /** True when this invocation actually flipped state→ended. */
  was_active: boolean;
}

export interface EndCallNotFound {
  ok: false;
  reason: 'not_found';
}

export type EndCallResult = EndCallSummary | EndCallNotFound;

function pickAnchorMs(row: any): number {
  const candidates = [row?.connected_at, row?.started_at, row?.created_at];
  for (const c of candidates) {
    if (typeof c === 'string') {
      const ms = new Date(c).getTime();
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
  }
  return Date.now();
}

function computeDuration(row: any, endedAtMs: number): number {
  const anchor = pickAnchorMs(row);
  return Math.max(0, Math.round((endedAtMs - anchor) / 1000));
}

export async function endCallSession(
  config: ServerConfig,
  input: EndCallInput,
): Promise<EndCallResult> {
  const sb = getServiceClient(config);
  try {
    // eslint-disable-next-line no-console
    console.info('[call:end] request', {
      call_id: input.callId,
      ended_by: input.endedBy,
      reason: input.reason,
    });
  } catch { /* noop */ }

  const { data: row } = await sb
    .from('call_sessions')
    .select('*')
    .eq('id', input.callId)
    .maybeSingle();
  if (!row) return { ok: false, reason: 'not_found' };

  // Idempotent path — already ended.
  if (row.state === 'ended' && row.ended_at) {
    try {
      // eslint-disable-next-line no-console
      console.info('[call:end] idempotent already ended', {
        call_id: input.callId,
        ended_by: row.ended_by,
        end_reason: row.end_reason,
      });
    } catch { /* noop */ }
    return {
      ok: true,
      call_session_id: row.id,
      conversation_id: row.context_id ?? null,
      workspace_id: row.workspace_id,
      state: 'ended',
      ended_at: row.ended_at,
      ended_by: (row.ended_by as EndCallActor) || input.endedBy,
      end_reason: (row.end_reason as EndCallReason) || input.reason,
      duration_seconds:
        typeof row.duration_seconds === 'number'
          ? row.duration_seconds
          : computeDuration(row, new Date(row.ended_at).getTime()),
      was_active: false,
    };
  }

  const endedAtMs = Date.now();
  const endedAtIso = new Date(endedAtMs).toISOString();
  const duration = computeDuration(row, endedAtMs);

  // 1. Persist ended state. Use a guarded write so two parallel hangups
  //    don't both believe they were the "first" — the second one will
  //    update zero rows and we'll just re-read the canonical summary.
  const { data: updated } = await sb
    .from('call_sessions')
    .update({
      state: 'ended',
      ended_at: endedAtIso,
      duration_seconds: duration,
      ended_by: input.endedBy,
      ended_by_user_id: input.endedByUserId ?? null,
      end_reason: input.reason,
    })
    .eq('id', input.callId)
    .neq('state', 'ended')
    .select('*')
    .maybeSingle();

  // If a parallel write won, re-read.
  let finalRow = updated;
  if (!finalRow) {
    const { data: re } = await sb
      .from('call_sessions')
      .select('*')
      .eq('id', input.callId)
      .maybeSingle();
    finalRow = re;
  }
  if (!finalRow) return { ok: false, reason: 'not_found' };

  // 2. Best-effort close the provider room.
  if (finalRow.provider_room_id) {
    try {
      const provider = resolveCallProvider(finalRow.provider);
      await provider.closeRoom(config, finalRow.provider_room_id);
    } catch {
      /* idempotent — provider may already be torn down */
    }
  }

  // 3. Best-effort: write a call_events row.
  try {
    await sb.from('call_events').insert({
      call_session_id: finalRow.id,
      event_type: 'ended',
      actor_type: input.endedBy === 'operator' ? 'operator' : input.endedBy,
      actor_id: input.endedByUserId ?? null,
      payload: { reason: input.reason, duration_seconds: finalRow.duration_seconds },
    });
  } catch { /* never block */ }

  // 4. Release operator busy-lock.
  if (input.endedBy === 'operator' && input.endedByUserId) {
    void clearInCall(config, finalRow.workspace_id, input.endedByUserId)
      .catch(() => { /* never block */ });
  }

  // 5. Realtime fan-out — operator inbox + per-conversation channel.
  if (finalRow.context_id) {
    try {
      // eslint-disable-next-line no-console
      console.info('[call:end] published call:ended', {
        inbox_channel: `ws:${finalRow.workspace_id}:inbox`,
        conv_channel: `ws:${finalRow.workspace_id}:conv:${finalRow.context_id}`,
        call_session_id: finalRow.id,
        ended_by: input.endedBy,
        duration_seconds: finalRow.duration_seconds ?? duration,
      });
    } catch { /* noop */ }
    void publishOperatorEvent(config, {
      kind: 'call:ended',
      conversation_id: finalRow.context_id,
      workspace_id: finalRow.workspace_id,
      actor_id: input.endedByUserId ?? null,
      call_session_id: finalRow.id,
      ended_by: input.endedBy,
      reason: input.reason,
      duration_seconds: finalRow.duration_seconds ?? duration,
      ended_at: finalRow.ended_at,
    } as any).catch(() => { /* publish never throws */ });
  }

  return {
    ok: true,
    call_session_id: finalRow.id,
    conversation_id: finalRow.context_id ?? null,
    workspace_id: finalRow.workspace_id,
    state: 'ended',
    ended_at: finalRow.ended_at,
    ended_by: (finalRow.ended_by as EndCallActor) || input.endedBy,
    end_reason: (finalRow.end_reason as EndCallReason) || input.reason,
    duration_seconds: finalRow.duration_seconds ?? duration,
    was_active: !!updated,
  };
}