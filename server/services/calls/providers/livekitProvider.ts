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
import { loadLiveKitConfig, isMinimallyConfigured } from '../livekitConfig.js';
import {
  twirp,
  mintParticipantToken,
  LiveKitTwirpError,
} from '../livekitTwirp.js';

interface ResolvedLk {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
}

async function resolveLk(config: ServerConfig): Promise<ResolvedLk> {
  const cfg = await loadLiveKitConfig(config);
  if (!isMinimallyConfigured(cfg)) {
    throw new CallProviderNotReadyError(
      'livekit',
      'LiveKit is not configured (api_key / api_secret / rtc_url required).',
    );
  }
  // Prefer the explicit livekit_config.rtc_url; fall back to the centralised
  // RTC resolver (which itself reads app_runtime_config / env).
  const baseUrl = cfg.rtc_url || (await getRtcBaseUrl(config));
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
    const { baseUrl, apiKey, apiSecret } = await resolveLk(config);
    const roomName = deterministicRoomName(input.workspaceId, input.callSessionId);
    const cfg = await loadLiveKitConfig(config);
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
    const filepath = providerRoomId + '/' + Date.now() + '.mp4';
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
      return {
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
