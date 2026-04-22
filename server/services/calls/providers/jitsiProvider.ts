/**
 * Phase 8A — Jitsi provider stub.
 * Mirrors the LiveKit stub but advertises Jitsi-friendly capabilities.
 * Real impl deferred to a later phase; not_ready until rtc_url is set
 * and provider id is selected as primary/secondary.
 */
import type { CallProvider } from './types.js';
import { CallProviderNotReadyError } from './types.js';
import { getRtcBaseUrl } from '../rtcResolver.js';

export const jitsiProvider: CallProvider = {
  id: 'jitsi',
  supportsAudio: () => true,
  supportsVideo: () => true,
  supportsScreenShare: () => true,
  supportsRecording: () => true,

  async isReady(config) {
    return !!(await getRtcBaseUrl(config));
  },

  async createRoom(config, input) {
    if (!(await getRtcBaseUrl(config))) {
      throw new CallProviderNotReadyError('jitsi', 'Jitsi RTC base URL not configured.');
    }
    return { providerRoomId: `gs-${input.callSessionId}` };
  },
  async closeRoom() { /* no-op */ },
  async createParticipantToken(config, input) {
    if (!(await getRtcBaseUrl(config))) {
      throw new CallProviderNotReadyError('jitsi', 'Jitsi RTC base URL not configured.');
    }
    return { token: `jitsi_placeholder.${input.callSessionId}.${input.participantId}`, expiresAt: Date.now() + 600_000 };
  },
  async revokeParticipant() { /* no-op */ },
  async startRecording() { return { recordingId: `rec_${Date.now().toString(36)}`, status: 'pending' as const }; },
  async stopRecording(_c, recordingId) { return { recordingId, status: 'finalizing' as const }; },
  async getRoomState(_c, providerRoomId) {
    return { providerRoomId, active: true, participantCount: 0, startedAt: null };
  },
};