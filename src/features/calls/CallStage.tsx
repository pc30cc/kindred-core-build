/**
 * Shared LiveKit video / audio attach surface used by both the sidebar
 * call card and the floating operator call window.
 *
 * Carries the production-tested behavior from SidebarCallCard:
 *   - track.attach(el) / track.detach(el) (NEVER manual MediaStream)
 *   - separate <audio> element so video-only mute/stall cannot tear
 *     down audio
 *   - 1Hz freeze watchdog that detach+attach on currentTime stagnation
 *   - per-element diagnostic events (timeupdate / stalled / waiting)
 *   - central real-world orientation correction on every camera video
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { LocalVideoTrack, RemoteAudioTrack, RemoteVideoTrack } from 'livekit-client';
import { Loader2, WifiOff } from 'lucide-react';
import type { useLiveKitCall } from '@/hooks/useLiveKitCall';
import {
  CALL_VIDEO_ORIENTATION_CORRECTION_MODE,
  CALL_VIDEO_STYLE,
  isCallOrientationDebugEnabled,
  logCallVideoOrientation,
} from './videoOrientation';
import { applyVideoOrientationClass } from './videoOrientation';
import { useTranslation } from '@/i18n';

type Remote = ReturnType<typeof useLiveKitCall>['remote'];

interface VideoStageProps {
  remote: Remote;
  /** Visual size variant. Floating window uses `large`. */
  size?: 'small' | 'large';
  debugOrientation?: boolean;
}

function OrientationDebugOverlay({ role, videoRef }: { role: string; videoRef: RefObject<HTMLVideoElement> }) {
  if (!isCallOrientationDebugEnabled()) return null;
  const computed = videoRef.current ? window.getComputedStyle(videoRef.current).transform : 'pending';
  return (
    <div className="pointer-events-none absolute inset-0 z-30 text-call-stage-foreground">
      <div className="absolute left-2 top-1/2 -translate-y-1/2 rounded bg-call-stage/70 px-2 py-1 text-[10px] font-bold">LEFT</div>
      <div className="absolute right-2 top-1/2 -translate-y-1/2 rounded bg-call-stage/70 px-2 py-1 text-[10px] font-bold">RIGHT</div>
      <div className="absolute left-2 top-2 max-w-[calc(100%-16px)] rounded bg-call-stage/80 px-2 py-1 text-[10px] leading-tight">
        <div className="font-bold">REAL ORIENTATION TEST</div>
        <div>{role} · {CALL_VIDEO_ORIENTATION_CORRECTION_MODE}</div>
        <div className="truncate">computed: {computed}</div>
      </div>
    </div>
  );
}

export function VideoCallStage({ remote, size = 'small' }: VideoStageProps) {
  const { t } = useTranslation();
  // The locale files store this under `inbox` as a flat dotted key; a miss
  // falls back to English rather than printing the key path.
  const videoPausedKey = 'inbox.callSurface.videoPaused';
  const videoPausedRaw = (t as unknown as (k: string) => string)(videoPausedKey);
  const videoPausedLabel = videoPausedRaw === videoPausedKey
    ? 'Video paused / reconnecting…'
    : videoPausedRaw;
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const attachedTrackRef = useRef<Record<string, RemoteVideoTrack | null>>({});
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const attachedAudioRef = useRef<Record<string, RemoteAudioTrack | null>>({});
  const blurBgRefs = useRef<Record<string, HTMLVideoElement | null>>({});

  // Video attach / detach.
  useLayoutEffect(() => {
    for (const r of remote) {
      const el = videoRefs.current[r.participantSid];
      if (!el) continue;
      const prev = attachedTrackRef.current[r.participantSid] || null;
      const next = r.videoTrack || null;
      if (prev === next) continue;
      if (prev) {
        try { prev.detach(el); } catch { /* ignore */ }
        try { el.srcObject = null; } catch { /* ignore */ }
      }
      if (next) {
        try { next.attach(el); } catch { /* ignore */ }
        logCallVideoOrientation('operator-remote', el);
        applyVideoOrientationClass(el, 'operator-remote', 'call-video');
        const bg = blurBgRefs.current[r.participantSid];
        if (bg) { try { next.attach(bg); } catch { /* ignore */ } }
        const p = el.play();
        if (p && typeof (p as Promise<void>).catch === 'function') {
          (p as Promise<void>).catch(() => {});
        }
      }
      attachedTrackRef.current[r.participantSid] = next;
    }
    const liveSids = new Set(remote.map((r) => r.participantSid));
    for (const sid of Object.keys(attachedTrackRef.current)) {
      if (liveSids.has(sid)) continue;
      const tr = attachedTrackRef.current[sid];
      const el = videoRefs.current[sid];
      if (tr && el) {
        try { tr.detach(el); } catch { /* ignore */ }
        try { el.srcObject = null; } catch { /* ignore */ }
      }
      const bg = blurBgRefs.current[sid];
      if (tr && bg) { try { tr.detach(bg); } catch { /* ignore */ } }
      attachedTrackRef.current[sid] = null;
      delete attachedTrackRef.current[sid];
    }
  }, [remote]);

  // Freeze watchdog — SDK-level reattach without disconnecting the room.
  useEffect(() => {
    if (remote.length === 0) return;
    const lastTimes: Record<string, { t: number; at: number }> = {};
    const id = setInterval(() => {
      for (const r of remote) {
        const el = videoRefs.current[r.participantSid];
        const tr = r.videoTrack;
        if (!el || !tr) continue;
        const ms = (tr as any).mediaStreamTrack as MediaStreamTrack | undefined;
        if (!ms || ms.readyState !== 'live') continue;
        const now = Date.now();
        const prev = lastTimes[r.participantSid];
        const ct = el.currentTime;
        if (!prev) { lastTimes[r.participantSid] = { t: ct, at: now }; continue; }
        if (ct > prev.t + 0.05) {
          lastTimes[r.participantSid] = { t: ct, at: now };
          continue;
        }
        if (now - prev.at >= 3000) {
          // eslint-disable-next-line no-console
          console.warn('[livekit] remote video watchdog reattach', r.participantSid);
          try { tr.detach(el); } catch { /* ignore */ }
          try { el.srcObject = null; } catch { /* ignore */ }
          try { tr.attach(el); } catch { /* ignore */ }
          logCallVideoOrientation('operator-remote', el);
          const p = el.play();
          if (p && typeof (p as Promise<void>).catch === 'function') {
            (p as Promise<void>).catch(() => {});
          }
          lastTimes[r.participantSid] = { t: el.currentTime, at: now };
        }
      }
    }, 1000);
    return () => clearInterval(id);
  }, [remote]);

  // Audio attach / detach (separate <audio>).
  useLayoutEffect(() => {
    for (const r of remote) {
      const el = audioRefs.current[r.participantSid];
      if (!el) continue;
      const prev = attachedAudioRef.current[r.participantSid] || null;
      const next = r.audioTrack || null;
      if (prev === next) continue;
      if (prev) {
        try { prev.detach(el); } catch { /* ignore */ }
        try { el.srcObject = null; } catch { /* ignore */ }
      }
      if (next) {
        try { next.attach(el); } catch { /* ignore */ }
        const p = el.play();
        if (p && typeof (p as Promise<void>).catch === 'function') {
          (p as Promise<void>).catch(() => {});
        }
      }
      attachedAudioRef.current[r.participantSid] = next;
    }
  }, [remote]);

  useEffect(() => {
    const vRefs = videoRefs.current;
    const vTracks = attachedTrackRef.current;
    const aRefs = audioRefs.current;
    const aTracks = attachedAudioRef.current;
    return () => {
      for (const sid of Object.keys(vTracks)) {
        const tr = vTracks[sid]; const el = vRefs[sid];
        if (tr && el) { try { tr.detach(el); } catch { /* ignore */ } }
      }
      for (const sid of Object.keys(aTracks)) {
        const tr = aTracks[sid]; const el = aRefs[sid];
        if (tr && el) { try { tr.detach(el); } catch { /* ignore */ } }
      }
    };
  }, []);

  if (remote.length === 0) {
    return (
      <div className={size === 'large'
        ? 'h-full w-full bg-call-stage flex items-center justify-center'
        : 'aspect-video w-full rounded-xl border border-border bg-call-stage flex items-center justify-center'}>
        <Loader2 className="w-6 h-6 animate-spin text-call-stage-foreground/60" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className={size === 'large' ? 'h-full w-full' : 'grid gap-2'}>
      {remote.map((r) => (
        <div
          key={r.participantSid}
          className={size === 'large'
            ? 'relative h-full w-full overflow-hidden bg-call-stage call-video-stage'
            : 'relative aspect-video w-full rounded-xl overflow-hidden border border-border bg-call-stage call-video-stage'}
          data-call-video-stage
        >
          {/* Blurred backdrop fill — visible behind portrait remote video
              on a landscape stage. Same media, scaled + blurred. */}
          <video
            ref={(el) => { blurBgRefs.current[r.participantSid] = el; }}
            autoPlay
            playsInline
            muted
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-cover scale-110 blur-2xl opacity-50"
            style={{ transform: 'scale(1.1) scaleX(-1)' }}
          />
          <video
            ref={(el) => {
              videoRefs.current[r.participantSid] = el;
              if (el) {
                logCallVideoOrientation('operator-remote', el);
                applyVideoOrientationClass(el, 'operator-remote', 'call-video');
              }
            }}
            autoPlay
            playsInline
            muted={false}
            className="call-video call-video-remote relative z-[1] w-full h-full object-contain bg-transparent"
            data-call-video
            data-remote-video
            data-call-video-role="operator-remote"
            data-orientation-correction={CALL_VIDEO_ORIENTATION_CORRECTION_MODE}
            style={CALL_VIDEO_STYLE}
            onLoadedMetadata={(e) => applyVideoOrientationClass(e.currentTarget, 'operator-remote', 'call-video')}
            onResize={(e) => applyVideoOrientationClass(e.currentTarget, 'operator-remote', 'call-video')}
          />
          <OrientationDebugOverlay role="operator-remote" videoRef={{ current: videoRefs.current[r.participantSid] }} />
          {!r.videoTrack && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-call-stage/70 text-call-stage-foreground/80">
              <WifiOff className="w-5 h-5" aria-hidden="true" />
              <span className="text-[11px] font-medium">{videoPausedLabel}</span>
            </div>
          )}
          <audio
            ref={(el) => { audioRefs.current[r.participantSid] = el; }}
            autoPlay
            playsInline
            className="sr-only"
          />
        </div>
      ))}
    </div>
  );
}

export function LocalVideoPiP({
  track,
  cameraEnabled,
  className,
}: {
  track: LocalVideoTrack | null | undefined;
  cameraEnabled: boolean;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const attachedRef = useRef<LocalVideoTrack | null>(null);

  useLayoutEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const prev = attachedRef.current;
    const next = track || null;
    if (prev === next) return;
    if (prev) {
      try { prev.detach(el); } catch { /* ignore */ }
      try { el.srcObject = null; } catch { /* ignore */ }
    }
    if (next) {
      try { next.attach(el); } catch { /* ignore */ }
      logCallVideoOrientation('operator-local', el);
      applyVideoOrientationClass(el, 'operator-local', 'call-video');
      const p = el.play();
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => {});
      }
    }
    attachedRef.current = next;
  }, [track]);

  useEffect(() => {
    const el = videoRef.current;
    const tr = attachedRef.current;
    return () => {
      if (tr && el) {
        try { tr.detach(el); } catch { /* ignore */ }
        try { el.srcObject = null; } catch { /* ignore */ }
      }
    };
  }, []);

  return (
    <div className={className}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="call-video call-video-local h-full w-full object-cover bg-call-stage"
        data-call-video
        data-local-video
        data-call-video-role="operator-local"
        data-orientation-correction={CALL_VIDEO_ORIENTATION_CORRECTION_MODE}
        style={CALL_VIDEO_STYLE}
        onLoadedMetadata={(e) => applyVideoOrientationClass(e.currentTarget, 'operator-local', 'call-video')}
        onResize={(e) => applyVideoOrientationClass(e.currentTarget, 'operator-local', 'call-video')}
      />
      <OrientationDebugOverlay role="operator-local" videoRef={videoRef} />
      {(!track || !cameraEnabled) && (
        <div className="absolute inset-0 flex items-center justify-center bg-call-stage text-call-stage-foreground/70 text-[11px] font-medium">
          Camera off
        </div>
      )}
    </div>
  );
}

/** Simple audio-only stage — stable orb + dedicated <audio> per remote. */
export function AudioCallStage({ remote }: { remote: Remote }) {
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const boundRef = useRef<Record<string, string>>({});
  useLayoutEffect(() => {
    for (const r of remote) {
      const el = audioRefs.current[r.participantSid];
      if (!el) continue;
      const prevSid = boundRef.current[r.participantSid] || '';
      if (r.audioTrack) {
        const sid = (r.audioTrack as any).sid || r.audio?.id || '';
        if (prevSid !== sid) {
          try { r.audioTrack.attach(el); } catch { /* ignore */ }
          boundRef.current[r.participantSid] = sid;
        }
        const p = el.play();
        if (p && typeof (p as Promise<void>).catch === 'function') {
          (p as Promise<void>).catch(() => {});
        }
      } else if (prevSid) {
        try { el.srcObject = null; } catch { /* ignore */ }
        boundRef.current[r.participantSid] = '';
      }
    }
  }, [remote]);
  return (
    <div className="relative h-full w-full overflow-hidden bg-gradient-to-br from-call-stage via-call-stage to-primary/20 flex flex-col items-center justify-center gap-6 px-6">
      <div className="relative flex h-32 w-32 items-center justify-center rounded-full bg-primary/15 ring-1 ring-primary/30">
        <div className="absolute inset-0 rounded-full bg-primary/20 animate-ping" aria-hidden="true" />
        <div className="relative h-20 w-20 rounded-full bg-gradient-to-br from-primary/70 to-primary flex items-center justify-center text-2xl font-bold text-primary-foreground shadow-elevated">
          ●
        </div>
      </div>
      <div className="flex items-end gap-1 h-8" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <span
            key={i}
            className="w-1.5 rounded-full bg-primary/60"
            style={{
              animation: `gs-eq 1.1s ease-in-out ${i * 0.08}s infinite alternate`,
              height: '40%',
            }}
          />
        ))}
      </div>
      <style>{`@keyframes gs-eq { 0% { height: 20%; opacity: .55 } 100% { height: 100%; opacity: 1 } }`}</style>
      {remote.map((r) => (
        <audio
          key={r.participantSid}
          ref={(el) => { audioRefs.current[r.participantSid] = el; }}
          autoPlay
          playsInline
        />
      ))}
    </div>
  );
}