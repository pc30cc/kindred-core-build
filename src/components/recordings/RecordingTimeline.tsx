/**
 * RecordingTimeline — shared, read-only playback UX enhancement.
 *
 * This component is the smallest safe waveform/timeline pass: it does NOT
 * decode the underlying audio buffer (which would force a full download and
 * defeat tokenized Range streaming). Instead it wraps the existing native
 * <audio>/<video> element that already streams via the canonical short-lived
 * tokenized URL and overlays an enhanced scrubber with:
 *
 *   - a click-to-seek progress bar
 *   - hover-preview time
 *   - current time / duration readouts
 *   - ±10s skip controls
 *   - a deterministic, decorative bar field so the timeline reads as a
 *     "waveform-style" track without lying about real amplitude data
 *
 * Strict scope:
 *   - read-only; no annotations, comments, retention, delete, or download
 *   - bound to the same media element used today (single playback engine)
 *   - degrades silently if duration is unknown / metadata fails
 *   - cleans up listeners on unmount; no object URLs are created here
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

export function RecordingTimeline({
  src,
  kind,
  recordingId,
  durationHint,
  className,
  mediaClassName,
}: RecordingTimelineProps) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState<number>(
    typeof durationHint === 'number' && isFinite(durationHint) && durationHint > 0 ? durationHint : 0,
  );
  const [hoverPct, setHoverPct] = useState<number | null>(null);

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

  const bars = useMemo(() => decorativeBars(recordingId), [recordingId]);
  const pct = duration > 0 ? Math.min(1, Math.max(0, current / duration)) : 0;

  function seekToPct(p: number) {
    const el = mediaRef.current;
    if (!el || !(duration > 0)) return;
    const t = Math.max(0, Math.min(duration, p * duration));
    try { el.currentTime = t; } catch { /* ignore */ }
    setCurrent(t);
  }

  function onBarClick(e: React.MouseEvent<HTMLDivElement>) {
    const node = barRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0) return;
    seekToPct((e.clientX - rect.left) / rect.width);
  }
  function onBarMove(e: React.MouseEvent<HTMLDivElement>) {
    const node = barRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0) return;
    setHoverPct(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
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
          onClick={onBarClick}
          onMouseMove={onBarMove}
          onMouseLeave={() => setHoverPct(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') { skip(5); e.preventDefault(); }
            else if (e.key === 'ArrowLeft') { skip(-5); e.preventDefault(); }
          }}
          className="relative h-8 w-full cursor-pointer rounded bg-muted/40 overflow-hidden"
          data-testid={`recording-timeline-bar-${recordingId}`}
        >
          <div className="absolute inset-0 flex items-end gap-[1px] px-[2px] pointer-events-none">
            {bars.map((h, i) => {
              const played = (i + 0.5) / bars.length <= pct;
              return (
                <div
                  key={i}
                  className={played ? 'bg-primary/80' : 'bg-muted-foreground/30'}
                  style={{ height: `${Math.round(h * 100)}%`, flex: 1, borderRadius: 1 }}
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