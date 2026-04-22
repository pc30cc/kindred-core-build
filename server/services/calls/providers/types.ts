/**
 * Phase 8A — Voice/Video provider abstraction.
 *
 * No provider-specific types leak through. Routes call only into this
 * interface; resolveCallProvider() returns the right impl at runtime.
 */
import type { ServerConfig } from '../../../config.js';

export type CallProviderId = 'livekit' | 'jitsi' | 'janus' | 'disabled';

export interface CreateRoomInput {
  workspaceId: string;
  callSessionId: string;
  callType: 'audio' | 'video' | 'screenshare' | 'meeting';
  maxParticipants: number;
  recordingEnabled: boolean;
  metadata?: Record<string, unknown>;
}

export interface CreateRoomResult {
  providerRoomId: string;
  metadata?: Record<string, unknown>;
}

export interface ParticipantTokenInput {
  callSessionId: string;
  providerRoomId: string;
  participantId: string;
  participantType: 'visitor' | 'operator' | 'admin' | 'internal';
  displayName?: string;
  canPublish: boolean;
  canSubscribe: boolean;
  canPublishData: boolean;
  ttlSeconds?: number;
}

export interface ParticipantTokenResult {
  token: string;
  expiresAt: number;
  /** Resolver-provided endpoints (rtc/ws/turn). Set by signaling layer, not provider. */
  network?: unknown;
}

export interface RoomState {
  providerRoomId: string;
  active: boolean;
  participantCount: number;
  startedAt: string | null;
  metadata?: Record<string, unknown>;
}

export interface RecordingHandle {
  recordingId: string;
  status: 'pending' | 'recording' | 'finalizing' | 'available' | 'failed';
}

export interface CallProvider {
  readonly id: CallProviderId;

  // Capability flags (no DB calls).
  supportsAudio(): boolean;
  supportsVideo(): boolean;
  supportsScreenShare(): boolean;
  supportsRecording(): boolean;

  /** Create a media room. May be a no-op for providers with implicit rooms. */
  createRoom(config: ServerConfig, input: CreateRoomInput): Promise<CreateRoomResult>;

  /** Tear down a media room. Idempotent. */
  closeRoom(config: ServerConfig, providerRoomId: string): Promise<void>;

  /** Mint a participant join token. */
  createParticipantToken(
    config: ServerConfig,
    input: ParticipantTokenInput,
  ): Promise<ParticipantTokenResult>;

  /** Forcibly remove a participant. */
  revokeParticipant(
    config: ServerConfig,
    providerRoomId: string,
    providerParticipantId: string,
  ): Promise<void>;

  /** Start composite/individual recording. */
  startRecording(
    config: ServerConfig,
    providerRoomId: string,
    opts: { recordingType: 'composite' | 'individual' | 'audio_only' },
  ): Promise<RecordingHandle>;

  /** Stop a running recording. */
  stopRecording(config: ServerConfig, recordingId: string): Promise<RecordingHandle>;

  /** Get the current state of a room. */
  getRoomState(config: ServerConfig, providerRoomId: string): Promise<RoomState>;

  /**
   * True iff the provider has the minimum config to be usable
   * (URL + credentials reachable). Used by the resolver for fallback.
   */
  isReady(config: ServerConfig): Promise<boolean>;
}

/** Sentinel error: provider not configured / cannot operate. */
export class CallProviderNotReadyError extends Error {
  constructor(public readonly providerId: CallProviderId, message: string) {
    super(message);
    this.name = 'CallProviderNotReadyError';
  }
}