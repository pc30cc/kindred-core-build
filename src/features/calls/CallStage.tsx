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
 *   - inline `transform: none` so no future CSS regression mirrors
 *     the operator video
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RemoteAudioTrack, RemoteVideoTrack } from 'livekit-client';
import { Loader2, WifiOff } from 'lucide-react';
import type { useLiveKitCall } from '@/hooks/useLiveKitCall';

type Remote = ReturnType<typeof useLiveKitCall>['remote'];

interface VideoStageProps {
  remote: Remote;
  /** Visual size variant. Floating window uses `large`. */
  size?: 'small' | 'large';
}

export function VideoCallStage({ remote, size = 'small' }: VideoStageProps) {
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const attachedTrackRef = useRef<Record<string, RemoteVideoTrack | null>>({});
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const attachedAudioRef = useRef<Record<string, RemoteAudioTrack | null>>({});

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
      <div className="aspect-video w-full rounded-xl border border-border bg-black flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-white/60" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {remote.map((r) => (
        <div
          key={r.participantSid}
          className={`relative w-full rounded-xl overflow-hidden border border-border bg-black ${
            size === 'large' ? 'aspect-video' : 'aspect-video'
          }`}
        >
          <video
            ref={(el) => { videoRefs.current[r.participantSid] = el; }}
            autoPlay
            playsInline
            muted={false}
            className="call-video call-video-remote w-full h-full object-cover bg-black"
            data-call-video
            data-remote-video
            style={{ transform: 'none' }}
          />
          {!r.videoTrack && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/70 text-white/80">
              <WifiOff className="w-5 h-5" aria-hidden="true" />
              <span className="text-[11px] font-medium">Video paused / reconnecting…</span>
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
    <div className="relative aspect-video w-full rounded-xl overflow-hidden border border-border bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center">
      <div className="w-20 h-20 rounded-full bg-white/5 ring-1 ring-white/10 flex items-center justify-center">
        <div className="w-12 h-12 rounded-full bg-primary/30 animate-pulse" aria-hidden="true" />
      </div>
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