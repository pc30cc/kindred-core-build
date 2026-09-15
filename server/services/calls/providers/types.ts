/**
 * Phase 8A — Voice/Video provider abstraction.
 *
 * No provider-specific types leak through. Routes call only into this
 * interface; resolveCallProvider() returns the right impl at runtime.
 */
import type { ServerConfig } from '../../../config.js';

/**
 * Call provider identifiers.
 *
 * Self-hosted family (default, first-class):
 *   - livekit, jitsi, janus
 *
 * External / cloud-backed adapters (optional, opt-in only):
 *   - agora_cloud
 *
 * `disabled` means no provider — calls cannot start.
 */
export type CallProviderId =
  | 'livekit'
  | 'jitsi'
  | 'janus'
  | 'agora_cloud'
  | 'disabled';

/** Provider classification used by the admin UI + resolver gating. */
export interface CallProviderClassification {
  /** True iff the provider runs entirely on self-hosted infrastructure. */
  self_hosted: boolean;
  /** True iff the provider relies on an external SaaS / cloud backend. */
  external_provider: boolean;
  /**
   * True iff the provider may be auto-included in the default fallback order
   * when no explicit override is set. External providers are NEVER included
   * by default — admin must opt in by selecting them explicitly.
   */
  eligible_for_default_order: boolean;
}

export const CALL_PROVIDER_CLASSIFICATION: Record<
  Exclude<CallProviderId, 'disabled'>,
  CallProviderClassification
> = {
  livekit: { self_hosted: true, external_provider: false, eligible_for_default_order: true },
  jitsi: { self_hosted: true, external_provider: false, eligible_for_default_order: true },
  janus: { self_hosted: true, external_provider: false, eligible_for_default_order: true },
  agora_cloud: {
    self_hosted: false,
    external_provider: true,
    // STRICT: never auto-included. Only used when admin explicitly picks it.
    eligible_for_default_order: false,
  },
};

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

  /**
   * Start composite/individual recording.
   *
   * workspaceId/callSessionId are required so the provider can write the
   * recording under the canonical workspace/<id>/calls/recordings/<id>/...
   * storage key (server/services/storage/keys.ts's callRecordingKey()) —
   * see docs/STORAGE_ARCHITECTURE_AUDIT.md §11. A provider with no
   * recording-storage concept of its own (jitsi/janus stubs, agora) may
   * ignore these fields.
   *
   * `onStarted` (fourth corrective pass, P0): for a provider whose start
   * call is itself the external write-lease-holding operation (LiveKit —
   * see livekitProvider.ts's startRecording()), the caller's own
   * durable-persistence step (writing recording_id/recording_state onto
   * call_sessions) runs INSIDE this callback, while the provider still
   * holds its workspace write lease — never after startRecording()
   * returns, which would leave a window where Egress is running but
   * nothing in the DB records it, undiscoverable by workspaceDeletion/
   * worker.ts's quiesce step. If `onStarted` throws, a real provider
   * attempts a compensating stop before rethrowing. A provider with no
   * lease concept (every non-LiveKit provider today) may ignore this
   * field entirely — the caller falls back to persisting after the call
   * returns for those, which is fine since they don't hold an external
   * write in flight the way LiveKit does.
   *
   * `onStarting` (fifth corrective pass, P0): called BEFORE the actual
   * provider start call, while the write lease is held — this is where
   * the caller persists a durable, phase-1 "recording is about to start"
   * intent (a non-terminal recording_state with no recording_id yet) so
   * it survives even if `onStarted` (phase 2, after the provider call
   * returns) never runs at all — e.g. the provider call itself never
   * completes for reasons unrelated to its own success/failure. See
   * livekitProvider.ts's startRecording() for why this matters even
   * with `onStarted`'s own compensation logic already in place.
   */
  startRecording(
    config: ServerConfig,
    providerRoomId: string,
    opts: {
      recordingType: 'composite' | 'individual' | 'audio_only';
      workspaceId: string;
      callSessionId: string;
      onStarting?: () => Promise<void>;
      onStarted?: (handle: RecordingHandle) => Promise<void>;
    },
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
  constructor(
    public readonly providerId: CallProviderId,
    message: string,
    /**
     * Fifth corrective pass, P0: set ONLY by livekitProvider.ts's
     * startRecording() double-failure case (Egress started, durable
     * persistence failed, AND the compensating stop also failed — see
     * that function's doc comment). A caller catching this must NOT
     * reset call_sessions.recording_state to a terminal value: the
     * Egress may still be running and workspaceDeletion/worker.ts's
     * quiescence reconciliation (findActiveEgressForRoom) needs the
     * existing non-terminal marker to still find and resolve it.
     */
    public readonly needsReconciliation: boolean = false,
  ) {
    super(message);
    this.name = 'CallProviderNotReadyError';
  }
}