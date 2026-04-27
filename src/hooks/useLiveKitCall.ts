/**
 * Phase 8B - LiveKit room lifecycle hook (operator + widget surfaces).
 *
 * Responsibilities:
 *  - Connect/disconnect to a LiveKit room with a server-issued token
 *  - Surface participant join/leave + remote tracks
 *  - Local mic / camera publish controls
 *  - Reconnect handling via the SDK's built-in retry
 *
 * Strict rules:
 *  - Token + URL ALWAYS comes from backend (callsApi.token). Never minted here.
 *  - No hardcoded RTC URL. The hook accepts whatever the backend returns.
 *  - No provider branching - this assumes a LiveKit-compatible WS URL because
 *    the resolver has already chosen the effective provider server-side.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type LocalTrackPublication,
  type LocalVideoTrack,
  type RemoteAudioTrack,
  type RemoteVideoTrack,
} from 'livekit-client';

/**
 * Client-side defensive re-normalization of the LiveKit ws_url.
 *
 * The backend already runs `normalizeClientWsUrl()` (see
 * server/services/calls/rtcResolver.ts) but if a stale frontend bundle
 * is paired with a stale backend, or an admin saves a malformed value
 * (`https://host/rtc/v1`, `wss://host/rtc/`), we still hand the SDK a
 * clean `wss://host[:port]` origin. LiveKit's JS SDK appends `/rtc`
 * and `/rtc/validate` itself; including any path here produces
 * `/rtc/v1/validate 404` symptoms in the operator network log.
 *
 * Returns the input unchanged when it cannot be parsed so the original
 * "Missing RTC ws_url" / SDK error surfaces with the bad value visible.
 */
function normalizeWsUrlForSdk(raw: string): string {
  if (!raw) return raw;
  const trimmed = String(raw).trim().replace(/\/+$/, '');
  if (!trimmed) return raw;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return raw;
  }
  let protocol = parsed.protocol;
  if (protocol === 'http:') protocol = 'ws:';
  else if (protocol === 'https:') protocol = 'wss:';
  if (protocol !== 'ws:' && protocol !== 'wss:') return raw;
  if (!parsed.host) return raw;
  return `${protocol}//${parsed.host}`;
}

export type CallConnState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed';

export interface RemoteMediaEntry {
  participantSid: string;
  identity: string;
  /** LiveKit track objects — use track.attach(el) / track.detach(el). */
  audioTrack?: RemoteAudioTrack | null;
  videoTrack?: RemoteVideoTrack | null;
  /** Diagnostics only — DO NOT use these to attach to <video> elements.
   *  Use audioTrack/videoTrack with the LiveKit attach/detach API instead. */
  audio?: MediaStreamTrack | null;
  video?: MediaStreamTrack | null;
}

export type LiveKitDisconnectReason =
  | 'explicit_hangup'
  | 'server_call_ended'
  | 'visitor_left'
  | 'operator_left_conversation'
  | 'component_unmount_no_active_call'
  | 'conversation_switch_active_call'
  | 'app_shutdown';

export interface LiveKitDisconnectContext {
  activeCallSessionId?: string | null;
  activeCallConversationId?: string | null;
  currentConversationId?: string | null;
}

export interface UseLiveKitCallOptions {
  /** Whether to publish local microphone on connect. Default true. */
  publishMic?: boolean;
  /** Whether to publish local camera on connect. Default false (audio-first). */
  publishCamera?: boolean;
}

export interface UseLiveKitCallApi {
  state: CallConnState;
  error: string | null;
  remote: RemoteMediaEntry[];
  localVideoTrack: LocalVideoTrack | null;
  micEnabled: boolean;
  cameraEnabled: boolean;
  /** Connect to a room. URL/token come from the backend token endpoint. */
  connect(input: {
    wsUrl: string;
    token: string;
    iceServers?: RTCIceServer[];
    iceTransportPolicy?: 'all' | 'relay';
  }): Promise<void>;
  disconnect(reason: LiveKitDisconnectReason, context?: LiveKitDisconnectContext): Promise<void>;
  toggleMic(): Promise<void>;
  toggleCamera(): Promise<void>;
}

export function useLiveKitCall(opts: UseLiveKitCallOptions = {}): UseLiveKitCallApi {
  const { publishMic = true, publishCamera = false } = opts;
  const roomRef = useRef<Room | null>(null);
  // Re-entrancy guard. While a connect attempt is in flight OR a room is
  // already active, a second connect() call must NOT spin up a second Room
  // — that orphans the first one and the LiveKit server sees the leave as
  // CLIENT_REQUEST_LEAVE on the just-joined participant. This was the
  // primary cause of the "join then immediate leave" symptom.
  const connectingRef = useRef(false);
  const [state, setState] = useState<CallConnState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteMediaEntry[]>([]);
  const [localVideoTrack, setLocalVideoTrack] = useState<LocalVideoTrack | null>(null);
  const [micEnabled, setMicEnabled] = useState(publishMic);
  const [cameraEnabled, setCameraEnabled] = useState(publishCamera);

  const refreshLocalVideo = useCallback(() => {
    const room = roomRef.current;
    if (!room) {
      setLocalVideoTrack(null);
      return;
    }
    let next: LocalVideoTrack | null = null;
    room.localParticipant.videoTrackPublications.forEach((pub: LocalTrackPublication) => {
      const t = pub.track;
      if (t && (t as any).mediaStreamTrack?.readyState === 'live') next = t as LocalVideoTrack;
    });
    setLocalVideoTrack(next);
  }, []);

  const refreshRemotes = useCallback(() => {
    const room = roomRef.current;
    if (!room) {
      setRemote([]);
      return;
    }
    const list: RemoteMediaEntry[] = [];
    room.remoteParticipants.forEach((p: RemoteParticipant) => {
      const entry: RemoteMediaEntry = {
        participantSid: p.sid,
        identity: p.identity,
        audioTrack: null,
        videoTrack: null,
        audio: null,
        video: null,
      };
      p.trackPublications.forEach((pub: RemoteTrackPublication) => {
        const t = pub.track as RemoteTrack | undefined;
        if (!t || !t.mediaStreamTrack) return;
        if (pub.kind === Track.Kind.Audio) {
          entry.audioTrack = t as RemoteAudioTrack;
          entry.audio = t.mediaStreamTrack;
        }
        if (pub.kind === Track.Kind.Video) {
          entry.videoTrack = t as RemoteVideoTrack;
          entry.video = t.mediaStreamTrack;
        }
      });
      list.push(entry);
    });
    setRemote(list);
  }, []);

  const wireRoom = useCallback((room: Room) => {
    room
      .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
        // eslint-disable-next-line no-console
        console.debug('[livekit] ParticipantConnected', p.identity);
        refreshRemotes();
      })
      .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
        // eslint-disable-next-line no-console
        console.debug('[livekit] ParticipantDisconnected', p.identity);
        refreshRemotes();
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
        // eslint-disable-next-line no-console
        console.debug('[livekit] TrackSubscribed', track.kind, p.identity, track.sid);
        refreshRemotes();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
        // eslint-disable-next-line no-console
        console.debug('[livekit] TrackUnsubscribed', track.kind, p.identity, track.sid);
        refreshRemotes();
      })
      // CRITICAL: when LiveKit pauses/resumes a video track (network drop,
      // simulcast layer switch, sender mute) without unsubscribing, only
      // these events fire. Without re-emitting `remote`, the operator's
      // <video> keeps the now-stale MediaStreamTrack and shows the last
      // decoded frame as a freeze. Recompute snapshots on every change.
      .on(RoomEvent.TrackMuted, (pub: RemoteTrackPublication, p: RemoteParticipant) => {
        // eslint-disable-next-line no-console
        console.debug('[livekit] TrackMuted', pub.kind, p.identity);
        refreshRemotes();
      })
      .on(RoomEvent.TrackUnmuted, (pub: RemoteTrackPublication, p: RemoteParticipant) => {
        // eslint-disable-next-line no-console
        console.debug('[livekit] TrackUnmuted', pub.kind, p.identity);
        refreshRemotes();
      })
      .on(RoomEvent.TrackStreamStateChanged, (pub: RemoteTrackPublication, streamState, p: RemoteParticipant) => {
        // eslint-disable-next-line no-console
        console.debug('[livekit] TrackStreamStateChanged', pub.kind, p.identity, streamState);
        refreshRemotes();
      })
      .on(RoomEvent.TrackSubscriptionStatusChanged, (pub: RemoteTrackPublication, status, p: RemoteParticipant) => {
        // eslint-disable-next-line no-console
        console.debug('[livekit] TrackSubscriptionStatusChanged', pub.kind, p.identity, status);
        refreshRemotes();
      })
      .on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
        if (pub.kind === Track.Kind.Audio) setMicEnabled(true);
        if (pub.kind === Track.Kind.Video) { setCameraEnabled(true); refreshLocalVideo(); }
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
        if (pub.kind === Track.Kind.Audio) setMicEnabled(false);
        if (pub.kind === Track.Kind.Video) { setCameraEnabled(false); refreshLocalVideo(); }
      })
      .on(RoomEvent.Reconnecting, () => {
        // eslint-disable-next-line no-console
        console.debug('[livekit] Reconnecting');
        setState('reconnecting');
      })
      .on(RoomEvent.Reconnected, () => {
        // eslint-disable-next-line no-console
        console.debug('[livekit] Reconnected');
        setState('connected');
        // Re-attach: simulcast/SFU may hand us new track refs after
        // re-subscribe. Force the consumer to rebuild srcObject.
        refreshRemotes();
      })
      .on(RoomEvent.Disconnected, () => {
        // eslint-disable-next-line no-console
        console.debug('[livekit] Disconnected');
        setState('disconnected');
        refreshRemotes();
      });
    // Capture LiveKit's own disconnect reason in addition to the basic
    // event. Helps distinguish CLIENT_INITIATED (we called disconnect) vs
    // server/peer-driven leaves.
    room.on(RoomEvent.Disconnected, (reason?: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[livekit] room emitted Disconnected', { reason });
    });
  }, [refreshRemotes, refreshLocalVideo]);

  const connect = useCallback(async (input: {
    wsUrl: string;
    token: string;
    iceServers?: RTCIceServer[];
    iceTransportPolicy?: 'all' | 'relay';
  }) => {
    if (!input.wsUrl) throw new Error('Missing RTC ws_url from backend resolver');
    // Belt-and-suspenders: re-normalize on the client so a stale bundle
    // paired with a misconfigured backend cannot poison the SDK with a
    // path-bearing URL like `wss://host/rtc/v1`.
    const wsUrl = normalizeWsUrlForSdk(input.wsUrl);
    if (wsUrl !== input.wsUrl) {
      // Visible in the operator console so the misconfig is obvious
      // without needing the diagnostics endpoint.
      console.warn(
        '[livekit] ws_url normalized client-side:',
        input.wsUrl, '→', wsUrl,
      );
    }
    // Idempotency: if a room is already live or a connect is mid-flight,
    // skip silently. The caller (SidebarCallCard) already drives lifecycle
    // via surface.phase — re-entrant calls are bugs we want to swallow,
    // not errors we want to surface.
    if (connectingRef.current || roomRef.current) {
      return;
    }
    connectingRef.current = true;
    setError(null);
    setState('connecting');
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
    });
    // Apply ICE config via the connect-time options (LiveKit forwards this
    // to the underlying RTCPeerConnection). Falls back to defaults when the
    // backend resolver returned no TURN config.
    const connectOptions = input.iceServers
      ? {
          rtcConfig: {
            iceServers: input.iceServers,
            iceTransportPolicy: (input.iceTransportPolicy ?? 'all') as RTCIceTransportPolicy,
          },
        }
      : undefined;
    roomRef.current = room;
    wireRoom(room);
    try {
      // eslint-disable-next-line no-console
      console.debug('[livekit] room.connect() →', wsUrl);
      await room.connect(wsUrl, input.token, connectOptions);
      // Race guard: if someone called disconnect() while we were awaiting
      // the WS handshake, roomRef was cleared. The Room we just joined is
      // now orphaned — tear it down immediately or LiveKit will mark it
      // CLIENT_REQUEST_LEAVE on its own timeout. This is the precise
      // disconnect path that produced the operator's premature leave.
      if (roomRef.current !== room) {
        try { await room.disconnect(); } catch { /* ignore */ }
        return;
      }
      if (publishMic) {
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicEnabled(true);
      }
      if (publishCamera) {
        await room.localParticipant.setCameraEnabled(true);
        setCameraEnabled(true);
        refreshLocalVideo();
      }
      // Re-check after the (potentially long) device-publish phase too —
      // device prompts can take seconds on first call.
      if (roomRef.current !== room) {
        try { await room.disconnect(); } catch { /* ignore */ }
        return;
      }
      setState('connected');
      refreshRemotes();
    } catch (e: any) {
      setError(e?.message || 'Failed to connect');
      setState('failed');
      try { await room.disconnect(); } catch { /* ignore */ }
      // Only clear the ref if we still own it. If disconnect() already
      // cleared and replaced it (unlikely but defensive), don't stomp.
      if (roomRef.current === room) roomRef.current = null;
      throw e;
    } finally {
      connectingRef.current = false;
    }
  }, [publishMic, publishCamera, wireRoom, refreshRemotes, refreshLocalVideo]);

  const disconnect = useCallback(async (reason: LiveKitDisconnectReason, context: LiveKitDisconnectContext = {}) => {
    const room = roomRef.current;
    if (!room) {
      // eslint-disable-next-line no-console
      console.warn('[livekit] disconnect requested', {
        reason,
        activeCallSessionId: context.activeCallSessionId ?? null,
        activeCallConversationId: context.activeCallConversationId ?? null,
        currentConversationId: context.currentConversationId ?? null,
        stack: new Error('disconnect-trace').stack,
      });
      return;
    }
    // Forensic: every operator-side disconnect must be traceable. The
    // operator freeze bug had multiple candidate triggers (conversation
    // switch, unmount, race after toggle). Logging the stack pinpoints
    // the exact React effect/handler that pulled the room down.
    // eslint-disable-next-line no-console
    console.warn('[livekit] disconnect requested', {
      reason,
      activeCallSessionId: context.activeCallSessionId ?? null,
      activeCallConversationId: context.activeCallConversationId ?? null,
      currentConversationId: context.currentConversationId ?? null,
      stack: new Error('disconnect-trace').stack,
    });
    // Clear the ref BEFORE awaiting so any concurrent disconnect/connect
    // call sees a clean slate and does not double-fire.
    roomRef.current = null;
    try { await room.disconnect(); } catch { /* ignore */ }
    setRemote([]);
    setLocalVideoTrack(null);
    setState('disconnected');
  }, []);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !room.localParticipant.isMicrophoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(next);
    setMicEnabled(next);
  }, []);

  const toggleCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !room.localParticipant.isCameraEnabled;
    await room.localParticipant.setCameraEnabled(next);
    setCameraEnabled(next);
    refreshLocalVideo();
  }, [refreshLocalVideo]);

  // Cleanup on unmount. Do not blindly disconnect an active room here: the
  // operator call surface can temporarily unmount during inbox/sidebar data
  // refreshes. Intentional leaves must go through `disconnect(reason, ctx)`
  // from the owning component so the console always shows who requested it.
  useEffect(() => {
    return () => {
      const room = roomRef.current;
      if (room) {
        // eslint-disable-next-line no-console
        console.warn('[livekit] hook unmounted with active room; preserving connection for owner-managed shutdown', {
          stack: new Error('unmount-trace').stack,
        });
      }
    };
  }, []);

  // Periodic safety refresh while connected. Some SFU paths swap the
  // underlying MediaStreamTrack (simulcast layer change, ICE restart)
  // without firing a full TrackSubscribed/Unsubscribed cycle — the only
  // signal is `pub.track.mediaStreamTrack` returning a new identity. A
  // 1Hz recompute keeps the consumer in sync without leaning on render
  // timing. Cheap (one Map walk per second) and gated to active calls.
  useEffect(() => {
    if (state !== 'connected' && state !== 'reconnecting') return;
    const id = setInterval(() => refreshRemotes(), 1000);
    return () => clearInterval(id);
  }, [state, refreshRemotes]);

  return { state, error, remote, localVideoTrack, micEnabled, cameraEnabled, connect, disconnect, toggleMic, toggleCamera };
}