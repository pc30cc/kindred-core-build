/**
 * RecordingTimeline — shared playback UX with real-waveform scrubbing.
 *
 * Wraps the existing native <audio>/<video> streaming element (tokenized URL,
 * Range-friendly) and overlays a waveform-based scrubber:
 *
 *   - real amplitude peaks decoded via WebAudio (audio kind, opt-out)
 *   - deterministic decorative fallback when decode is unavailable / fails
 *     or for the video kind
 *   - click + drag to scrub, hover-preview time, keyboard arrows
 *     (Shift+Arrow = ±1s, Arrow = ±5s), ±10s skip controls
 *   - current time / duration readouts
 *
 * Strict scope:
 *   - read-only; no annotations, comments, retention, delete, or download
 *   - bound to the same media element used today (single playback engine)
 *   - degrades silently if duration is unknown / metadata fails
 *   - cleans up listeners and aborts in-flight decode on unmount
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

export type RecordingTimelineKind = 'audio' | 'video';

export interface RecordingTimelineProps {
  src: string;
  kind: RecordingTimelineKind;
  /** Stable id used only for deterministic decorative bars + test ids. */
  recordingId: string;
  /** Optional duration hint (seconds) for surfaces that already know it. */
  durationHint?: number | null;
  className?: string;
  mediaClassName?: string;
  /**
   * Attempt real waveform decode (fetch + decodeAudioData). Defaults to true
   * for the audio kind. Set to false to force the decorative fallback.
   */
  enableWaveform?: boolean;
}

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) return '0:00';
  const s = Math.floor(t);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** Deterministic 0..1 bar heights derived from the recording id. */
function decorativeBars(id: string, count = 64): number[] {
  const out: number[] = [];
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  for (let i = 0; i < count; i++) {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    out.push(0.25 + ((h % 1000) / 1000) * 0.75);
  }
  return out;
}

/** Reduce a decoded AudioBuffer to N normalized 0..1 peaks. */
function bufferToPeaks(buffer: AudioBuffer, count = 96): number[] {
  const ch = buffer.getChannelData(0);
  const block = Math.max(1, Math.floor(ch.length / count));
  const peaks: number[] = new Array(count).fill(0);
  let max = 0;
  for (let i = 0; i < count; i++) {
    let peak = 0;
    const start = i * block;
    const end = Math.min(ch.length, start + block);
    for (let j = start; j < end; j++) {
      const v = Math.abs(ch[j]);
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
    if (peak > max) max = peak;
  }
  if (max > 0) {
    for (let i = 0; i < count; i++) peaks[i] = 0.15 + (peaks[i] / max) * 0.85;
  }
  return peaks;
}

export function RecordingTimeline({
  src,
  kind,
  recordingId,
  durationHint,
  className,
  mediaClassName,
  enableWaveform,
}: RecordingTimelineProps) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState<number>(
    typeof durationHint === 'number' && isFinite(durationHint) && durationHint > 0 ? durationHint : 0,
  );
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [decoding, setDecoding] = useState(false);
  const draggingRef = useRef(false);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    const onTime = () => setCurrent(el.currentTime || 0);
    const onMeta = () => {
      if (isFinite(el.duration) && el.duration > 0) setDuration(el.duration);
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onMeta);
    };
  }, [src]);

  // Real waveform decode (audio only, opt-out). Runs once per src.
  useEffect(() => {
    const wantWave = (enableWaveform ?? kind === 'audio') && typeof window !== 'undefined';
    if (!wantWave) { setPeaks(null); return; }
    const AC: typeof AudioContext | undefined =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctrl = new AbortController();
    let cancelled = false;
    let ac: AudioContext | null = null;
    setDecoding(true);
    (async () => {
      try {
        const res = await fetch(src, { signal: ctrl.signal, credentials: 'omit' });
        if (!res.ok) throw new Error(`waveform fetch failed: ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        ac = new AC();
        const decoded: AudioBuffer = await new Promise((resolve, reject) => {
          try {
            const p = (ac as AudioContext).decodeAudioData(
              buf,
              (b) => resolve(b),
              (err) => reject(err),
            );
            if (p && typeof (p as any).then === 'function') {
              (p as unknown as Promise<AudioBuffer>).then(resolve, reject);
            }
          } catch (e) { reject(e); }
        });
        if (cancelled) return;
        setPeaks(bufferToPeaks(decoded));
        if (decoded.duration && decoded.duration > 0) {
          setDuration((d) => (d > 0 ? d : decoded.duration));
        }
      } catch {
        if (!cancelled) setPeaks(null);
      } finally {
        if (!cancelled) setDecoding(false);
        try { ac?.close?.(); } catch { /* ignore */ }
      }
    })();
    return () => {
      cancelled = true;
      try { ctrl.abort(); } catch { /* ignore */ }
      try { ac?.close?.(); } catch { /* ignore */ }
    };
  }, [src, kind, enableWaveform]);

  const fallbackBars = useMemo(() => decorativeBars(recordingId), [recordingId]);
  const bars = peaks && peaks.length > 0 ? peaks : fallbackBars;
  const pct = duration > 0 ? Math.min(1, Math.max(0, current / duration)) : 0;

  function seekToPct(p: number) {
    const el = mediaRef.current;
    if (!el || !(duration > 0)) return;
    const t = Math.max(0, Math.min(duration, p * duration));
    try { el.currentTime = t; } catch { /* ignore */ }
    setCurrent(t);
  }

  function pctFromEvent(clientX: number): number | null {
    const node = barRef.current;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function onBarDown(e: React.MouseEvent<HTMLDivElement>) {
    const p = pctFromEvent(e.clientX);
    if (p == null) return;
    draggingRef.current = true;
    seekToPct(p);
    const onMove = (ev: MouseEvent) => {
      const pp = pctFromEvent(ev.clientX);
      if (pp == null) return;
      setHoverPct(pp);
      seekToPct(pp);
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  function onBarMove(e: React.MouseEvent<HTMLDivElement>) {
    const p = pctFromEvent(e.clientX);
    if (p != null) setHoverPct(p);
  }

  function skip(delta: number) {
    const el = mediaRef.current;
    if (!el) return;
    const next = Math.max(0, Math.min(duration || el.duration || 0, (el.currentTime || 0) + delta));
    try { el.currentTime = next; } catch { /* ignore */ }
    setCurrent(next);
  }

  const mediaCommon = {
    ref: mediaRef as any,
    src,
    controls: true,
    preload: 'metadata' as const,
    className: mediaClassName,
    'data-testid': `recording-timeline-media-${recordingId}`,
  };

  const hoverStyle: CSSProperties | undefined = hoverPct == null
    ? undefined
    : { left: `${hoverPct * 100}%` };

  return (
    <div
      className={className}
      data-testid={`recording-timeline-${recordingId}`}
    >
      {kind === 'video' ? (
        <video {...mediaCommon} />
      ) : (
        <audio {...mediaCommon} />
      )}
      <div className="mt-2 select-none">
        <div
          ref={barRef}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, Math.floor(duration))}
          aria-valuenow={Math.floor(current)}
          tabIndex={0}
          onMouseDown={onBarDown}
          onMouseMove={onBarMove}
          onMouseLeave={() => setHoverPct(null)}
          onKeyDown={(e) => {
            const fine = e.shiftKey ? 1 : 5;
            if (e.key === 'ArrowRight') { skip(fine); e.preventDefault(); }
            else if (e.key === 'ArrowLeft') { skip(-fine); e.preventDefault(); }
            else if (e.key === 'Home') { seekToPct(0); e.preventDefault(); }
            else if (e.key === 'End') { seekToPct(1); e.preventDefault(); }
          }}
          className="relative h-10 w-full cursor-pointer rounded bg-muted/40 overflow-hidden"
          data-testid={`recording-timeline-bar-${recordingId}`}
        >
          <div className="absolute inset-0 flex items-center gap-[1px] px-[2px] pointer-events-none">
            {bars.map((h, i) => {
              const played = (i + 0.5) / bars.length <= pct;
              const barH = Math.max(6, Math.round(h * 100));
              return (
                <div
                  key={i}
                  className={played ? 'bg-primary/80' : 'bg-muted-foreground/30'}
                  style={{ height: `${barH}%`, flex: 1, borderRadius: 1 }}
                />
              );
            })}
          </div>
          <div
            className="absolute top-0 bottom-0 w-px bg-primary pointer-events-none"
            style={{ left: `${pct * 100}%` }}
            data-testid={`recording-timeline-cursor-${recordingId}`}
          />
          {hoverStyle && (
            <div
              className="absolute -top-5 text-[10px] text-muted-foreground bg-background/90 border rounded px-1 py-0.5 pointer-events-none -translate-x-1/2"
              style={hoverStyle}
            >
              {fmt((hoverPct || 0) * (duration || 0))}
            </div>
          )}
          {decoding && !peaks && (
            <div
              className="absolute inset-y-0 right-1 flex items-center text-[9px] text-muted-foreground pointer-events-none"
              data-testid={`recording-timeline-decoding-${recordingId}`}
            >
              …
            </div>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded border px-1 py-0.5 hover:bg-muted"
              onClick={() => skip(-10)}
              data-testid={`recording-timeline-back-${recordingId}`}
              aria-label="Back 10 seconds"
            >
              -10s
            </button>
            <button
              type="button"
              className="rounded border px-1 py-0.5 hover:bg-muted"
              onClick={() => skip(10)}
              data-testid={`recording-timeline-fwd-${recordingId}`}
              aria-label="Forward 10 seconds"
            >
              +10s
            </button>
            <span
              className="ml-1 text-[9px] uppercase tracking-wide opacity-70"
              data-testid={`recording-timeline-mode-${recordingId}`}
            >
              {peaks ? 'waveform' : decoding ? 'decoding' : 'preview'}
            </span>
          </div>
          <div className="font-mono">
            {fmt(current)} / {duration > 0 ? fmt(duration) : '—'}
          </div>
        </div>
      </div>
    </div>
  );
}

export default RecordingTimeline;