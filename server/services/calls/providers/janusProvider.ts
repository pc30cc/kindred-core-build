/**
 * Phase 8A — Janus provider stub. Capability flags only, never ready.
 * Reserved for a future phase.
 */
import type { CallProvider } from './types.js';
import { CallProviderNotReadyError } from './types.js';

export const janusProvider: CallProvider = {
  id: 'janus',
  supportsAudio: () => true,
  supportsVideo: () => true,
  supportsScreenShare: () => true,
  supportsRecording: () => false,

  async isReady() { return false; },
  async createRoom() { throw new CallProviderNotReadyError('janus', 'Janus adapter not implemented.'); },
  async closeRoom() { /* no-op */ },
  async createParticipantToken() { throw new CallProviderNotReadyError('janus', 'Janus adapter not implemented.'); },
  async revokeParticipant() { /* no-op */ },
  async startRecording() { throw new CallProviderNotReadyError('janus', 'Janus adapter not implemented.'); },
  async stopRecording(_c, recordingId) { return { recordingId, status: 'failed' as const }; },
  async getRoomState(_c, providerRoomId) { return { providerRoomId, active: false, participantCount: 0, startedAt: null }; },
};