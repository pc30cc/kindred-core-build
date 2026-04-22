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
} from 'livekit-client';

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
      .on(RoomEvent.ParticipantConnected, refreshRemotes)
      .on(RoomEvent.ParticipantDisconnected, refreshRemotes)
      .on(RoomEvent.TrackSubscribed, refreshRemotes)
      .on(RoomEvent.TrackUnsubscribed, refreshRemotes)
      .on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
        if (pub.kind === Track.Kind.Audio) setMicEnabled(true);
        if (pub.kind === Track.Kind.Video) setCameraEnabled(true);
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
        if (pub.kind === Track.Kind.Audio) setMicEnabled(false);
        if (pub.kind === Track.Kind.Video) setCameraEnabled(false);
      })
      .on(RoomEvent.Reconnecting, () => setState('reconnecting'))
      .on(RoomEvent.Reconnected, () => setState('connected'))
      .on(RoomEvent.Disconnected, () => {
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
    setError(null);
    setState('connecting');
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      rtcConfig: input.iceServers
        ? { iceServers: input.iceServers, iceTransportPolicy: input.iceTransportPolicy ?? 'all' }
        : undefined,
    });
    roomRef.current = room;
    wireRoom(room);
    try {
      await room.connect(input.wsUrl, input.token);
      if (publishMic) {
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicEnabled(true);
      }
      if (publishCamera) {
        await room.localParticipant.setCameraEnabled(true);
        setCameraEnabled(true);
      }
      setState('connected');
      refreshRemotes();
    } catch (e: any) {
      setError(e?.message || 'Failed to connect');
      setState('failed');
      try { await room.disconnect(); } catch { /* ignore */ }
      roomRef.current = null;
      throw e;
    }
  }, [publishMic, publishCamera, wireRoom, refreshRemotes]);

  const disconnect = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try { await room.disconnect(); } catch { /* ignore */ }
    roomRef.current = null;
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