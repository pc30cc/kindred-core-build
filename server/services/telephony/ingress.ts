/**
 * Incoming telephone call → canonical WEBYAR call session.
 *
 * Determinism and idempotency are the whole point of this module:
 *  - the workspace is resolved from the REGISTERED installation, never from
 *    anything the SIP request claims;
 *  - `telephony_calls` carries the technical dedupe key
 *    UNIQUE(installation_id, provider, sip_call_id), so every repeated
 *    provider event for the same dialog resolves to the SAME call_session;
 *  - `call_sessions` stays the single user-facing call history.
 *
 * Room naming is Core's decision: `tel_<call-session-id>_<suffix>`. The
 * gateway dials that exact name into the long-lived LiveKit SIP trunk, whose
 * reusable callee dispatch rule drops the SIP participant into that room.
 */

import { randomBytes } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { loadEffectiveCallChannels } from '../calls/controlPlane.js';
import { publishQueueEvent } from '../callCenter/realtime.js';
import { ENTRY_SOURCE_TELEPHONY } from '../../../shared/callCenter/entrySources.js';
import {
  contactMatchCandidates,
  normalizeTelephonyNumber,
} from '../../../shared/telephony/phoneNumber.js';
import { markInboundCall } from './registrations.js';
import { telephonyEvent } from './observability.js';
import type { TelephonyCallRow, TelephonyRegistrationRow } from './types.js';

export interface IncomingCallInput {
  installationId: string;
  provider: string;
  sipCallId: string;
  externalCallId?: string | null;
  callerNumber?: string | null;
  calledNumber?: string | null;
  asteriskChannelId?: string | null;
}

export interface IncomingCallResult {
  ok: true;
  reason?: undefined;
  callSessionId: string;
  roomName: string;
  workspaceId: string;
  duplicate: boolean;
}

export type IncomingCallFailure = {
  ok: false;
  reason:
    | 'unknown_installation'
    | 'installation_disabled'
    | 'voice_not_entitled'
    | 'call_create_failed';
};

function roomNameFor(callSessionId: string): string {
  return `tel_${callSessionId}_${randomBytes(4).toString('hex')}`;
}

async function loadRegistration(
  config: ServerConfig,
  installationId: string,
): Promise<TelephonyRegistrationRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('telephony_registrations')
    .select('*')
    .eq('installation_id', installationId)
    .maybeSingle();
  return (data as TelephonyRegistrationRow | null) ?? null;
}

/** Workspace-scoped contact match. Never creates a contact, never leaks across workspaces. */
async function matchContact(
  config: ServerConfig,
  workspaceId: string,
  candidates: string[],
): Promise<{ id: string; name: string | null } | null> {
  if (!candidates.length) return null;
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('contacts')
    .select('id,name,phone')
    .eq('workspace_id', workspaceId)
    .in('phone', candidates)
    .limit(1);
  const row = (data ?? [])[0] as { id: string; name: string | null } | undefined;
  return row ? { id: row.id, name: row.name ?? null } : null;
}

/**
 * Handles one inbound INVITE notification. Safe to call repeatedly with the
 * same `sip_call_id`: the second call returns the first result.
 */
export async function handleIncomingCall(
  config: ServerConfig,
  input: IncomingCallInput,
): Promise<IncomingCallResult | IncomingCallFailure> {
  const sb = getServiceClient(config);
  const registration = await loadRegistration(config, input.installationId);
  if (!registration) return { ok: false, reason: 'unknown_installation' };
  if (registration.state === 'disabled') return { ok: false, reason: 'installation_disabled' };

  const workspaceId = registration.workspace_id;

  // Idempotency first: an existing dialog short-circuits everything below.
  const { data: existing } = await sb
    .from('telephony_calls')
    .select('*')
    .eq('installation_id', input.installationId)
    .eq('provider', input.provider)
    .eq('sip_call_id', input.sipCallId)
    .maybeSingle();
  const existingRow = existing as TelephonyCallRow | null;
  if (existingRow?.call_session_id && existingRow.room_name) {
    return {
      ok: true,
      callSessionId: existingRow.call_session_id,
      roomName: existingRow.room_name,
      workspaceId,
      duplicate: true,
    };
  }

  // Canonical voice entitlement at the real call boundary (not at install time).
  const channels = await loadEffectiveCallChannels(config, workspaceId);
  if (!channels.voice_enabled) return { ok: false, reason: 'voice_not_entitled' };

  const caller = normalizeTelephonyNumber(input.callerNumber);
  const called = normalizeTelephonyNumber(input.calledNumber);
  const contact = await matchContact(config, workspaceId, contactMatchCandidates(caller));

  const telephonyMeta = {
    provider: input.provider,
    external_call_id: input.externalCallId ?? null,
    sip_call_id: input.sipCallId,
    caller_number: caller.value,
    caller_display: caller.display,
    called_number: called.value,
    sip_extension: registration.sip_extension,
    installation_id: input.installationId,
  };

  const { data: call, error: callErr } = await sb
    .from('call_sessions')
    .insert({
      workspace_id: workspaceId,
      entry_source: ENTRY_SOURCE_TELEPHONY,
      direction: 'inbound',
      call_type: 'audio',
      context_type: 'internal',
      state: 'pending',
      initiated_by_type: 'visitor',
      // `provider` keeps its MEDIA meaning; telephony provider lives in metadata.
      provider: 'livekit',
      visitor_name: contact?.name ?? null,
      visitor_phone: caller.e164 ?? caller.value,
      recording_enabled: false,
      recording_state: 'disabled',
      metadata: {
        call_center: true,
        telephony: telephonyMeta,
        contact_id: contact?.id ?? null,
      },
    })
    .select('*')
    .maybeSingle();

  if (callErr || !call) {
    telephonyEvent('telephony.call.incoming', {
      workspaceId,
      installationId: input.installationId,
      provider: input.provider,
      sipCallId: input.sipCallId,
      errorCode: 'call_create_failed',
      detail: callErr?.message,
    });
    return { ok: false, reason: 'call_create_failed' };
  }

  const roomName = roomNameFor(call.id);

  await sb.from('call_sessions').update({
    provider_room_id: roomName,
    state: 'ringing',
    metadata: { ...(call.metadata as Record<string, unknown>), telephony: { ...telephonyMeta, room_name: roomName } },
  }).eq('id', call.id);

  await sb.from('telephony_calls').upsert(
    {
      installation_id: input.installationId,
      workspace_id: workspaceId,
      provider: input.provider,
      external_call_id: input.externalCallId ?? null,
      sip_call_id: input.sipCallId,
      call_session_id: call.id,
      room_name: roomName,
      asterisk_channel_id: input.asteriskChannelId ?? null,
      caller_number: caller.value,
      called_number: called.value,
      lifecycle: 'ringing',
    },
    { onConflict: 'installation_id,provider,sip_call_id' },
  );

  // Queue entry: ring-all. No operator is pre-assigned; the winner is decided
  // by the atomic claim in `telephony_claim_call`.
  await sb.from('call_queue_entries').insert({
    workspace_id: workspaceId,
    entry_source: ENTRY_SOURCE_TELEPHONY,
    channel: 'audio',
    state: 'queued',
    call_session_id: call.id,
    contact_id: contact?.id ?? null,
    requested_by: 'visitor',
    priority: 120,
    metadata: { telephony: telephonyMeta },
  });

  await sb.from('call_events').insert({
    call_session_id: call.id,
    event_type: 'call_requested',
    actor_type: 'visitor',
    payload: { source: 'telephony', provider: input.provider },
  });

  await markInboundCall(config, input.installationId);

  // Existing Call Center realtime transport — every eligible operator rings.
  await publishQueueEvent(config, workspaceId, 'call_queued', {
    call_session_id: call.id,
    entry_source: ENTRY_SOURCE_TELEPHONY,
    channel: 'audio',
    source: 'telephony',
    telephony_provider: input.provider,
    caller_display: caller.display,
    contact_id: contact?.id ?? null,
    contact_name: contact?.name ?? null,
  });

  telephonyEvent('telephony.call.ringing', {
    workspaceId,
    installationId: input.installationId,
    provider: input.provider,
    sipCallId: input.sipCallId,
    callSessionId: call.id,
    callerNumber: caller.value,
    calledNumber: called.value,
  });

  return { ok: true, callSessionId: call.id, roomName, workspaceId, duplicate: false };
}
