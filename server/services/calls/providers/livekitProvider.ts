/**
 * Phase 8A — LiveKit provider stub.
 *
 * Implements the CallProvider interface and reads endpoint config via
 * the centralized RTC resolver. Token minting + REST calls are deferred
 * to Phase 8B (LiveKit integration). For now every method returns a
 * structured "not_ready" error if LiveKit isn't configured; otherwise
 * the methods produce deterministic placeholder values so the signaling
 * layer can be exercised end-to-end without the SDK.
 *
 * STRICT: this file does NOT hardcode any host. It only reads from
 * server/services/calls/rtcResolver.ts.
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

function placeholderToken(input: ParticipantTokenInput): string {
  // Phase 8A placeholder. Replaced by signed JWT in Phase 8B.
  // The format is intentionally inert — clients in Phase 8A don't connect yet.
  return [
    'lk_placeholder',
    input.callSessionId,
    input.participantId,
    input.participantType,
    Date.now().toString(36),
  ].join('.');
}

export const livekitProvider: CallProvider = {
  id: 'livekit',

  supportsAudio: () => true,
  supportsVideo: () => true,
  supportsScreenShare: () => true,
  supportsRecording: () => true,

  async isReady(config) {
    const url = await getRtcBaseUrl(config);
    return !!url;
  },

  async createRoom(config, input: CreateRoomInput): Promise<CreateRoomResult> {
    const url = await getRtcBaseUrl(config);
    if (!url) {
      throw new CallProviderNotReadyError(
        'livekit',
        'LiveKit RTC base URL is not configured (call_rtc_endpoints.rtc_url).',
      );
    }
    // Phase 8A — deterministic room name. Phase 8B will call LiveKit REST.
    return {
      providerRoomId: `gs_${input.workspaceId.slice(0, 8)}_${input.callSessionId.slice(0, 8)}`,
      metadata: {
        max_participants: input.maxParticipants,
        recording_enabled: input.recordingEnabled,
      },
    };
  },

  async closeRoom(_config, _providerRoomId) {
    // No-op in stub. Real impl: DELETE /twirp/livekit.RoomService/DeleteRoom
  },

  async createParticipantToken(
    config,
    input: ParticipantTokenInput,
  ): Promise<ParticipantTokenResult> {
    const url = await getRtcBaseUrl(config);
    if (!url) {
      throw new CallProviderNotReadyError(
        'livekit',
        'LiveKit RTC base URL is not configured.',
      );
    }
    const ttl = Math.max(60, Math.min(input.ttlSeconds ?? 600, 3600));
    return {
      token: placeholderToken(input),
      expiresAt: Date.now() + ttl * 1000,
    };
  },

  async revokeParticipant(_config, _providerRoomId, _providerParticipantId) {
    // No-op in stub.
  },

  async startRecording(_config, _providerRoomId, _opts): Promise<RecordingHandle> {
    return { recordingId: `rec_${Date.now().toString(36)}`, status: 'pending' };
  },

  async stopRecording(_config, recordingId): Promise<RecordingHandle> {
    return { recordingId, status: 'finalizing' };
  },

  async getRoomState(_config, providerRoomId): Promise<RoomState> {
    return {
      providerRoomId,
      active: true,
      participantCount: 0,
      startedAt: null,
    };
  },
};

/** Convenience for the resolver — re-export TURN reader. */
export { getTurnConfig };