/**
 * OperatorMediaConsole — standalone Call Center operator-side media UI.
 *
 * Connects the operator browser to the same LiveKit room as the visitor
 * using the secrets-free `connect` block returned by
 * POST /api/call-center/calls/:id/accept. Supports mic/camera toggle,
 * end-call, local preview, remote track attachment, and human-friendly
 * error states.
 *
 * STRICT:
 *  - Never renders or logs the operator token.
 *  - Never imports the chat-call runtime or chat-call hook.
 *  - Self-hosted: SDK loaded locally via loadLiveKitClient().
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { loadLiveKitClient } from '@/lib/livekit-loader';
import {
  Mic, MicOff, Video as VideoIcon, VideoOff, PhoneOff, Loader2,
  AlertTriangle, Wifi, WifiOff,
} from 'lucide-react';

export interface OperatorConnectInfo {
  supported: boolean;
  provider: string;
  server_url?: string | null;
  room_id?: string | null;
  identity?: string | null;
  reason?: string;
}

export interface OperatorMediaConsoleProps {
  callId: string;
  callType: 'audio' | 'video' | 'voice' | string;
  connect: OperatorConnectInfo;
  token: string | null;
  onEnd: () => Promise<void> | void;
  onError?: (error: string) => void;
}

type ConnState =
  | 'idle'
  | 'loading_sdk'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

const ERROR_MESSAGES: Record<string, string> = {
  livekit_client_load_failed: 'Could not load the call media library. Check your network.',
  livekit_client_invalid: 'The local call media library is invalid.',
  provider_client_not_configured: 'Call provider is not configured for this workspace.',
  provider_client_not_supported: 'Selected call provider has no browser client yet.',
  provider_client_not_ready: 'Call provider is not ready for this call.',
  microphone_permission_denied: 'Microphone access was denied.',
  camera_permission_denied: 'Camera access was denied.',
  room_connect_failed: 'Failed to join the call room.',
  room_disconnected: 'Disconnected from the call room.',
  token_expired: 'Your access to this call expired.',
  livekit_url_missing: 'Call provider has no public URL configured.',
};

function humanError(code: string): string {
  return ERROR_MESSAGES[code] || code.replace(/_/g, ' ');
}

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function OperatorMediaConsole(props: OperatorMediaConsoleProps) {
  const { callId, callType, connect, token, onEnd, onError } = props;
  const wantVideo = callType === 'video';

  const [state, setState] = useState<ConnState>('idle');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(wantVideo);
  const [remoteParticipants, setRemoteParticipants] = useState<string[]>([]);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [ending, setEnding] = useState(false);

  const roomRef = useRef<any>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteContainerRef = useRef<HTMLDivElement | null>(null);
  const attachedElsRef = useRef<HTMLElement[]>([]);

  // Pre-flight gating
  const preflight = useMemo(() => {
    if (!connect) return 'provider_client_not_configured';
    if (!connect.supported) return connect.reason || 'provider_client_not_supported';
    if (connect.provider !== 'livekit') return 'provider_client_not_supported';
    if (!connect.server_url || !token || !connect.room_id) {
      return 'provider_client_not_configured';
    }
    return null;
  }, [connect, token]);

  const fail = useCallback((code: string) => {
    setErrorCode(code);
    setState('error');
    onError?.(code);
  }, [onError]);

  // Tick for call timer
  useEffect(() => {
    if (state !== 'connected') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state]);

  // Connect lifecycle
  useEffect(() => {
    let cancelled = false;

    if (preflight) {
      fail(preflight);
      return;
    }

    setState('loading_sdk');
    setErrorCode(null);

    (async () => {
      let LK: any;
      try {
        LK = await loadLiveKitClient();
      } catch (e: any) {
        if (!cancelled) fail(e?.message || 'livekit_client_load_failed');
        return;
      }
      if (cancelled) return;

      const room = new LK.Room({
        adaptiveStream: true,
        dynacast: true,
      });
      roomRef.current = room;

      const RoomEvent = LK.RoomEvent;

      room.on(RoomEvent.TrackSubscribed, (track: any, _pub: any, participant: any) => {
        try {
          const el = track.attach();
          el.style.width = '100%';
          el.style.height = '100%';
          el.style.objectFit = 'cover';
          el.setAttribute('playsinline', 'true');
          if (track.kind === 'video') {
            (el as HTMLVideoElement).autoplay = true;
            setHasRemoteVideo(true);
          } else {
            (el as HTMLAudioElement).autoplay = true;
          }
          attachedElsRef.current.push(el);
          remoteContainerRef.current?.appendChild(el);
        } catch { /* noop */ }
        setRemoteParticipants((cur) => Array.from(new Set([...cur, participant?.identity || 'remote'])));
      });
      room.on(RoomEvent.TrackUnsubscribed, (track: any) => {
        try {
          const els = track.detach();
          (els as HTMLElement[]).forEach((el) => el.remove());
          if (track.kind === 'video') {
            // recompute video presence
            const stillVideo = attachedElsRef.current.some(
              (e) => e.tagName === 'VIDEO' && e.isConnected,
            );
            setHasRemoteVideo(stillVideo);
          }
        } catch { /* noop */ }
      });
      room.on(RoomEvent.ParticipantConnected, (p: any) => {
        setRemoteParticipants((cur) => Array.from(new Set([...cur, p?.identity || 'remote'])));
      });
      room.on(RoomEvent.ParticipantDisconnected, (p: any) => {
        setRemoteParticipants((cur) => cur.filter((id) => id !== p?.identity));
      });
      room.on(RoomEvent.Disconnected, () => {
        if (cancelled) return;
        setState((s) => (s === 'connected' || s === 'reconnecting' ? 'disconnected' : s));
      });
      room.on(RoomEvent.Reconnecting, () => {
        if (!cancelled) setState('reconnecting');
      });
      room.on(RoomEvent.Reconnected, () => {
        if (!cancelled) setState('connected');
      });

      setState('connecting');
      try {
        await room.connect(connect.server_url, token);
      } catch (e: any) {
        if (!cancelled) {
          const msg = String(e?.message || '').toLowerCase();
          if (msg.includes('expired') || msg.includes('invalid token')) {
            fail('token_expired');
          } else {
            fail('room_connect_failed');
          }
        }
        return;
      }
      if (cancelled) {
        try { room.disconnect(); } catch { /* noop */ }
        return;
      }

      // Enable mic
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch (e: any) {
        if (e?.name === 'NotAllowedError') {
          fail('microphone_permission_denied');
          try { room.disconnect(); } catch { /* noop */ }
          return;
        }
      }
      // Enable camera if video
      if (wantVideo) {
        try {
          await room.localParticipant.setCameraEnabled(true);
          // attach local video preview
          const cameraPub = Array.from(room.localParticipant.videoTrackPublications.values())[0] as any;
          const track = cameraPub?.track || cameraPub?.videoTrack;
          if (track && localVideoRef.current) {
            track.attach(localVideoRef.current);
          }
        } catch (e: any) {
          if (e?.name === 'NotAllowedError') {
            // Soft-fail: keep audio call going.
            setCamOn(false);
          }
        }
      }

      if (!cancelled) {
        setState('connected');
        setStartedAt(Date.now());
      }
    })();

    return () => {
      cancelled = true;
      const room = roomRef.current;
      roomRef.current = null;
      try {
        attachedElsRef.current.forEach((el) => el.remove());
        attachedElsRef.current = [];
      } catch { /* noop */ }
      if (room) {
        try { room.disconnect(); } catch { /* noop */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, connect?.server_url, connect?.room_id, token]);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !micOn;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicOn(next);
    } catch { /* noop */ }
  }, [micOn]);

  const toggleCam = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !camOn;
    try {
      await room.localParticipant.setCameraEnabled(next);
      setCamOn(next);
      if (next) {
        const pub = Array.from(room.localParticipant.videoTrackPublications.values())[0] as any;
        const track = pub?.track || pub?.videoTrack;
        if (track && localVideoRef.current) track.attach(localVideoRef.current);
      } else if (localVideoRef.current) {
        localVideoRef.current.srcObject = null;
      }
    } catch (e: any) {
      if (e?.name === 'NotAllowedError') fail('camera_permission_denied');
    }
  }, [camOn, fail]);

  const handleEnd = useCallback(async () => {
    setEnding(true);
    const room = roomRef.current;
    roomRef.current = null;
    try { room?.disconnect(); } catch { /* noop */ }
    try {
      await onEnd();
    } catch { /* noop */ }
    setEnding(false);
    setState('disconnected');
  }, [onEnd]);

  const duration = startedAt ? Math.floor((now - startedAt) / 1000) : 0;

  // ── UI ──────────────────────────────────────────────────────────
  return (
    <div className="rounded-lg overflow-hidden border bg-zinc-950 text-zinc-100 shadow-md">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900/80 border-b border-zinc-800">
        <div className="flex items-center gap-2 text-xs">
          {state === 'connected' ? (
            <Wifi className="h-3.5 w-3.5 text-emerald-400" />
          ) : state === 'reconnecting' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
          ) : state === 'disconnected' || state === 'error' ? (
            <WifiOff className="h-3.5 w-3.5 text-rose-400" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-300" />
          )}
          <span className="font-medium uppercase tracking-wide">
            {state === 'loading_sdk' && 'Loading media…'}
            {state === 'connecting' && 'Connecting…'}
            {state === 'connected' && 'Live'}
            {state === 'reconnecting' && 'Reconnecting'}
            {state === 'disconnected' && 'Ended'}
            {state === 'error' && 'Error'}
            {state === 'idle' && 'Idle'}
          </span>
          {startedAt && state !== 'error' && (
            <span className="ms-2 tabular-nums text-zinc-300">{fmtDur(duration)}</span>
          )}
        </div>
        <div className="text-[10px] text-zinc-400 flex items-center gap-2">
          <span>{wantVideo ? 'Video' : 'Voice'}</span>
          <span>·</span>
          <span>{remoteParticipants.length} remote</span>
        </div>
      </div>

      {/* Stage */}
      <div className="relative bg-black aspect-video w-full">
        {/* Remote container */}
        <div ref={remoteContainerRef} className="absolute inset-0 flex items-center justify-center" />

        {/* Audio-only / waiting placeholder */}
        {!hasRemoteVideo && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center gap-3 pointer-events-none">
            <div className="h-20 w-20 rounded-full bg-zinc-800 flex items-center justify-center text-2xl font-semibold">
              {(remoteParticipants[0] || 'V').slice(0, 1).toUpperCase()}
            </div>
            <div className="text-sm text-zinc-300">
              {state === 'connected'
                ? wantVideo
                  ? 'Waiting for visitor video…'
                  : 'Audio connected'
                : state === 'connecting' || state === 'loading_sdk'
                  ? 'Establishing call…'
                  : state === 'reconnecting'
                    ? 'Reconnecting…'
                    : ''}
            </div>
          </div>
        )}

        {/* Local preview tile (video) */}
        {wantVideo && (
          <div className="absolute bottom-3 right-3 w-32 h-24 rounded-md overflow-hidden border border-zinc-700 bg-zinc-900 shadow-lg">
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              className={cn('w-full h-full object-cover', !camOn && 'hidden')}
            />
            {!camOn && (
              <div className="w-full h-full flex items-center justify-center text-zinc-500">
                <VideoOff className="h-5 w-5" />
              </div>
            )}
          </div>
        )}

        {/* Error overlay */}
        {state === 'error' && errorCode && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-6">
            <div className="max-w-sm rounded-md border border-rose-700/60 bg-rose-950/40 p-4 text-center">
              <AlertTriangle className="h-5 w-5 mx-auto text-rose-400 mb-2" />
              <div className="text-sm font-medium">Cannot connect</div>
              <div className="text-xs text-rose-200 mt-1">{humanError(errorCode)}</div>
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-2 px-4 py-3 bg-zinc-900/80 border-t border-zinc-800">
        <Button
          type="button"
          variant={micOn ? 'secondary' : 'destructive'}
          size="sm"
          onClick={toggleMic}
          disabled={state !== 'connected' && state !== 'reconnecting'}
          title={micOn ? 'Mute microphone' : 'Unmute microphone'}
        >
          {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          <span className="ms-1.5">{micOn ? 'Mute' : 'Unmute'}</span>
        </Button>
        <Button
          type="button"
          variant={camOn ? 'secondary' : 'outline'}
          size="sm"
          onClick={toggleCam}
          disabled={!wantVideo || (state !== 'connected' && state !== 'reconnecting')}
          title={wantVideo ? (camOn ? 'Turn camera off' : 'Turn camera on') : 'Voice-only call'}
        >
          {camOn ? <VideoIcon className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
          <span className="ms-1.5">{camOn ? 'Camera' : 'Camera off'}</span>
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={handleEnd}
          disabled={ending}
        >
          {ending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneOff className="h-4 w-4" />}
          <span className="ms-1.5">End call</span>
        </Button>
      </div>
    </div>
  );
}

export default OperatorMediaConsole;