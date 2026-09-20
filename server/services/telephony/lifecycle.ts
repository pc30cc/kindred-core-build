/**
 * Answer / reject / hang-up for telephony calls.
 *
 * The answer path is a SINGLE transactional database call
 * (`public.telephony_claim_call`): it locks the call row, validates the queue
 * entry, assigns the agent and moves the session forward atomically. Exactly
 * one concurrent operator can win; the others get `already_answered` (409)
 * without any side effect. There is no frontend race prevention anywhere.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { publishCallEvent, publishQueueEvent } from '../callCenter/realtime.js';
import { controlCall } from './gatewayClient.js';
import { telephonyEvent } from './observability.js';
import type { TelephonyCallRow } from './types.js';

export type ClaimFailureReason =
  | 'call_not_found'
  | 'wrong_entry_source'
  | 'call_not_active'
  | 'already_answered'
  | 'gateway_unavailable';

export type ClaimResult =
  | { ok: true; callSessionId: string; roomName: string }
  | { ok: false; reason: ClaimFailureReason };

export async function getTelephonyCallBySession(
  config: ServerConfig,
  workspaceId: string,
  callSessionId: string,
): Promise<TelephonyCallRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('telephony_calls')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('call_session_id', callSessionId)
    .maybeSingle();
  return (data as TelephonyCallRow | null) ?? null;
}

/** Atomic answer. Returns the room the operator must join. */
export async function claimTelephonyCall(
  config: ServerConfig,
  input: { workspaceId: string; callSessionId: string; agentId: string },
): Promise<ClaimResult> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('telephony_claim_call', {
    p_workspace_id: input.workspaceId,
    p_call_session_id: input.callSessionId,
    p_agent_id: input.agentId,
  });
  if (error) {
    telephonyEvent('telephony.gateway.error', {
      workspaceId: input.workspaceId,
      callSessionId: input.callSessionId,
      errorCode: 'claim_failed',
      detail: error.message,
    });
    return { ok: false, reason: 'already_answered' };
  }

  const result = (data ?? {}) as { ok?: boolean; reason?: ClaimFailureReason };
  if (!result.ok) return { ok: false, reason: result.reason ?? 'already_answered' };

  const telCall = await getTelephonyCallBySession(config, input.workspaceId, input.callSessionId);
  if (!telCall?.room_name) return { ok: false, reason: 'call_not_found' };

  // Bridge the SIP leg into the room Core already chose.
  const control = await controlCall(config, {
    installationId: telCall.installation_id,
    sipCallId: telCall.sip_call_id,
    action: 'answer',
    roomName: telCall.room_name,
  });
  if (!control.ok) {
    await failCall(config, input.workspaceId, input.callSessionId, 'gateway_unavailable');
    return { ok: false, reason: 'gateway_unavailable' };
  }

  await sb.from('call_sessions').update({
    state: 'active',
    started_at: new Date().toISOString(),
    connected_at: new Date().toISOString(),
  }).eq('id', input.callSessionId);

  await sb.from('telephony_calls').update({ lifecycle: 'connected' }).eq('id', telCall.id);

  await sb.from('call_events').insert({
    call_session_id: input.callSessionId,
    event_type: 'call_accepted',
    actor_type: 'operator',
    payload: { agent_id: input.agentId },
  });

  // Every other operator's UI stops ringing on this broadcast.
  await publishQueueEvent(config, input.workspaceId, 'call_accepted', {
    call_session_id: input.callSessionId,
    accepted_by: input.agentId,
    source: 'telephony',
  });
  await publishCallEvent(config, input.workspaceId, input.callSessionId, 'call_accepted', {
    accepted_by: input.agentId,
    room: telCall.room_name,
  });

  telephonyEvent('telephony.call.answered', {
    workspaceId: input.workspaceId,
    callSessionId: input.callSessionId,
    installationId: telCall.installation_id,
    provider: telCall.provider,
    sipCallId: telCall.sip_call_id,
  });

  return { ok: true, callSessionId: input.callSessionId, roomName: telCall.room_name };
}

async function closeSession(
  config: ServerConfig,
  workspaceId: string,
  callSessionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const sb = getServiceClient(config);
  // Idempotent: a terminal session is never re-ended.
  await sb
    .from('call_sessions')
    .update({ ...patch, ended_at: new Date().toISOString() })
    .eq('id', callSessionId)
    .eq('workspace_id', workspaceId)
    .not('state', 'in', '("ended","failed","cancelled","missed")');

  await sb
    .from('call_queue_entries')
    .update({ state: 'cancelled', ended_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('call_session_id', callSessionId)
    .in('state', ['queued', 'offered']);
}

export async function rejectTelephonyCall(
  config: ServerConfig,
  input: { workspaceId: string; callSessionId: string; actorId?: string | null },
): Promise<{ ok: boolean }> {
  const telCall = await getTelephonyCallBySession(config, input.workspaceId, input.callSessionId);
  if (telCall) {
    await controlCall(config, {
      installationId: telCall.installation_id,
      sipCallId: telCall.sip_call_id,
      action: 'reject',
    });
    await getServiceClient(config).from('telephony_calls').update({ lifecycle: 'rejected' }).eq('id', telCall.id);
  }
  await closeSession(config, input.workspaceId, input.callSessionId, {
    state: 'ended',
    ended_by: 'operator',
    ended_by_user_id: input.actorId ?? null,
    end_reason: 'operator_ended',
  });
  await publishQueueEvent(config, input.workspaceId, 'call_rejected', {
    call_session_id: input.callSessionId,
    source: 'telephony',
  });
  telephonyEvent('telephony.call.rejected', {
    workspaceId: input.workspaceId,
    callSessionId: input.callSessionId,
    provider: telCall?.provider ?? null,
  });
  return { ok: true };
}

export async function hangupTelephonyCall(
  config: ServerConfig,
  input: { workspaceId: string; callSessionId: string; actorId?: string | null; by?: 'operator' | 'system' },
): Promise<{ ok: boolean }> {
  const telCall = await getTelephonyCallBySession(config, input.workspaceId, input.callSessionId);
  if (telCall) {
    await controlCall(config, {
      installationId: telCall.installation_id,
      sipCallId: telCall.sip_call_id,
      action: 'hangup',
    });
  }
  await endTelephonyCall(config, {
    workspaceId: input.workspaceId,
    callSessionId: input.callSessionId,
    endedBy: input.by ?? 'operator',
    actorId: input.actorId ?? null,
  });
  return { ok: true };
}

/**
 * Terminal convergence point. Whether the PSTN side, LiveKit or the operator
 * ended the call, every path lands here and the result is the same — running
 * it twice changes nothing.
 */
export async function endTelephonyCall(
  config: ServerConfig,
  input: {
    workspaceId: string;
    callSessionId: string;
    endedBy: 'operator' | 'visitor' | 'system';
    actorId?: string | null;
    reason?: string | null;
  },
): Promise<void> {
  const sb = getServiceClient(config);
  await closeSession(config, input.workspaceId, input.callSessionId, {
    state: 'ended',
    ended_by: input.endedBy,
    ended_by_user_id: input.actorId ?? null,
    end_reason:
      input.endedBy === 'operator' ? 'operator_ended' : input.endedBy === 'visitor' ? 'visitor_ended' : 'system_ended',
  });
  await sb
    .from('telephony_calls')
    .update({ lifecycle: 'ended' })
    .eq('workspace_id', input.workspaceId)
    .eq('call_session_id', input.callSessionId);

  await sb.from('call_events').insert({
    call_session_id: input.callSessionId,
    event_type: 'call_ended',
    actor_type: input.endedBy === 'operator' ? 'operator' : 'system',
    payload: { source: 'telephony', reason: input.reason ?? null },
  });

  await publishQueueEvent(config, input.workspaceId, 'call_ended', {
    call_session_id: input.callSessionId,
    source: 'telephony',
  });
  await publishCallEvent(config, input.workspaceId, input.callSessionId, 'call_ended', {
    ended_by: input.endedBy,
  });

  telephonyEvent('telephony.call.ended', {
    workspaceId: input.workspaceId,
    callSessionId: input.callSessionId,
    detail: input.reason ?? null,
  });
}

async function failCall(
  config: ServerConfig,
  workspaceId: string,
  callSessionId: string,
  reason: string,
): Promise<void> {
  await closeSession(config, workspaceId, callSessionId, {
    state: 'failed',
    ended_by: 'system',
    end_reason: 'failed',
  });
  telephonyEvent('telephony.gateway.error', { workspaceId, callSessionId, errorCode: reason });
}
