/**
 * Phase 8B - Real LiveKit provider implementation.
 *
 * Replaces the Phase 8A stub. All methods talk to a self-hosted LiveKit
 * deployment via Twirp REST. Tokens are real HS256 JWTs signed with the
 * project's API secret.
 *
 * STRICT:
 *   - No hostnames are hardcoded. The base URL is read from
 *     livekitConfig.rtc_url (DB) and falls back to rtcResolver.getRtcBaseUrl()
 *     which itself only consults app_runtime_config + env vars.
 *   - The api_key/api_secret/webhook_secret are read from
 *     loadLiveKitConfig() and never logged.
 *   - All Twirp calls have a 10s deadline and translate failures into
 *     CallProviderNotReadyError so the resolver can fall through.
 */
import type { ServerConfig } from '../../../config.js';
import {
  type CallProvider,
  type CreateRoomInput,
  type CreateRoomResult,
  type ParticipantTokenInput,
  type ParticipantTokenResult,
  type RecordingHandle,
  type RoomState,
  CallProviderNotReadyError,
} from './types.js';
import { getRtcBaseUrl, getTurnConfig } from '../rtcResolver.js';
import { normalizeRtcBaseUrl } from '../rtcResolver.js';
import { loadLiveKitConfig, isMinimallyConfigured } from '../livekitConfig.js';
import {
  twirp,
  mintParticipantToken,
  LiveKitTwirpError,
} from '../livekitTwirp.js';
import { callRecordingKey } from '../../storage/keys.js';
import { acquireOwnerWriteLease, releaseOwnerWriteLease } from '../../storage/writerLease.js';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ResolvedLk {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
}

async function resolveLk(config: ServerConfig, forceRefresh = false): Promise<ResolvedLk> {
  const cfg = await loadLiveKitConfig(config, forceRefresh);
  if (!isMinimallyConfigured(cfg)) {
    throw new CallProviderNotReadyError(
      'livekit',
      'LiveKit is not configured (api_key / api_secret / rtc_url required).',
    );
  }
  // Prefer the explicit livekit_config.rtc_url; fall back to the centralised
  // RTC resolver (which itself reads app_runtime_config / env).
  // The Twirp REST client requires http(s):// — normalize aggressively so a
  // misconfigured wss://host or trailing /rtc doesn't break the call hot
  // path. See normalizeRtcBaseUrl() in rtcResolver.ts.
  const rawBase = cfg.rtc_url || (await getRtcBaseUrl(config));
  const baseUrl = normalizeRtcBaseUrl(rawBase);
  if (!baseUrl) {
    throw new CallProviderNotReadyError(
      'livekit',
      'LiveKit RTC base URL is not configured.',
    );
  }
  return { baseUrl, apiKey: cfg.api_key as string, apiSecret: cfg.api_secret as string };
}

function deterministicRoomName(workspaceId: string, callSessionId: string): string {
  return 'gs_' + workspaceId.slice(0, 8) + '_' + callSessionId.slice(0, 12);
}

export async function probeLiveKitProvisioning(config: ServerConfig): Promise<{
  roomName: string;
  latencyMs: number;
  rtcUrl: string;
}> {
  const startedAt = Date.now();
  const { baseUrl, apiKey, apiSecret } = await resolveLk(config, true);
  const roomName = '__healthcheck_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  try {
    await twirp({
      baseUrl,
      apiKey,
      apiSecret,
      service: 'livekit.RoomService',
      method: 'CreateRoom',
      body: {
        name: roomName,
        empty_timeout: 30,
        max_participants: 2,
        metadata: JSON.stringify({ probe: true }),
      },
    });
  } catch (err) {
    if (err instanceof LiveKitTwirpError) {
      throw new CallProviderNotReadyError(
        'livekit',
        'LiveKit provisioning failed: ' + err.code + ' / ' + err.message,
      );
    }
    throw err;
  }

  try {
    await twirp({
      baseUrl,
      apiKey,
      apiSecret,
      service: 'livekit.RoomService',
      method: 'DeleteRoom',
      body: { room: roomName },
      room: roomName,
    });
  } catch {
    // The probe has already proven room allocation works; cleanup is best-effort.
  }

  return {
    roomName,
    latencyMs: Date.now() - startedAt,
    rtcUrl: baseUrl,
  };
}

// ─── Pass 1: Cached real readiness ───────────────────────────────────────
// `isReady()` is hit on every call setup, so it must remain cheap. But the
// admin readiness endpoint and the call diagnostics endpoint need a TRUE
// answer — i.e. "can LiveKit actually mint and tear down a probe room
// right now?". This wrapper caches the live-probe result for 30s so admin
// pages can poll it without DDoSing the SFU, while keeping the call hot
// path on the lightweight config-presence check.

export interface LiveKitReadinessState {
  ready: boolean;
  configured: boolean;
  rtcUrl: string | null;
  /** Last probe timestamp (ms) — null if no probe ever ran. */
  lastProbeAt: number | null;
  /** Probe latency in ms when ready === true. */
  latencyMs: number | null;
  /** Error code surfaced by the provider when ready === false. */
  errorCode: string | null;
  errorMessage: string | null;
}

const READINESS_TTL_MS = 30_000;
let cachedReadiness: { value: LiveKitReadinessState; loadedAt: number } | null = null;
let inflightProbe: Promise<LiveKitReadinessState> | null = null;

export function invalidateLiveKitReadinessCache(): void {
  cachedReadiness = null;
}

export async function getLiveKitReadinessState(
  config: ServerConfig,
  opts: { forceRefresh?: boolean } = {},
): Promise<LiveKitReadinessState> {
  if (
    !opts.forceRefresh &&
    cachedReadiness &&
    Date.now() - cachedReadiness.loadedAt < READINESS_TTL_MS
  ) {
    return cachedReadiness.value;
  }
  if (inflightProbe) return inflightProbe;
  inflightProbe = (async () => {
    let cfg;
    try {
      cfg = await loadLiveKitConfig(config, true);
    } catch (err: unknown) {
      const v: LiveKitReadinessState = {
        ready: false,
        configured: false,
        rtcUrl: null,
        lastProbeAt: Date.now(),
        latencyMs: null,
        errorCode: 'config_load_failed',
        errorMessage: err instanceof Error ? err.message : 'Failed to load LiveKit config',
      };
      cachedReadiness = { value: v, loadedAt: Date.now() };
      return v;
    }
    if (!isMinimallyConfigured(cfg)) {
      const v: LiveKitReadinessState = {
        ready: false,
        configured: false,
        rtcUrl: cfg.rtc_url ?? null,
        lastProbeAt: Date.now(),
        latencyMs: null,
        errorCode: 'not_configured',
        errorMessage:
          'LiveKit is not configured (enabled / api_key / api_secret / rtc_url all required).',
      };
      cachedReadiness = { value: v, loadedAt: Date.now() };
      return v;
    }
    try {
      const probe = await probeLiveKitProvisioning(config);
      const v: LiveKitReadinessState = {
        ready: true,
        configured: true,
        rtcUrl: probe.rtcUrl,
        lastProbeAt: Date.now(),
        latencyMs: probe.latencyMs,
        errorCode: null,
        errorMessage: null,
      };
      cachedReadiness = { value: v, loadedAt: Date.now() };
      return v;
    } catch (err: unknown) {
      const code = err instanceof CallProviderNotReadyError ? 'provider_not_ready' : 'probe_failed';
      const v: LiveKitReadinessState = {
        ready: false,
        configured: true,
        rtcUrl: cfg.rtc_url ?? null,
        lastProbeAt: Date.now(),
        latencyMs: null,
        errorCode: code,
        errorMessage: err instanceof Error ? err.message : 'LiveKit probe failed',
      };
      cachedReadiness = { value: v, loadedAt: Date.now() };
      return v;
    }
  })().finally(() => { inflightProbe = null; });
  return inflightProbe;
}

export const livekitProvider: CallProvider = {
  id: 'livekit',

  supportsAudio: () => true,
  supportsVideo: () => true,
  supportsScreenShare: () => true,
  supportsRecording: () => true,

  async isReady(config) {
    try {
      // Force-refresh so the readiness probe never reports a stale "not ready"
      // when the admin has just saved credentials. The 30s in-process cache is
      // still used by the hot path (createRoom / token mint) below.
      const cfg = await loadLiveKitConfig(config, true);
      if (!isMinimallyConfigured(cfg)) return false;
      // Treat config presence as readiness; we don't ping LiveKit on every
      // resolver pass to keep the call hot path fast.
      return true;
    } catch {
      return false;
    }
  },

  async createRoom(config, input: CreateRoomInput): Promise<CreateRoomResult> {
    const { baseUrl, apiKey, apiSecret } = await resolveLk(config, true);
    const roomName = deterministicRoomName(input.workspaceId, input.callSessionId);
    const cfg = await loadLiveKitConfig(config, true);
    const maxParticipants = Math.max(2, Math.min(input.maxParticipants, 100));
    try {
      await twirp({
        baseUrl,
        apiKey,
        apiSecret,
        service: 'livekit.RoomService',
        method: 'CreateRoom',
        body: {
          name: roomName,
          empty_timeout: 300, // 5 min before LiveKit GCs an empty room
          max_participants: maxParticipants,
          metadata: JSON.stringify({
            workspace_id: input.workspaceId,
            call_session_id: input.callSessionId,
            call_type: input.callType,
            recording_enabled: input.recordingEnabled,
            ...(input.metadata || {}),
          }),
        },
      });
    } catch (err) {
      if (err instanceof LiveKitTwirpError && err.code === 'already_exists') {
        // Idempotent - room already exists, that's fine.
      } else if (err instanceof LiveKitTwirpError) {
        throw new CallProviderNotReadyError(
          'livekit',
          'LiveKit createRoom failed: ' + err.code + ' / ' + err.message,
        );
      } else {
        throw err;
      }
    }
    return {
      providerRoomId: roomName,
      metadata: {
        max_participants: maxParticipants,
        recording_enabled: input.recordingEnabled,
        region: cfg.region ?? null,
      },
    };
  },

  async closeRoom(config, providerRoomId): Promise<void> {
    const { baseUrl, apiKey, apiSecret } = await resolveLk(config);
    try {
      await twirp({
        baseUrl,
        apiKey,
        apiSecret,
        service: 'livekit.RoomService',
        method: 'DeleteRoom',
        body: { room: providerRoomId },
        room: providerRoomId,
      });
    } catch (err) {
      // Room may already be gone; never throw on close.
      if (err instanceof LiveKitTwirpError && err.code !== 'not_found') {
        // Swallow, but surface to caller logs via console.warn once.
        console.warn('[livekit] closeRoom soft-failed:', err.code, err.message);
      }
    }
  },

  async createParticipantToken(
    config,
    input: ParticipantTokenInput,
  ): Promise<ParticipantTokenResult> {
    const { apiKey, apiSecret } = await resolveLk(config);
    const identity = input.participantType + ':' + input.participantId;
    const { token, expiresAt } = mintParticipantToken({
      apiKey,
      apiSecret,
      identity,
      name: input.displayName ?? input.participantId,
      room: input.providerRoomId,
      ttlSeconds: input.ttlSeconds,
      canPublish: input.canPublish,
      canSubscribe: input.canSubscribe,
      canPublishData: input.canPublishData,
      metadata: JSON.stringify({
        call_session_id: input.callSessionId,
        participant_type: input.participantType,
      }),
    });
    return { token, expiresAt };
  },

  async revokeParticipant(config, providerRoomId, providerParticipantId): Promise<void> {
    const { baseUrl, apiKey, apiSecret } = await resolveLk(config);
    try {
      await twirp({
        baseUrl,
        apiKey,
        apiSecret,
        service: 'livekit.RoomService',
        method: 'RemoveParticipant',
        body: { room: providerRoomId, identity: providerParticipantId },
        room: providerRoomId,
      });
    } catch (err) {
      if (err instanceof LiveKitTwirpError && err.code === 'not_found') return;
      throw err;
    }
  },

  async startRecording(config, providerRoomId, opts): Promise<RecordingHandle> {
    // Fourth corrective pass, P0: a point-in-time isWorkspaceWritable()
    // check (third pass) still left a TOCTOU gap — deletion could begin
    // in the window between that check returning true and
    // StartRoomCompositeEgress actually completing, and workspaceDeletion/
    // worker.ts's quiesce step had nothing to find (no call_sessions row
    // yet says Egress is running) until this function's caller persisted
    // it, well after the external write had already started. An
    // owner_write_lease (writerLease.ts) closes this: acquisition is
    // atomic with the SAME writability check (187_owner_write_leases.sql),
    // and the lease is held through BOTH the Egress start call AND the
    // caller's durable persistence of recording_id/recording_state (via
    // `opts.onStarted`, called below while still holding the lease) —
    // not just released the instant this function returns. A deletion
    // worker that starts while this lease is outstanding sees it and
    // waits before ever running quiesceLiveKitEgress() or touching any
    // storage scope — see workspaceDeletion/worker.ts's doc comment.
    const lease = await acquireOwnerWriteLease(config, 'workspace', opts.workspaceId, 'livekit_recording_start');
    if (!lease.ok || !lease.leaseId || !lease.leaseToken) {
      throw new CallProviderNotReadyError('livekit', 'Workspace is being deleted; recording is disabled.');
    }
    const leaseId = lease.leaseId;
    const leaseToken = lease.leaseToken;
    let releaseLeaseNow = true;

    try {
      // Fifth corrective pass, P0: a DURABLE recording-start intent must
      // exist BEFORE StartRoomCompositeEgress is ever called — not just
      // after it returns (opts.onStarted, below). If Egress starts but
      // BOTH the post-start persistence AND its compensating stop fail
      // (the double-failure case handled further down), this phase-1
      // marker is what lets workspaceDeletion/worker.ts's
      // quiesceLiveKitEgress() discover the call still needs
      // reconciling — via LiveKit's own ListEgress — even though it has
      // no recording_id to go on. Both real call sites persist this as
      // recording_state='pending' (an EXISTING, already-non-terminal enum
      // value — see findNonTerminalRecordings()'s doc comment) with no
      // recording_id yet; opts.onStarted upgrades it once the egress_id
      // is known. A provider with no lease concept may ignore this.
      if (opts.onStarting) {
        await opts.onStarting();
      }

      const { baseUrl, apiKey, apiSecret } = await resolveLk(config);
      const cfg = await loadLiveKitConfig(config);
      if (!cfg.egress_enabled) {
        throw new CallProviderNotReadyError('livekit', 'LiveKit egress is disabled in config.');
      }
      const storage = cfg.recording_storage;
      if (!storage.bucket || !storage.access_key || !storage.secret_key) {
        throw new CallProviderNotReadyError(
          'livekit',
          'LiveKit recording storage (bucket / access_key / secret_key) is not configured.',
        );
      }
      // S3 / S3-compatible output. LiveKit Egress accepts the same fields for
      // any provider (R2, MinIO, etc.) by setting `endpoint` and `force_path_style`.
      // Canonical workspace-scoped key — see docs/STORAGE_ARCHITECTURE_AUDIT.md
      // §11. The webhook validates the filename LiveKit actually reports
      // against this same prefix before it's ever persisted (fail closed).
      const filepath = callRecordingKey({
        workspaceId: opts.workspaceId,
        callSessionId: opts.callSessionId,
        fileName: `${Date.now()}.mp4`,
      });
      const body: Record<string, unknown> = {
        room_name: providerRoomId,
        file_outputs: [
          {
            file_type: 'MP4',
            filepath,
            s3: {
              access_key: storage.access_key,
              secret: storage.secret_key,
              bucket: storage.bucket,
              region: storage.region ?? '',
              ...(storage.endpoint ? { endpoint: storage.endpoint } : {}),
              ...(storage.force_path_style ? { force_path_style: true } : {}),
            },
          },
        ],
        // Composite layout is the LiveKit default; we only ship composite in 8B.
        layout: opts.recordingType === 'audio_only' ? 'audio-only' : 'speaker',
        audio_only: opts.recordingType === 'audio_only',
      };
      let handle: RecordingHandle;
      try {
        const result = await twirp<{ egress_id?: string; status?: string }>({
          baseUrl: cfg.egress_url || baseUrl,
          apiKey,
          apiSecret,
          service: 'livekit.Egress',
          method: 'StartRoomCompositeEgress',
          body,
          room: providerRoomId,
        });
        handle = {
          recordingId: result.egress_id || ('egr_' + Date.now().toString(36)),
          status: result.status === 'EGRESS_ACTIVE' ? 'recording' : 'pending',
        };
      } catch (err) {
        if (err instanceof LiveKitTwirpError) {
          throw new CallProviderNotReadyError(
            'livekit',
            'LiveKit StartRoomCompositeEgress failed: ' + err.code + ' / ' + err.message,
          );
        }
        throw err;
      }

      if (opts.onStarted) {
        try {
          await opts.onStarted(handle);
        } catch (persistErr) {
          // Egress is now running, but we failed to durably record that
          // fact — a deletion worker has nothing to see and wait on. Try
          // to stop it so it can't finalize/upload an object nothing will
          // ever reference.
          let stopStatus: string | null = null;
          let stopErr: unknown = null;
          try {
            stopStatus = (await livekitProvider.stopRecording(config, handle.recordingId)).status;
          } catch (e) {
            stopErr = e;
          }
          if (stopErr !== null) {
            // Compensation itself failed — we cannot confirm Egress is
            // stopped. Do NOT release the lease: let it expire naturally
            // so workspace deletion keeps waiting rather than trusting
            // storage while an unaccounted-for Egress might still write.
            releaseLeaseNow = false;
            throw new CallProviderNotReadyError(
              'livekit',
              `LiveKit recording started but could not be durably recorded (${errMessage(persistErr)}), and compensating stop also failed (${errMessage(stopErr)}) — write lease held until expiry`,
              true, // needsReconciliation — see this class's doc comment; the caller must NOT clear its non-terminal marker
            );
          }
          // Sixth corrective pass, P0: a StopEgress call that does not
          // THROW is not the same as Egress being terminal —
          // stopRecording() itself returns status:'finalizing' on the
          // ordinary success path (only its own not_found branch reports
          // 'available'); either way LiveKit can still asynchronously
          // finalize/upload after this call returns. Persistence never
          // happened, so there is still no durable recording_id on
          // record — needsReconciliation=true here too (not only on a
          // compensation FAILURE) so the caller leaves the phase-1
          // 'pending' marker in place instead of marking the row
          // 'failed'. workspaceDeletion/worker.ts's
          // quiesceLiveKitEgress() discovers it by room via
          // findActiveEgressForRoom() and only trusts storage once
          // LiveKit itself confirms a terminal/no longer active state —
          // never merely because this Stop call returned without error.
          throw new CallProviderNotReadyError(
            'livekit',
            `LiveKit recording started but could not be durably recorded (${errMessage(persistErr)}); compensating stop was issued (status: ${stopStatus}) but that alone does not confirm Egress is terminal — reconciliation required`,
            true, // needsReconciliation
          );
        }
      }

      return handle;
    } finally {
      if (releaseLeaseNow) await releaseOwnerWriteLease(config, leaseId, leaseToken);
    }
  },

  async stopRecording(config, recordingId): Promise<RecordingHandle> {
    const { baseUrl, apiKey, apiSecret } = await resolveLk(config);
    const cfg = await loadLiveKitConfig(config);
    try {
      await twirp({
        baseUrl: cfg.egress_url || baseUrl,
        apiKey,
        apiSecret,
        service: 'livekit.Egress',
        method: 'StopEgress',
        body: { egress_id: recordingId },
      });
      return { recordingId, status: 'finalizing' };
    } catch (err) {
      if (err instanceof LiveKitTwirpError && err.code === 'not_found') {
        return { recordingId, status: 'available' };
      }
      throw err;
    }
  },

  async getRoomState(config, providerRoomId): Promise<RoomState> {
    try {
      const { baseUrl, apiKey, apiSecret } = await resolveLk(config);
      type RoomItem = { sid?: string; num_participants?: number; creation_time?: number };
      const result = await twirp<{ rooms?: RoomItem[] }>({
        baseUrl,
        apiKey,
        apiSecret,
        service: 'livekit.RoomService',
        method: 'ListRooms',
        body: { names: [providerRoomId] },
      });
      const room = (result.rooms || [])[0];
      if (!room) {
        return { providerRoomId, active: false, participantCount: 0, startedAt: null };
      }
      return {
        providerRoomId,
        active: true,
        participantCount: typeof room.num_participants === 'number' ? room.num_participants : 0,
        startedAt: room.creation_time
          ? new Date(room.creation_time * 1000).toISOString()
          : null,
      };
    } catch {
      return { providerRoomId, active: false, participantCount: 0, startedAt: null };
    }
  },
};

/** Convenience for the resolver - re-export TURN reader. */
export { getTurnConfig };

export interface ActiveEgressInfo {
  egressId: string;
  status: string;
}

/**
 * Fifth corrective pass, P0: provider-side reconciliation for an Egress
 * whose recording_id was never durably persisted — the double-failure
 * case in startRecording() (onStarted persistence fails AND the
 * compensating stopRecording() also fails), where the write lease is
 * deliberately held open rather than released. workspaceDeletion/
 * worker.ts's quiesceLiveKitEgress() calls this when it finds a
 * call_sessions row stuck non-terminal with no recording_id in
 * metadata — asking LiveKit itself, the actual source of truth for
 * what's running, rather than assuming the worst (permanently stuck) or
 * the best (safe to ignore) from DB state alone.
 *
 * Returns an empty array ONLY when LiveKit affirmatively confirms no
 * active egress exists for this room — never on a failure to reach
 * LiveKit at all, which throws instead, so a caller can never mistake
 * "couldn't ask" for "confirmed nothing running".
 */
export async function findActiveEgressForRoom(config: ServerConfig, roomName: string): Promise<ActiveEgressInfo[]> {
  const { baseUrl, apiKey, apiSecret } = await resolveLk(config);
  const cfg = await loadLiveKitConfig(config);
  const result = await twirp<{ items?: Array<{ egress_id?: string; status?: string }> }>({
    baseUrl: cfg.egress_url || baseUrl,
    apiKey,
    apiSecret,
    service: 'livekit.Egress',
    method: 'ListEgress',
    body: { room_name: roomName, active: true },
  });
  return (result.items ?? [])
    .filter((item): item is { egress_id: string; status?: string } => typeof item.egress_id === 'string' && item.egress_id.length > 0)
    .map((item) => ({ egressId: item.egress_id, status: item.status ?? 'EGRESS_ACTIVE' }));
}
