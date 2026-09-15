/**
 * Call Center — operator-controlled recording start/stop (CC-2F).
 *
 * Standalone Call Center only (entry_source = 'call_widget').
 * Never reaches into chat-call recording flow in routes/calls.ts.
 *
 * STRICT:
 *   - Fail-closed if recording capability is not effectively enabled.
 *   - Never returns or persists storage paths, signed URLs, or provider secrets.
 *   - Only the internal recording_id (provider opaque handle) is stored.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveEffectiveCallProvider } from '../calls/providerResolver.js';
import {
  computeRecordingCapability,
  type RecordingCapability,
} from './recording.js';
import {
  getOrCreateWorkspaceSettings,
  getPlatformCallCenterSettings,
} from './settings.js';
import { checkEntitlementFromDB } from '../../middleware/featureGating.js';
import { resolveUsage } from '../billing/usageResolvers.js';
import { CallProviderNotReadyError } from '../calls/providers/types.js';
import { mustDb } from '../../utils/mustDb.js';

export type RecordingType = 'composite' | 'individual' | 'audio_only';

export type RecordingControlError =
  | 'not_found'
  | 'wrong_entry_source'
  | 'recording_disabled'
  | 'recording_consent_missing'
  | 'provider_not_supported'
  | 'provider_not_configured'
  | 'room_not_ready'
  | 'recording_not_active'
  | 'recording_finalizing'
  | 'recording_start_failed'
  | 'recording_stop_failed'
  | 'recording_count_limit_reached'
  | 'recording_storage_limit_reached';

export class RecordingControlException extends Error {
  constructor(
    public readonly code: RecordingControlError,
    public readonly httpStatus: number,
    message?: string,
  ) {
    super(message || code);
    this.name = 'RecordingControlException';
  }
}

interface CallRow {
  id: string;
  workspace_id: string;
  state: string;
  entry_source: string | null;
  provider: string | null;
  provider_room_id: string | null;
  recording_enabled: boolean;
  recording_state: string;
  metadata: Record<string, unknown>;
}

async function loadCall(
  config: ServerConfig,
  workspaceId: string,
  callId: string,
): Promise<CallRow> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('call_sessions')
    .select('id,workspace_id,state,entry_source,provider,provider_room_id,recording_enabled,recording_state,metadata')
    .eq('id', callId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!data) throw new RecordingControlException('not_found', 404);
  if (data.entry_source !== 'call_widget') {
    throw new RecordingControlException('wrong_entry_source', 403);
  }
  return data as CallRow;
}

async function loadCapability(
  config: ServerConfig,
  workspaceId: string,
): Promise<RecordingCapability> {
  const platform = await getPlatformCallCenterSettings(config);
  const ws = await getOrCreateWorkspaceSettings(config, workspaceId);
  return computeRecordingCapability(config, workspaceId, platform, ws);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function errCode(e: unknown): string | undefined {
  return e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function maskRecordingId(id: string | null | undefined): string | null {
  if (!id) return null;
  const s = String(id);
  if (s.length <= 8) return s.slice(0, 2) + '…';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

function recMeta(call: CallRow): Record<string, unknown> {
  const m = call.metadata || {};
  return (m.recording as Record<string, unknown>) || {};
}

/**
 * Sixth corrective pass, P0: real Supabase/PostgREST resolves a failed
 * query as `{ data, error }`, not a thrown exception. This function backs
 * BOTH `onStarting` (the durable phase-1 'pending' intent, written before
 * LiveKit's StartRoomCompositeEgress is ever called) and
 * `persistRecordingStart` (`onStarted`, the post-start recording_id
 * write) for the Call Center recording flow — an unchecked `.error` here
 * defeats the entire two-phase durable-intent design: the caller would
 * believe persistence succeeded (setting `persisted=true`, or letting
 * StartRoomCompositeEgress proceed as if the phase-1 marker exists) when
 * in fact nothing was ever recorded. Both the metadata read and the
 * update now throw on `.error` via `mustDb`, so a failure here propagates
 * exactly like a thrown exception always has — including into
 * livekitProvider.ts's `onStarted` catch block, which is what triggers
 * its compensating `StopEgress` call.
 */
async function patchRecordingMeta(
  config: ServerConfig,
  callId: string,
  patch: Record<string, unknown>,
  topLevel: Record<string, unknown> = {},
): Promise<void> {
  const sb = getServiceClient(config);
  const prev = await mustDb(
    await sb.from('call_sessions').select('metadata').eq('id', callId).maybeSingle(),
    'call_sessions.select:patchRecordingMeta',
  );
  const meta = (prev?.metadata as Record<string, unknown>) || {};
  const recording = { ...((meta.recording as Record<string, unknown>) || {}), ...patch };
  await mustDb(
    await sb
      .from('call_sessions')
      .update({ ...topLevel, metadata: { ...meta, recording } })
      .eq('id', callId),
    'call_sessions.update:patchRecordingMeta',
  );
}

async function logEvent(
  config: ServerConfig,
  workspaceId: string,
  callId: string,
  eventType:
    | 'recording_start_requested'
    | 'recording_started'
    | 'recording_stop_requested'
    | 'recording_stopped'
    | 'recording_failed',
  actorId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  const sb = getServiceClient(config);
  try {
    await sb.from('call_events').insert({
      call_session_id: callId,
      event_type: eventType,
      actor_type: actorId ? 'operator' : 'system',
      actor_id: actorId,
      payload,
    });
  } catch { /* best-effort */ }
  // Realtime publish intentionally omitted: realtime.ts CallCenterEventType is
  // a closed set; recording_* events are persisted to call_events for the
  // detail timeline and do not need cross-tab fan-out in this pass.
  void workspaceId;
}

export interface StartArgs {
  workspaceId: string;
  callId: string;
  actorUserId: string;
  recordingType?: RecordingType;
}

export interface StartResult {
  ok: true;
  recording_state: 'recording' | 'pending';
  recording_id_masked: string;
  has_artifact: true;
  provider: string;
  started_at: string;
  idempotent?: boolean;
}

export async function startCallCenterRecording(
  config: ServerConfig,
  args: StartArgs,
): Promise<StartResult> {
  const call = await loadCall(config, args.workspaceId, args.callId);

  // Idempotent: already recording.
  if (call.recording_state === 'recording') {
    const meta = recMeta(call);
    const rid = String(meta.recording_id || '');
    if (rid) {
      return {
        ok: true,
        recording_state: 'recording',
        recording_id_masked: maskRecordingId(rid)!,
        has_artifact: true,
        provider: String(call.provider || meta.provider || ''),
        started_at: String(meta.started_at || ''),
        idempotent: true,
      };
    }
  }
  if (call.recording_state === 'finalizing') {
    throw new RecordingControlException('recording_finalizing', 409);
  }

  // Capability + consent gating.
  const cap = await loadCapability(config, args.workspaceId);
  if (!cap.effective_enabled) {
    if (cap.reason === 'provider_not_supported') {
      throw new RecordingControlException('provider_not_supported', 409);
    }
    if (cap.reason === 'provider_not_configured') {
      throw new RecordingControlException('provider_not_configured', 409);
    }
    throw new RecordingControlException('recording_disabled', 409);
  }
  const meta = recMeta(call);
  if (cap.consent_required && !meta.consent_given) {
    throw new RecordingControlException('recording_consent_missing', 409);
  }

  // Plan-level numeric ceilings — count + storage. Lifetime occupancy
  // semantics (deletes free capacity). -1 = unlimited.
  try {
    const countEnt = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      args.workspaceId,
      'max_call_recordings',
    );
    if (countEnt.limit !== undefined && countEnt.limit !== -1) {
      const usage = await resolveUsage(config, args.workspaceId, 'max_call_recordings');
      if (usage.supported && usage.value >= countEnt.limit) {
        throw new RecordingControlException(
          'recording_count_limit_reached',
          403,
          `limit=${countEnt.limit} used=${usage.value}`,
        );
      }
    }
    const sizeEnt = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      args.workspaceId,
      'max_call_recording_storage_mb',
    );
    if (sizeEnt.limit !== undefined && sizeEnt.limit !== -1) {
      const usage = await resolveUsage(config, args.workspaceId, 'max_call_recording_storage_mb');
      if (usage.supported && usage.value >= sizeEnt.limit) {
        throw new RecordingControlException(
          'recording_storage_limit_reached',
          403,
          `limit_mb=${sizeEnt.limit} used_mb=${usage.value}`,
        );
      }
    }
  } catch (e: unknown) {
    if (e instanceof RecordingControlException) throw e;
    // Fail-closed on entitlement RPC errors.
    throw new RecordingControlException(
      'recording_disabled',
      403,
      `entitlement_check_failed:${errMessage(e)}`,
    );
  }

  // Room must exist + call must be in a recordable state.
  if (!call.provider_room_id) {
    throw new RecordingControlException('room_not_ready', 409);
  }
  if (!['active', 'ringing', 'connecting'].includes(call.state)) {
    throw new RecordingControlException('room_not_ready', 409);
  }

  await logEvent(config, args.workspaceId, args.callId, 'recording_start_requested', args.actorUserId, {
    recording_type: args.recordingType || 'composite',
  });

  let providerId: string;
  let handle;
  // Fourth corrective pass, P0: for a real (LiveKit) provider this
  // persistence runs INSIDE startRecording() via `onStarted`, while it
  // still holds its workspace write lease — never after the call
  // returns, which would leave a window where Egress is running but
  // nothing in the DB records it yet. `persisted` guards against a
  // redundant second write for that case while still covering a provider
  // (jitsi/agora stubs) that ignores `onStarted` entirely.
  let persisted = false;
  let startedAt = '';
  let newState: 'recording' | 'pending' = 'pending';
  const persistRecordingStart = async (h: { recordingId: string; status: string }) => {
    startedAt = new Date().toISOString();
    // LiveKit may report 'pending' or 'recording' — only flip column to
    // 'recording' when provider confirms. Pending stays as 'pending'.
    newState = h.status === 'recording' ? 'recording' : 'pending';
    await patchRecordingMeta(config, args.callId, {
      state: newState,
      started_at: startedAt,
      stopped_at: null,
      recording_id: h.recordingId,
      artifact_id: h.recordingId,
      provider: providerId,
      last_error: null,
    }, { recording_enabled: true, recording_state: newState });
    persisted = true;
  };
  try {
    const r = await resolveEffectiveCallProvider(config, args.workspaceId);
    providerId = r.id;
    handle = await r.provider.startRecording(config, call.provider_room_id, {
      recordingType: args.recordingType || 'composite',
      workspaceId: args.workspaceId,
      callSessionId: args.callId,
      // Fifth corrective pass, P0: durable phase-1 intent written BEFORE
      // the provider is asked to start — see livekitProvider.ts's
      // startRecording() doc comment for why onStarted's own
      // compensation isn't sufficient on its own.
      onStarting: async () => {
        await patchRecordingMeta(config, args.callId, {}, { recording_state: 'pending' });
      },
      onStarted: persistRecordingStart,
    });
  } catch (e: unknown) {
    // EXCEPT when the provider says reconciliation is still needed (the
    // double-failure case — Egress may still be running): clearing the
    // non-terminal marker there would hide it from
    // quiesceLiveKitEgress()'s provider-side discovery.
    if (!(e instanceof CallProviderNotReadyError && e.needsReconciliation)) {
      // Best-effort: this is cleanup after `e` was already thrown, not
      // the primary write barrier — a secondary failure here must never
      // mask the original error. Leaving the row at its current
      // non-terminal state (rather than 'failed') on a failed cleanup
      // write is also safe by design, not a regression: 'pending' stays
      // discoverable by workspaceDeletion/worker.ts's
      // findActiveEgressForRoom() reconciliation exactly like an
      // unresolved double-failure case.
      try {
        await patchRecordingMeta(config, args.callId, {
          state: 'failed',
          last_error: String(errCode(e) || errMessage(e) || 'start_failed').slice(0, 200),
        }, { recording_state: 'failed' });
      } catch { /* see comment above */ }
    }
    await logEvent(config, args.workspaceId, args.callId, 'recording_failed', args.actorUserId, {
      phase: 'start',
      message: errMessage(e).slice(0, 200),
    });
    throw new RecordingControlException('recording_start_failed', 502, errMessage(e));
  }

  if (!persisted) await persistRecordingStart(handle);

  await logEvent(config, args.workspaceId, args.callId, 'recording_started', args.actorUserId, {
    recording_id_masked: maskRecordingId(handle.recordingId),
    provider: providerId,
    state: newState,
  });

  return {
    ok: true,
    recording_state: newState,
    recording_id_masked: maskRecordingId(handle.recordingId)!,
    has_artifact: true,
    provider: providerId,
    started_at: startedAt,
  };
}

export interface StopArgs {
  workspaceId: string;
  callId: string;
  actorUserId: string;
}

export interface StopResult {
  ok: true;
  recording_state: 'finalizing' | 'available' | 'failed';
  recording_id_masked: string;
  has_artifact: true;
  stopped_at: string;
}

export async function stopCallCenterRecording(
  config: ServerConfig,
  args: StopArgs,
): Promise<StopResult> {
  const call = await loadCall(config, args.workspaceId, args.callId);
  const meta = recMeta(call);
  const rid: string = String(meta.recording_id || '');
  if (!rid || (call.recording_state !== 'recording' && call.recording_state !== 'pending')) {
    throw new RecordingControlException('recording_not_active', 409);
  }

  await logEvent(config, args.workspaceId, args.callId, 'recording_stop_requested', args.actorUserId, {
    recording_id_masked: maskRecordingId(rid),
  });

  let handle;
  try {
    const r = await resolveEffectiveCallProvider(config, args.workspaceId);
    handle = await r.provider.stopRecording(config, rid);
  } catch (e: unknown) {
    // Best-effort cleanup — see the matching comment in
    // startCallCenterRecording's catch block: a secondary persistence
    // failure here must never mask the original stop failure `e`.
    try {
      await patchRecordingMeta(config, args.callId, {
        state: 'failed',
        last_error: String(errCode(e) || errMessage(e) || 'stop_failed').slice(0, 200),
      }, { recording_state: 'failed' });
    } catch { /* see comment above */ }
    await logEvent(config, args.workspaceId, args.callId, 'recording_failed', args.actorUserId, {
      phase: 'stop',
      message: errMessage(e).slice(0, 200),
    });
    throw new RecordingControlException('recording_stop_failed', 502, errMessage(e));
  }

  const stoppedAt = new Date().toISOString();
  const newState: 'finalizing' | 'available' | 'failed' =
    handle.status === 'available' ? 'available'
      : handle.status === 'failed' ? 'failed'
      : 'finalizing';
  await patchRecordingMeta(config, args.callId, {
    state: newState,
    stopped_at: stoppedAt,
  }, { recording_state: newState });

  await logEvent(config, args.workspaceId, args.callId, 'recording_stopped', args.actorUserId, {
    recording_id_masked: maskRecordingId(rid),
    state: newState,
  });

  return {
    ok: true,
    recording_state: newState,
    recording_id_masked: maskRecordingId(rid)!,
    has_artifact: true,
    stopped_at: stoppedAt,
  };
}

export interface StatusArgs {
  workspaceId: string;
  callId: string;
}

export interface RecordingStatus {
  recording_enabled: boolean;
  recording_state: string;
  consent_given: boolean;
  consent_at: string | null;
  provider: string | null;
  recording_id_masked: string | null;
  has_artifact: boolean;
  playback_available: false;
  download_available: false;
  started_at: string | null;
  stopped_at: string | null;
  reason?: string;
  capability: {
    effective_enabled: boolean;
    consent_required: boolean;
    provider_supported: boolean;
    provider_configured: boolean;
    reason?: string;
  };
  last_error?: string | null;
}

export async function getCallCenterRecordingStatus(
  config: ServerConfig,
  args: StatusArgs,
): Promise<RecordingStatus> {
  const call = await loadCall(config, args.workspaceId, args.callId);
  const meta = recMeta(call);
  const cap = await loadCapability(config, args.workspaceId);
  const rid: string | null = meta.recording_id ? String(meta.recording_id) : null;
  return {
    recording_enabled: !!call.recording_enabled,
    recording_state: String(call.recording_state || 'disabled'),
    consent_given: !!meta.consent_given,
    consent_at: asString(meta.consent_at) || null,
    provider: asString(meta.provider) || call.provider || null,
    recording_id_masked: maskRecordingId(rid),
    has_artifact: !!rid,
    playback_available: false,
    download_available: false,
    started_at: asString(meta.started_at) || null,
    stopped_at: asString(meta.stopped_at) || null,
    reason: cap.reason,
    capability: {
      effective_enabled: cap.effective_enabled,
      consent_required: cap.consent_required,
      provider_supported: cap.provider_supported,
      provider_configured: cap.provider_configured,
      reason: cap.reason,
    },
    last_error: asString(meta.last_error) || null,
  };
}