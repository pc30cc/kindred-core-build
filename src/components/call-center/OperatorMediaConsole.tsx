/**
 * OperatorMediaConsole — standalone Call Center operator-side media UI.
 *
 * Hardened (CC-2D):
 *   - Explicit lifecycle: waiting_for_visitor / visitor_connected /
 *     visitor_disconnected / reconnecting / reconnect_failed /
 *     ended_by_operator / ended_by_visitor / backend_end_failed /
 *     token_expired.
 *   - Robust remote participant + track handling (existing participants,
 *     unsubscribe cleanup, no duplicate elements).
 *   - Compact device picker (mic / camera + refresh).
 *   - Local Web-Audio mic level meter; remote speaking via active speakers.
 *   - End call calls backend first (with timeout), then disconnects;
 *     surfaces backend failure with Retry.
 *   - Token expiry → manual Reconnect (single safe retry via accept).
 *
 * STRICT:
 *   - Never renders or logs the operator token.
 *   - Never imports the chat-call runtime or chat-call hook.
 *   - Self-hosted SDK via loadLiveKitClient(); no CDN.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { loadLiveKitClient } from '@/lib/livekit-loader';
import {
  Mic, MicOff, Video as VideoIcon, VideoOff, PhoneOff, Loader2,
  AlertTriangle, Wifi, WifiOff, RefreshCw, ShieldCheck, ChevronDown, ChevronUp,
} from 'lucide-react';
import { useTranslation } from '@/i18n';
import { consoleErrorMessage } from '@/features/calls/callLabels';

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
  visitorName?: string | null;
  /** Backend end. Should resolve when server-side end is acknowledged; reject on failure. */
  onEnd: () => Promise<void>;
  /** Re-call accept; return new token + connect, or throw. */
  onReconnect?: () => Promise<{ token: string; connect: OperatorConnectInfo } | null>;
  /** External signal: backend reports the call has ended/cancelled/failed. */
  externalEndedReason?: 'ended_by_visitor' | 'ended_by_operator' | 'cancelled' | 'failed' | null;
  /** Called when the console has finished showing the post-end UX and is safe to unmount. */
  onEndedConfirmed?: () => void;
  onError?: (error: string) => void;
  /**
   * Extra controls rendered inside the console's own control bar, between the
   * camera and end-call buttons — recording and transfer live here so an
   * operator has ONE toolbar for the call instead of separate cards scattered
   * down the page. The parent owns the API calls; the console only positions
   * them. `isLive` tells the parent whether media is actually up.
   */
  toolbarSlot?: (state: { isLive: boolean }) => React.ReactNode;
  /** Rendered as a full-width strip under the control bar (recording status). */
  statusSlot?: React.ReactNode;
}

type Phase =
  | 'idle'
  | 'loading_sdk'
  | 'connecting'
  | 'waiting_for_visitor'
  | 'visitor_connected'
  | 'visitor_disconnected'
  | 'reconnecting'
  | 'reconnect_failed'
  | 'ending'
  | 'ended_by_operator'
  | 'ended_by_visitor'
  | 'backend_end_failed'
  | 'token_expired'
  | 'error';

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface DeviceOpt { deviceId: string; label: string }

export function OperatorMediaConsole(props: OperatorMediaConsoleProps) {
  const {
    callId, callType, connect, token, visitorName,
    onEnd, onReconnect, externalEndedReason, onEndedConfirmed, onError,
    toolbarSlot, statusSlot,
  } = props;
  const { t } = useTranslation();
  const wantVideo = callType === 'video';
  const humanError = useCallback((code: string) => consoleErrorMessage(t, code), [t]);

  const [phase, setPhase] = useState<Phase>('idle');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(wantVideo);
  const [remoteIdentities, setRemoteIdentities] = useState<string[]>([]);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // Devices
  const [micDevices, setMicDevices] = useState<DeviceOpt[]>([]);
  const [camDevices, setCamDevices] = useState<DeviceOpt[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>('');
  const [selectedCam, setSelectedCam] = useState<string>('');
  const [deviceSwitchSupported, setDeviceSwitchSupported] = useState(true);

  // Audio levels
  const [localLevel, setLocalLevel] = useState(0);
  const [remoteSpeaking, setRemoteSpeaking] = useState(false);

  // Connection quality (best-effort from LiveKit)
  const [quality, setQuality] = useState<'excellent' | 'good' | 'poor' | 'unknown'>('unknown');

  // Connection token state (for reconnect)
  const [activeToken, setActiveToken] = useState<string | null>(token);
  const [activeConnect, setActiveConnect] = useState<OperatorConnectInfo>(connect);
  // Counter to force connect-effect re-run on reconnect (token swap with same room/server).
  const [connectAttempt, setConnectAttempt] = useState(0);

  const [showDevices, setShowDevices] = useState(false);
  const [showDebug, setShowDebug] = useState(false);

  const roomRef = useRef<any>(null);
  const lkRef = useRef<any>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteContainerRef = useRef<HTMLDivElement | null>(null);
  // Map of trackSid -> attached HTMLElements
  const attachedElsRef = useRef<Map<string, HTMLElement[]>>(new Map());
  const micAnalyserRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode; raf: number; src: MediaStreamAudioSourceNode } | null>(null);

  // Re-sync token/connect props when parent re-accepts
  useEffect(() => { setActiveToken(token); }, [token]);
  useEffect(() => { setActiveConnect(connect); }, [connect.server_url, connect.room_id, connect.provider, connect.supported, connect.reason]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-flight gating
  const preflight = useMemo(() => {
    if (!activeConnect) return 'provider_client_not_configured';
    if (!activeConnect.supported) return activeConnect.reason || 'provider_client_not_supported';
    if (activeConnect.provider !== 'livekit') return 'provider_client_not_supported';
    if (!activeConnect.server_url || !activeToken || !activeConnect.room_id) {
      return 'provider_client_not_configured';
    }
    return null;
  }, [activeConnect, activeToken]);

  const fail = useCallback((code: string) => {
    setErrorCode(code);
    setPhase('error');
    onError?.(code);
  }, [onError]);

  // External end signal
  useEffect(() => {
    if (!externalEndedReason) return;
    if (phase === 'ended_by_operator' || phase === 'backend_end_failed') return;
    const r = externalEndedReason;
    try { roomRef.current?.disconnect(); } catch { /* noop */ }
    if (r === 'ended_by_visitor') setPhase('ended_by_visitor');
    else if (r === 'ended_by_operator') setPhase('ended_by_operator');
    else if (r === 'cancelled') setPhase('ended_by_visitor');
    else if (r === 'failed') { setPhase('error'); setErrorCode('room_disconnected'); }
  }, [externalEndedReason, phase]);

  // Tick for call timer
  useEffect(() => {
    if (phase !== 'visitor_connected' && phase !== 'waiting_for_visitor' && phase !== 'reconnecting') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // ── Device discovery ──────────────────────────────────────
  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const mics = all.filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || t('callCenter.console.micFallback', { n: i + 1 }),
        }));
      const cams = all.filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || t('callCenter.console.cameraFallback', { n: i + 1 }),
        }));
      setMicDevices(mics);
      setCamDevices(cams);
    } catch { /* noop */ }
  }, [t]);

  useEffect(() => {
    refreshDevices();
    const handler = () => refreshDevices();
    try { navigator.mediaDevices?.addEventListener?.('devicechange', handler); } catch { /* noop */ }
    return () => { try { navigator.mediaDevices?.removeEventListener?.('devicechange', handler); } catch { /* noop */ } };
  }, [refreshDevices]);

  // ── Track helpers ─────────────────────────────────────────
  const detachTrack = useCallback((track: any) => {
    try {
      const sid = track?.sid || track?.trackSid || '';
      const els = attachedElsRef.current.get(sid);
      if (els) {
        els.forEach((el) => { try { el.remove(); } catch { /* noop */ } });
        attachedElsRef.current.delete(sid);
      }
      try { track.detach?.(); } catch { /* noop */ }
    } catch { /* noop */ }
    // Recompute hasRemoteVideo
    let stillVideo = false;
    attachedElsRef.current.forEach((els) => {
      if (els.some((e) => e.tagName === 'VIDEO' && e.isConnected)) stillVideo = true;
    });
    setHasRemoteVideo(stillVideo);
  }, []);

  const attachTrack = useCallback((track: any, participant: any) => {
    try {
      const sid = track?.sid || track?.trackSid || `${participant?.identity || 'p'}-${track?.kind}-${Date.now()}`;
      // Avoid duplicate attach
      if (attachedElsRef.current.has(sid)) return;
      const el = track.attach();
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.objectFit = 'cover';
      el.setAttribute('playsinline', 'true');
      el.dataset.trackSid = sid;
      el.dataset.participant = participant?.identity || '';
      if (track.kind === 'video') {
        (el as HTMLVideoElement).autoplay = true;
        setHasRemoteVideo(true);
      } else {
        (el as HTMLAudioElement).autoplay = true;
      }
      attachedElsRef.current.set(sid, [el]);
      remoteContainerRef.current?.appendChild(el);
    } catch { /* noop */ }
  }, []);

  // ── Local mic analyser ────────────────────────────────────
  const stopMicAnalyser = useCallback(() => {
    const ref = micAnalyserRef.current;
    if (!ref) return;
    try { cancelAnimationFrame(ref.raf); } catch { /* noop */ }
    try { ref.src.disconnect(); } catch { /* noop */ }
    try { ref.ctx.close(); } catch { /* noop */ }
    micAnalyserRef.current = null;
  }, []);

  const startMicAnalyser = useCallback((mediaStream: MediaStream) => {
    stopMicAnalyser();
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(mediaStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        setLocalLevel(peak);
        const raf = requestAnimationFrame(tick);
        if (micAnalyserRef.current) micAnalyserRef.current.raf = raf;
      };
      const raf = requestAnimationFrame(tick);
      micAnalyserRef.current = { ctx, analyser, raf, src };
    } catch { /* noop */ }
  }, [stopMicAnalyser]);

  // ── Connect lifecycle ─────────────────────────────────────
  // NOTE: connectKey must NOT include the raw token. We use a counter that bumps on reconnect.
  const connectKey = `${callId}|${activeConnect?.server_url || ''}|${activeConnect?.room_id || ''}|${connectAttempt}`;

  useEffect(() => {
    let cancelled = false;

    if (preflight) { fail(preflight); return; }

    setPhase('loading_sdk');
    setErrorCode(null);

    (async () => {
      let LK: any;
      try {
        LK = await loadLiveKitClient();
        lkRef.current = LK;
      } catch (e: any) {
        if (!cancelled) fail(e?.message || 'livekit_client_load_failed');
        return;
      }
      if (cancelled) return;

      const room = new LK.Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      const RoomEvent = LK.RoomEvent;

      // Try to detect device-switch support
      const lp = room.localParticipant;
      const supportsSwitch = !!(lp?.switchActiveDevice || LK?.LocalParticipant?.prototype?.switchActiveDevice);
      setDeviceSwitchSupported(!!supportsSwitch);

      const handleParticipantTracks = (participant: any) => {
        try {
          const pubs = participant.trackPublications || participant.tracks;
          if (!pubs?.forEach) return;
          pubs.forEach((pub: any) => {
            if (pub?.track && pub?.isSubscribed !== false) attachTrack(pub.track, participant);
          });
        } catch { /* noop */ }
      };

      room.on(RoomEvent.TrackSubscribed, (track: any, _pub: any, participant: any) => {
        attachTrack(track, participant);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track: any) => {
        detachTrack(track);
      });
      room.on(RoomEvent.ParticipantConnected, (p: any) => {
        setRemoteIdentities((cur) => Array.from(new Set([...cur, p?.identity || 'remote'])));
        setPhase((cur) => (cur === 'waiting_for_visitor' || cur === 'connecting' ? 'visitor_connected' : cur));
        handleParticipantTracks(p);
      });
      room.on(RoomEvent.ParticipantDisconnected, (p: any) => {
        // Detach any remaining tracks attached for this participant
        const id = p?.identity;
        attachedElsRef.current.forEach((els, sid) => {
          if (els[0]?.dataset.participant === id) {
            els.forEach((el) => { try { el.remove(); } catch { /* noop */ } });
            attachedElsRef.current.delete(sid);
          }
        });
        let stillVideo = false;
        attachedElsRef.current.forEach((els) => {
          if (els.some((e) => e.tagName === 'VIDEO' && e.isConnected)) stillVideo = true;
        });
        setHasRemoteVideo(stillVideo);
        setRemoteIdentities((cur) => cur.filter((x) => x !== id));
        // If room still connected but visitor left, mark visitor_disconnected
        if (room.state === 'connected' || room.state === 'reconnecting') {
          setPhase((cur) => (cur === 'visitor_connected' ? 'visitor_disconnected' : cur));
        }
      });
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers: any[]) => {
        const remote = speakers?.some((s) => s?.identity && s.identity !== room.localParticipant?.identity);
        setRemoteSpeaking(!!remote);
      });
      room.on(RoomEvent.Disconnected, (reason?: any) => {
        if (cancelled) return;
        const r = String(reason || '').toLowerCase();
        if (r.includes('expired') || r.includes('token')) {
          setPhase('token_expired');
          setErrorCode('token_expired');
        } else {
          setPhase((cur) =>
            cur === 'ending' || cur === 'ended_by_operator' || cur === 'ended_by_visitor' || cur === 'backend_end_failed'
              ? cur
              : 'visitor_disconnected'
          );
        }
        stopMicAnalyser();
      });
      room.on(RoomEvent.Reconnecting, () => { if (!cancelled) setPhase('reconnecting'); });
      room.on(RoomEvent.Reconnected, () => {
        if (cancelled) return;
        const remotes: any[] = Array.from(room.remoteParticipants?.values?.() || []);
        const ids = remotes.map((p) => p?.identity).filter(Boolean) as string[];
        setRemoteIdentities(ids);
        // Re-attach any already-published remote tracks safely (attachTrack dedupes by sid).
        remotes.forEach((p) => {
          try {
            const pubs = p.trackPublications || p.tracks;
            pubs?.forEach?.((pub: any) => {
              if (pub?.track && pub?.isSubscribed !== false) attachTrack(pub.track, p);
            });
          } catch { /* noop */ }
        });
        setPhase(ids.length > 0 ? 'visitor_connected' : 'waiting_for_visitor');
      });
      if (RoomEvent.ConnectionQualityChanged) {
        room.on(RoomEvent.ConnectionQualityChanged, (q: any, p: any) => {
          if (p?.identity !== room.localParticipant?.identity) return;
          const v = String(q || '').toLowerCase();
          if (v.includes('excellent')) setQuality('excellent');
          else if (v.includes('good')) setQuality('good');
          else if (v.includes('poor')) setQuality('poor');
        });
      }

      setPhase('connecting');
      try {
        await room.connect(activeConnect.server_url!, activeToken!);
      } catch (e: any) {
        if (cancelled) return;
        const msg = String(e?.message || '').toLowerCase();
        if (msg.includes('expired') || msg.includes('invalid token') || msg.includes('unauthorized')) {
          setPhase('token_expired');
          setErrorCode('token_expired');
        } else {
          fail('room_connect_failed');
        }
        return;
      }
      if (cancelled) { try { room.disconnect(); } catch { /* noop */ } return; }

      // Enable mic
      try {
        await room.localParticipant.setMicrophoneEnabled(true, selectedMic ? { deviceId: selectedMic } : undefined);
        setMicOn(true);
        // Start analyser on local mic mediaStream
        try {
          const pubs = Array.from(room.localParticipant.audioTrackPublications?.values?.() || []) as any[];
          const t = pubs[0]?.track || pubs[0]?.audioTrack;
          const ms = t?.mediaStream || (t?.mediaStreamTrack ? new MediaStream([t.mediaStreamTrack]) : null);
          if (ms) startMicAnalyser(ms);
        } catch { /* noop */ }
      } catch (e: any) {
        if (e?.name === 'NotAllowedError') { fail('microphone_permission_denied'); try { room.disconnect(); } catch { /* noop */ } return; }
      }

      if (wantVideo) {
        try {
          await room.localParticipant.setCameraEnabled(true, selectedCam ? { deviceId: selectedCam } : undefined);
          const pub = Array.from(room.localParticipant.videoTrackPublications?.values?.() || [])[0] as any;
          const t = pub?.track || pub?.videoTrack;
          if (t && localVideoRef.current) t.attach(localVideoRef.current);
          setCamOn(true);
        } catch (e: any) {
          if (e?.name === 'NotAllowedError') setCamOn(false);
        }
      }

      // Refresh device labels now that permissions exist
      refreshDevices();

      if (cancelled) return;

      // Determine initial post-connect phase based on existing remotes
      const existingRemotes: any[] = Array.from(room.remoteParticipants?.values?.() || []);
      existingRemotes.forEach((p) => handleParticipantTracks(p));
      setRemoteIdentities(existingRemotes.map((p: any) => p.identity).filter(Boolean));
      setPhase(existingRemotes.length > 0 ? 'visitor_connected' : 'waiting_for_visitor');
      setStartedAt(Date.now());
    })();

    return () => {
      cancelled = true;
      stopMicAnalyser();
      const room = roomRef.current;
      roomRef.current = null;
      try {
        attachedElsRef.current.forEach((els) => els.forEach((el) => { try { el.remove(); } catch { /* noop */ } }));
        attachedElsRef.current.clear();
      } catch { /* noop */ }
      if (room) { try { room.disconnect(); } catch { /* noop */ } }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectKey]);

  // ── Controls ──────────────────────────────────────────────
  const toggleMic = useCallback(async () => {
    const room = roomRef.current; if (!room) return;
    const next = !micOn;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicOn(next);
    } catch { /* noop */ }
  }, [micOn]);

  const toggleCam = useCallback(async () => {
    const room = roomRef.current; if (!room) return;
    const next = !camOn;
    try {
      await room.localParticipant.setCameraEnabled(next);
      setCamOn(next);
      if (next) {
        const pub = Array.from(room.localParticipant.videoTrackPublications?.values?.() || [])[0] as any;
        const t = pub?.track || pub?.videoTrack;
        if (t && localVideoRef.current) t.attach(localVideoRef.current);
      } else if (localVideoRef.current) {
        localVideoRef.current.srcObject = null;
      }
    } catch (e: any) {
      if (e?.name === 'NotAllowedError') fail('camera_permission_denied');
    }
  }, [camOn, fail]);

  const switchMic = useCallback(async (deviceId: string) => {
    setSelectedMic(deviceId);
    const room = roomRef.current; if (!room) return;
    try {
      if (room.switchActiveDevice) await room.switchActiveDevice('audioinput', deviceId);
      else if (room.localParticipant?.switchActiveDevice) await room.localParticipant.switchActiveDevice('audioinput', deviceId);
      else setDeviceSwitchSupported(false);
    } catch { setDeviceSwitchSupported(false); }
  }, []);
  const switchCam = useCallback(async (deviceId: string) => {
    setSelectedCam(deviceId);
    const room = roomRef.current; if (!room) return;
    try {
      if (room.switchActiveDevice) await room.switchActiveDevice('videoinput', deviceId);
      else if (room.localParticipant?.switchActiveDevice) await room.localParticipant.switchActiveDevice('videoinput', deviceId);
      else setDeviceSwitchSupported(false);
    } catch { setDeviceSwitchSupported(false); }
  }, []);

  // End call: backend first (with timeout), then disconnect.
  const [endRetrying, setEndRetrying] = useState(false);
  const handleEnd = useCallback(async () => {
    setPhase('ending');
    setEndRetrying(true);
    let backendOk = false;
    try {
      await Promise.race([
        onEnd().then(() => { backendOk = true; }),
        new Promise((_r, rej) => setTimeout(() => rej(new Error('backend_timeout')), 6000)),
      ]);
    } catch { backendOk = false; }
    setEndRetrying(false);
    const room = roomRef.current; roomRef.current = null;
    try { room?.disconnect(); } catch { /* noop */ }
    stopMicAnalyser();
    setPhase(backendOk ? 'ended_by_operator' : 'backend_end_failed');
    if (!backendOk) setErrorCode('backend_end_failed');
  }, [onEnd, stopMicAnalyser]);

  const retryBackendEnd = useCallback(async () => {
    setEndRetrying(true);
    try {
      await onEnd();
      setPhase('ended_by_operator');
      setErrorCode(null);
    } catch { /* keep state */ }
    setEndRetrying(false);
  }, [onEnd]);

  const [reconnecting, setReconnecting] = useState(false);
  const handleReconnect = useCallback(async () => {
    if (!onReconnect) return;
    setReconnecting(true);
    try {
      const r = await onReconnect();
      if (!r) { setPhase('reconnect_failed'); setErrorCode('reconnect_failed'); return; }
      // Disconnect existing room before swapping creds
      try { roomRef.current?.disconnect(); } catch { /* noop */ }
      roomRef.current = null;
      setActiveToken(r.token);
      setActiveConnect(r.connect);
      setErrorCode(null);
      // Bump attempt so connect-effect re-runs even when room/server are unchanged.
      setConnectAttempt((n) => n + 1);
    } catch {
      setPhase('reconnect_failed');
      setErrorCode('reconnect_failed');
    } finally {
      setReconnecting(false);
    }
  }, [onReconnect]);

  // After any terminal phase, briefly show the "Call ended" overlay then
  // notify the parent so it can unmount the media console. This covers
  // operator-ended, visitor-ended, backend-failure and reconnect-failed
  // paths so the workspace returns to the queue view automatically.
  // IMPORTANT: parent re-creates `onEndedConfirmed` on every render
  // (parent polls every 4-5s via react-query). If we depended on it
  // directly the timeout would be reset forever and the console would
  // never close. We pin it in a ref and trigger purely on phase.
  const onEndedConfirmedRef = useRef(onEndedConfirmed);
  useEffect(() => { onEndedConfirmedRef.current = onEndedConfirmed; }, [onEndedConfirmed]);
  const firedEndedRef = useRef(false);
  useEffect(() => {
    const terminal =
      phase === 'ended_by_operator' ||
      phase === 'ended_by_visitor' ||
      phase === 'backend_end_failed' ||
      phase === 'reconnect_failed' ||
      phase === 'token_expired' ||
      phase === 'visitor_disconnected' ||
      phase === 'error';
    if (!terminal) return;
    if (firedEndedRef.current) return;
    // backend_end_failed gives the operator a chance to Retry — wait longer.
    const delay =
      phase === 'backend_end_failed' ? 6000
      : phase === 'visitor_disconnected' ? 2500
      : phase === 'error' ? 4000
      : 1600;
    const t = setTimeout(() => {
      firedEndedRef.current = true;
      try { onEndedConfirmedRef.current?.(); } catch { /* noop */ }
    }, delay);
    return () => clearTimeout(t);
  }, [phase]);

  // ── Derived UI bits ───────────────────────────────────────
  const duration = startedAt ? Math.floor((now - startedAt) / 1000) : 0;
  const isLive = phase === 'visitor_connected' || phase === 'waiting_for_visitor' || phase === 'reconnecting';
  const showEndedOverlay =
    phase === 'ended_by_operator' || phase === 'ended_by_visitor' ||
    phase === 'backend_end_failed' || phase === 'token_expired' ||
    phase === 'reconnect_failed' || phase === 'visitor_disconnected';

  const phaseLabel: string = t(`callCenter.console.phase.${phase}` as never);
  const qualityLabel: string = t(`callCenter.console.quality.${quality}` as never);

  const qualityColor = quality === 'excellent' ? 'text-emerald-400'
    : quality === 'good' ? 'text-emerald-300'
    : quality === 'poor' ? 'text-amber-400' : 'text-zinc-400';

  return (
    <div className="rounded-lg overflow-hidden border bg-zinc-950 text-zinc-100 shadow-md">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900/80 border-b border-zinc-800">
        <div className="flex items-center gap-2 text-xs">
          {phase === 'visitor_connected' ? <Wifi className="h-3.5 w-3.5 text-emerald-400" />
            : phase === 'reconnecting' || phase === 'connecting' || phase === 'loading_sdk'
              ? <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
            : phase === 'waiting_for_visitor' ? <Wifi className="h-3.5 w-3.5 text-amber-300" />
            : <WifiOff className="h-3.5 w-3.5 text-rose-400" />}
          <span className="font-medium uppercase tracking-wide">{phaseLabel}</span>
          {isLive && <span className="ms-2 tabular-nums text-zinc-300">{fmtDur(duration)}</span>}
          <span className={cn('ms-2 inline-flex items-center gap-1', qualityColor)}>
            <ShieldCheck className="h-3 w-3" />
            <span className="text-[10px] uppercase">{t('callCenter.console.secure')}</span>
          </span>
        </div>
        <div className="text-[10px] text-zinc-400 flex items-center gap-2">
          {visitorName && <span className="truncate max-w-[140px]" title={visitorName}>{visitorName}</span>}
          {visitorName && <span>·</span>}
          <span>{wantVideo ? t('callCenter.console.video') : t('callCenter.console.voice')}</span>
          <span>·</span>
          <span>{t('callCenter.console.connectedCount', { count: remoteIdentities.length })}</span>
          <span>·</span>
          <span className={qualityColor}>{qualityLabel}</span>
        </div>
      </div>

      {/* Stage */}
      <div
        className={cn(
          'relative w-full',
          wantVideo
            ? 'bg-black aspect-video'
            : 'bg-gradient-to-br from-zinc-900 via-zinc-950 to-black px-6 py-8',
        )}
      >
        {/* Remote media container is always present so attachTrack() can append audio
            elements even on voice calls. For voice we hide it visually. */}
        <div
          ref={remoteContainerRef}
          className={cn(
            wantVideo
              ? 'absolute inset-0 flex items-center justify-center'
              : 'sr-only',
          )}
        />

        {wantVideo ? (
          <>
            {!hasRemoteVideo && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center gap-3 pointer-events-none">
                <div className={cn(
                  'h-20 w-20 rounded-full flex items-center justify-center text-2xl font-semibold transition-all',
                  remoteSpeaking ? 'bg-emerald-700/50 ring-2 ring-emerald-400/60 scale-105' : 'bg-zinc-800',
                )}>
                  {(visitorName || remoteIdentities[0] || 'V').slice(0, 1).toUpperCase()}
                </div>
                <div className="text-sm text-zinc-300">
                  {phase === 'waiting_for_visitor' && t('callCenter.console.waitingVisitorJoin')}
                  {phase === 'visitor_connected' && t('callCenter.console.waitingVisitorVideo')}
                  {phase === 'visitor_disconnected' && t('callCenter.console.visitorLeft')}
                  {(phase === 'connecting' || phase === 'loading_sdk') && t('callCenter.console.establishing')}
                  {phase === 'reconnecting' && t('callCenter.console.reconnecting')}
                </div>
              </div>
            )}
            <div className="absolute bottom-3 right-3 w-32 h-24 rounded-md overflow-hidden border border-zinc-700 bg-zinc-900 shadow-lg">
              <video ref={localVideoRef} autoPlay muted playsInline
                className={cn('w-full h-full object-cover', !camOn && 'hidden')} />
              {!camOn && (
                <div className="w-full h-full flex items-center justify-center text-zinc-500">
                  <VideoOff className="h-5 w-5" />
                </div>
              )}
            </div>
          </>
        ) : (
          // ── Voice-only professional layout ─────────────────────
          <div className="flex items-center gap-5">
            <div className="relative">
              <div className={cn(
                'h-20 w-20 rounded-full flex items-center justify-center text-2xl font-semibold transition-all',
                'bg-gradient-to-br from-indigo-500/30 to-emerald-500/20 ring-1 ring-zinc-700',
                remoteSpeaking && 'ring-2 ring-emerald-400/80 shadow-[0_0_24px_-4px_rgba(16,185,129,0.55)]',
              )}>
                {(visitorName || remoteIdentities[0] || 'V').slice(0, 1).toUpperCase()}
              </div>
              {remoteSpeaking && (
                <>
                  <span className="absolute inset-0 rounded-full animate-ping bg-emerald-400/20 pointer-events-none" />
                  <span className="absolute -inset-1 rounded-full animate-ping bg-emerald-400/10 pointer-events-none [animation-delay:200ms]" />
                </>
              )}
              <span className={cn(
                'absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full border-2 border-zinc-950',
                phase === 'visitor_connected' ? 'bg-emerald-500'
                  : phase === 'waiting_for_visitor' ? 'bg-amber-400'
                  : phase === 'reconnecting' ? 'bg-amber-500 animate-pulse'
                  : 'bg-zinc-500',
              )} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-base font-semibold truncate">
                {visitorName || remoteIdentities[0] || t('callCenter.console.visitor')}
              </div>
              <div className="text-xs text-zinc-400 mt-0.5 flex items-center gap-2">
                <span>{phase === 'visitor_connected'
                  ? (remoteSpeaking ? t('callCenter.console.speaking') : t('callCenter.console.onTheLine'))
                  : phase === 'waiting_for_visitor' ? t('callCenter.console.waitingVisitorJoin')
                  : phase === 'visitor_disconnected' ? t('callCenter.console.visitorLeft')
                  : phase === 'reconnecting' ? t('callCenter.console.reconnecting')
                  : (phase === 'connecting' || phase === 'loading_sdk') ? t('callCenter.console.establishing')
                  : phaseLabel}</span>
                {isLive && <span className="text-zinc-600">·</span>}
                {isLive && <span className="tabular-nums font-mono text-zinc-300">{fmtDur(duration)}</span>}
              </div>
              {/* Visitor speaking indicator bars */}
              <div className="mt-3 flex items-end gap-1 h-6">
                {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                  <span
                    key={i}
                    className={cn(
                      'w-1.5 rounded-sm bg-emerald-500/70 transition-all duration-150',
                      remoteSpeaking ? '' : 'bg-zinc-800',
                    )}
                    style={{
                      height: remoteSpeaking
                        ? `${20 + Math.abs(Math.sin((Date.now() / 120) + i)) * 80}%`
                        : '20%',
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* End/Status overlay */}
        {showEndedOverlay && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/75 p-6">
            <div className="max-w-sm rounded-md border border-zinc-700 bg-zinc-900/80 p-4 text-center space-y-3">
              <AlertTriangle className={cn('h-5 w-5 mx-auto',
                phase === 'backend_end_failed' || phase === 'reconnect_failed' || phase === 'token_expired' ? 'text-amber-400' : 'text-zinc-300')} />
              <div className="text-sm font-medium">{phaseLabel}</div>
              {errorCode && <div className="text-xs text-zinc-300">{humanError(errorCode)}</div>}
              <div className="flex flex-wrap justify-center gap-2">
                {phase === 'backend_end_failed' && (
                  <Button size="sm" variant="secondary" onClick={retryBackendEnd} disabled={endRetrying}>
                    {endRetrying ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" /> : <RefreshCw className="h-3.5 w-3.5 me-1.5" />}
                    {t('callCenter.console.retryEnd')}
                  </Button>
                )}
                {phase === 'token_expired' && onReconnect && (
                  <Button size="sm" variant="secondary" onClick={handleReconnect} disabled={reconnecting}>
                    {reconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" /> : <RefreshCw className="h-3.5 w-3.5 me-1.5" />}
                    {t('callCenter.console.reconnect')}
                  </Button>
                )}
                {phase === 'reconnect_failed' && onReconnect && (
                  <Button size="sm" variant="secondary" onClick={handleReconnect} disabled={reconnecting}>
                    <RefreshCw className="h-3.5 w-3.5 me-1.5" /> {t('callCenter.console.tryAgain')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Error overlay (pre-connect failures) */}
        {phase === 'error' && errorCode && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-6">
            <div className="max-w-sm rounded-md border border-rose-700/60 bg-rose-950/40 p-4 text-center">
              <AlertTriangle className="h-5 w-5 mx-auto text-rose-400 mb-2" />
              <div className="text-sm font-medium">{t('callCenter.console.cannotConnect')}</div>
              <div className="text-xs text-rose-200 mt-1">{humanError(errorCode)}</div>
            </div>
          </div>
        )}
      </div>

      {/* Local mic level bar */}
      <div className="px-4 pt-2 bg-zinc-900/40">
        <div className="h-1 w-full rounded bg-zinc-800 overflow-hidden">
          <div
            className={cn('h-full transition-[width] duration-75', micOn ? 'bg-emerald-500' : 'bg-zinc-600')}
            style={{ width: `${Math.min(100, Math.round(localLevel * 140))}%` }}
          />
        </div>
        <div className="text-[10px] text-zinc-500 mt-1 flex justify-between">
          <span>
            {t('callCenter.console.yourMic')}
            {micOn ? '' : ` (${t('callCenter.console.mutedSuffix')})`}
          </span>
          <span>{remoteSpeaking ? `🟢 ${t('callCenter.console.visitorSpeaking')}` : ''}</span>
        </div>
      </div>

      {/* Controls — ONE toolbar for the whole call: media, recording,
          transfer and hang-up, in the order an operator reaches for them. */}
      <div className="flex items-center justify-center gap-2 px-4 py-3 bg-zinc-900/80 border-t border-zinc-800 flex-wrap">
        <Button type="button" variant={micOn ? 'secondary' : 'destructive'} size="sm"
          onClick={toggleMic} disabled={!isLive}
          title={micOn ? t('callCenter.console.muteTitle') : t('callCenter.console.unmuteTitle')}>
          {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          <span className="ms-1.5">{micOn ? t('callCenter.console.mute') : t('callCenter.console.unmute')}</span>
        </Button>
        <Button type="button" variant={camOn ? 'secondary' : 'outline'} size="sm"
          onClick={toggleCam} disabled={!wantVideo || !isLive}
          title={wantVideo
            ? (camOn ? t('callCenter.console.cameraOffTitle') : t('callCenter.console.cameraOnTitle'))
            : t('callCenter.console.voiceOnlyTitle')}>
          {camOn ? <VideoIcon className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
          <span className="ms-1.5">{camOn ? t('callCenter.console.cameraOn') : t('callCenter.console.cameraOff')}</span>
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowDevices((v) => !v)}>
          {showDevices ? <ChevronUp className="h-3.5 w-3.5 me-1" /> : <ChevronDown className="h-3.5 w-3.5 me-1" />}
          {t('callCenter.console.devices')}
        </Button>
        {toolbarSlot?.({ isLive })}
        <Button type="button" variant="destructive" size="sm" onClick={handleEnd}
          disabled={phase === 'ending' || phase === 'ended_by_operator'}>
          {phase === 'ending' ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneOff className="h-4 w-4" />}
          <span className="ms-1.5">{t('callCenter.console.endCall')}</span>
        </Button>
      </div>

      {statusSlot && (
        <div className="px-4 py-2 bg-zinc-900/60 border-t border-zinc-800">{statusSlot}</div>
      )}

      {showDevices && (
        <div className="px-4 py-3 bg-zinc-900/60 border-t border-zinc-800 space-y-2 text-xs">
          {!deviceSwitchSupported && (
            <div className="text-[11px] text-amber-300">{t('callCenter.console.deviceSwitchUnsupported')}</div>
          )}
          <div className="flex items-center gap-2">
            <label className="w-20 text-zinc-400">{t('callCenter.console.micLabel')}</label>
            <select
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 disabled:opacity-50"
              value={selectedMic}
              disabled={!deviceSwitchSupported || !isLive}
              onChange={(e) => switchMic(e.target.value)}
            >
              <option value="">{t('callCenter.console.defaultDevice')}</option>
              {micDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
              ))}
            </select>
          </div>
          {wantVideo && (
            <div className="flex items-center gap-2">
              <label className="w-20 text-zinc-400">{t('callCenter.console.cameraLabel')}</label>
              <select
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 disabled:opacity-50"
                value={selectedCam}
                disabled={!deviceSwitchSupported || !isLive}
                onChange={(e) => switchCam(e.target.value)}
              >
                <option value="">{t('callCenter.console.defaultDevice')}</option>
                {camDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                ))}
              </select>
            </div>
          )}
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={refreshDevices}>
              <RefreshCw className="h-3 w-3 me-1.5" /> {t('callCenter.console.refresh')}
            </Button>
          </div>
        </div>
      )}

      <div className="px-4 pb-3 bg-zinc-900/40 text-[10px] text-zinc-500">
        <button className="underline-offset-2 hover:underline" onClick={() => setShowDebug((v) => !v)}>
          {showDebug ? t('callCenter.console.hideDetails') : t('callCenter.console.showDetails')}
        </button>
        {showDebug && (
          <div className="mt-1 space-y-0.5">
            <div>{t('callCenter.console.provider')}: {activeConnect?.provider}</div>
            <div>{t('callCenter.console.room')}: {activeConnect?.room_id}</div>
            <div>{t('callCenter.console.stateLabel')}: {phaseLabel}</div>
            <div>{t('callCenter.console.qualityLabel')}: {qualityLabel}</div>
            {errorCode && <div>{t('callCenter.console.codeLabel')}: {errorCode}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

export default OperatorMediaConsole;
