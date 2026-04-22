/**
 * Phase 8A.1 — Agora (external / cloud) provider adapter.
 *
 * STRICT POSITIONING:
 *   - Agora is OPTIONAL and EXTERNAL. It is NOT part of the self-hosted
 *     provider family (LiveKit / Jitsi / Janus).
 *   - This adapter is disabled by default, never auto-included in the
 *     default failover order, and never silently overrides a self-hosted
 *     primary. The admin must explicitly select `agora_cloud` as primary
 *     or secondary in the Voice/Video control plane.
 *   - No Agora endpoints, regions, or hostnames are hardcoded here. All
 *     configuration comes from `app_runtime_config.call_agora_config`
 *     (managed via the admin UI).
 *
 * This is a Phase 8A stub: token minting and REST calls are deferred to
 * the Agora integration phase. `isReady()` returns true only when the
 * admin has provided an App ID and an App Certificate (or token secret).
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
import { loadAgoraConfig } from '../agoraConfig.js';

function placeholderToken(input: ParticipantTokenInput): string {
  return [
    'agora_placeholder',
    input.callSessionId,
    input.participantId,
    input.participantType,
    Date.now().toString(36),
  ].join('.');
}

export const agoraProvider: CallProvider = {
  id: 'agora_cloud',

  supportsAudio: () => true,
  supportsVideo: () => true,
  supportsScreenShare: () => true,
  supportsRecording: () => true,

  async isReady(config) {
    const cfg = await loadAgoraConfig(config);
    if (!cfg.enabled) return false;
    // Agora needs at minimum App ID + (App Certificate OR a token secret).
    if (!cfg.app_id) return false;
    if (!cfg.app_certificate && !cfg.token_secret) return false;
    return true;
  },

  async createRoom(config, input: CreateRoomInput): Promise<CreateRoomResult> {
    const cfg = await loadAgoraConfig(config);
    if (!cfg.enabled || !cfg.app_id) {
      throw new CallProviderNotReadyError(
        'agora_cloud',
        'Agora is not enabled or app_id is missing.',
      );
    }
    // Agora uses "channel name" rather than a server-side room object.
    return {
      providerRoomId: `gs_${input.workspaceId.slice(0, 8)}_${input.callSessionId.slice(0, 8)}`,
      metadata: {
        max_participants: input.maxParticipants,
        recording_enabled: input.recordingEnabled,
        region: cfg.region ?? null,
        external_provider: true,
      },
    };
  },

  async closeRoom(_config, _providerRoomId) {
    // Agora channels expire automatically when the last user leaves.
  },

  async createParticipantToken(
    config,
    input: ParticipantTokenInput,
  ): Promise<ParticipantTokenResult> {
    const cfg = await loadAgoraConfig(config);
    if (!cfg.enabled || !cfg.app_id || (!cfg.app_certificate && !cfg.token_secret)) {
      throw new CallProviderNotReadyError(
        'agora_cloud',
        'Agora is not fully configured (need app_id + app_certificate or token_secret).',
      );
    }
    const ttl = Math.max(60, Math.min(input.ttlSeconds ?? 600, 3600));
    return {
      token: placeholderToken(input),
      expiresAt: Date.now() + ttl * 1000,
    };
  },

  async revokeParticipant(_config, _providerRoomId, _providerParticipantId) {
    // Real impl: Agora REST kick endpoint. Stubbed in 8A.
  },

  async startRecording(_config, _providerRoomId, _opts): Promise<RecordingHandle> {
    return { recordingId: `agora_rec_${Date.now().toString(36)}`, status: 'pending' };
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
      metadata: { external_provider: true },
    };
  },
};
