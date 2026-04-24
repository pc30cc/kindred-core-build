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
  DisconnectReason,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type LocalTrackPublication,
} from 'livekit-client';

// Lightweight namespaced logger. Always on; cheap; no PII. The operator
// side has been the noisy half of the call lifecycle, and the only way to
// know whether a disconnect originated client-side, server-side, or from
// a stale reconnect is to actually trace it.
function lkLog(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[livekit-hook]', ...args);
}

function normalizeLiveKitWsUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    // The public LiveKit deploy behind livekit.destekly.tr currently serves
    // the legacy `/rtc` signal endpoint, while livekit-client 2.x probes
    // `/rtc/v1` first when given the bare origin. Returning an explicit `/rtc`
    // base keeps the first hop deterministic and avoids the initial refused /
    // 404 noise before fallback.
    if (/\/rtc(?:\/v1)?\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/rtc(?:\/v1)?\/?$/, '/rtc');
    } else {
      url.pathname = (url.pathname.replace(/\/+$/, '') || '') + '/rtc';
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return trimmed;
  }
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
  audio?: MediaStreamTrack | null;
  video?: MediaStreamTrack | null;
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
  micEnabled: boolean;
  cameraEnabled: boolean;
  /** Connect to a room. URL/token come from the backend token endpoint. */
  connect(input: {
    wsUrl: string;
    token: string;
    iceServers?: RTCIceServer[];
    iceTransportPolicy?: 'all' | 'relay';
  }): Promise<void>;
  disconnect(): Promise<void>;
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
  const [micEnabled, setMicEnabled] = useState(publishMic);
  const [cameraEnabled, setCameraEnabled] = useState(publishCamera);

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
        audio: null,
        video: null,
      };
      p.trackPublications.forEach((pub: RemoteTrackPublication) => {
        const t = pub.track as RemoteTrack | undefined;
        if (!t || !t.mediaStreamTrack) return;
        if (pub.kind === Track.Kind.Audio) entry.audio = t.mediaStreamTrack;
        if (pub.kind === Track.Kind.Video) entry.video = t.mediaStreamTrack;
      });
      list.push(entry);
    });
    setRemote(list);
  }, []);

  const wireRoom = useCallback((room: Room) => {
    room
      .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
        lkLog('participant connected', p.identity);
        refreshRemotes();
      })
      .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
        lkLog('participant disconnected', p.identity);
        refreshRemotes();
      })
      .on(RoomEvent.TrackSubscribed, (_t, pub) => {
        lkLog('track subscribed', pub.kind);
        refreshRemotes();
      })
      .on(RoomEvent.TrackUnsubscribed, (_t, pub) => {
        lkLog('track unsubscribed', pub.kind);
        refreshRemotes();
      })
      .on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
        lkLog('local track published', pub.kind);
        if (pub.kind === Track.Kind.Audio) setMicEnabled(true);
        if (pub.kind === Track.Kind.Video) setCameraEnabled(true);
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
        lkLog('local track unpublished', pub.kind);
        if (pub.kind === Track.Kind.Audio) setMicEnabled(false);
        if (pub.kind === Track.Kind.Video) setCameraEnabled(false);
      })
      .on(RoomEvent.Reconnecting, () => {
        lkLog('reconnecting');
        setState('reconnecting');
      })
      .on(RoomEvent.Reconnected, () => {
        lkLog('reconnected');
        setState('connected');
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        // DisconnectReason is the single biggest clue on the operator side.
        // CLIENT_INITIATED  → our own disconnect() — expected.
        // SERVER_SHUTDOWN / DUPLICATE_IDENTITY → server kicked us.
        // PARTICIPANT_REMOVED → operator hangup endpoint fired.
        // SIGNAL_CLOSE / STATE_MISMATCH → the unstable path we're chasing.
        lkLog('disconnected', { reason: reason, reasonName: reason !== undefined ? DisconnectReason[reason] : 'unknown' });
        setState('disconnected');
        refreshRemotes();
      });
  }, [refreshRemotes]);

  const connect = useCallback(async (input: {
    wsUrl: string;
    token: string;
    iceServers?: RTCIceServer[];
    iceTransportPolicy?: 'all' | 'relay';
  }) => {
    if (!input.wsUrl) throw new Error('Missing RTC ws_url from backend resolver');
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
    const normalizedWsUrl = normalizeLiveKitWsUrl(input.wsUrl);
    lkLog('connect() begin', {
      wsUrl: input.wsUrl,
      normalizedWsUrl,
      hasToken: !!input.token,
    });
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: false,
      // Disable the SDK's automatic reconnect for the initial connection
      // path — when the WebSocket is refused (proxy / cert / wrong path)
      // the SDK retries silently which collides with React-side state and
      // surfaces as the "could not restart participant" server log. We
      // want a single deterministic attempt; if it fails, surface the
      // error and let the caller (SidebarCallCard) decide.
      reconnectPolicy: {
        nextRetryDelayInMs: () => null,
      },
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
      await room.connect(normalizedWsUrl, input.token, connectOptions);
      lkLog('room.connect() resolved');
      // Race guard: if someone called disconnect() while we were awaiting
      // the WS handshake, roomRef was cleared. The Room we just joined is
      // now orphaned — tear it down immediately or LiveKit will mark it
      // CLIENT_REQUEST_LEAVE on its own timeout. This is the precise
      // disconnect path that produced the operator's premature leave.
      if (roomRef.current !== room) {
        lkLog('post-connect race: ref changed, disconnecting orphan');
        try { await room.disconnect(); } catch { /* ignore */ }
        return;
      }
      if (publishMic) {
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicEnabled(true);
        lkLog('mic enabled');
      }
      if (publishCamera) {
        await room.localParticipant.setCameraEnabled(true);
        setCameraEnabled(true);
        lkLog('camera enabled');
      }
      // Re-check after the (potentially long) device-publish phase too —
      // device prompts can take seconds on first call.
      if (roomRef.current !== room) {
        lkLog('post-publish race: ref changed, disconnecting orphan');
        try { await room.disconnect(); } catch { /* ignore */ }
        return;
      }
      setState('connected');
      refreshRemotes();
    } catch (e: any) {
      lkLog('connect() failed', { message: e?.message });
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
  }, [publishMic, publishCamera, wireRoom, refreshRemotes]);

  const disconnect = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    lkLog('disconnect() called by app');
    // Clear the ref BEFORE awaiting so any concurrent disconnect/connect
    // call sees a clean slate and does not double-fire.
    roomRef.current = null;
    try { await room.disconnect(); } catch { /* ignore */ }
    setRemote([]);
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
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      const room = roomRef.current;
      if (room) {
        try { room.disconnect(); } catch { /* ignore */ }
      }
      roomRef.current = null;
    };
  }, []);

  return { state, error, remote, micEnabled, cameraEnabled, connect, disconnect, toggleMic, toggleCamera };
}