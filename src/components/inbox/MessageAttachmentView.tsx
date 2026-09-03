/**
 * Shared attachment renderers for operator-side surfaces (Inbox + Colleagues).
 * Extracted from InboxPage so team chat renders identical media bubbles.
 * Media always streams through the backend proxy; provider URLs never reach
 * the client.
 */
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Download, X, Play, Pause, Mic } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = RESOLVED_API_BASE || '';

export function humanSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

/** Operator-side stream proxy — session auth + workspace membership. */
export function attachmentUrl(id: string, disposition?: 'attachment'): string {
  return `${API_BASE}/api/conversation-attachments/${encodeURIComponent(id)}/file${
    disposition ? `?disposition=${disposition}` : ''
  }`;
}

function clockTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/**
 * Voice/audio player for inbound and outbound audio attachments. Streams from
 * the operator proxy (Range-enabled) so seeking works on long recordings.
 *
 * The transport is FORCED LTR (`dir="ltr"`): a timeline reads left→right in
 * every locale, so play stays on the left, the progress bar fills to the
 * right and download sits on the right — also in Persian/RTL.
 */
function AudioAttachmentPlayer({
  att,
  isAgent,
}: {
  att: { id: string; file_name: string; size_bytes: number };
  isAgent: boolean;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [rate, setRate] = useState(1);

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) { void el.play()?.catch(() => setPlaying(false)); } else { el.pause(); }
  };
  const cycleRate = () => {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
    if (ref.current) ref.current.playbackRate = next;
  };

  const seekFromClientX = (clientX: number) => {
    const el = ref.current;
    const box = trackRef.current?.getBoundingClientRect();
    if (!el || !box || !box.width || !Number.isFinite(el.duration) || el.duration <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    el.currentTime = ratio * el.duration;
    setCurrent(el.currentTime);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    seekFromClientX(e.clientX);
    const move = (ev: PointerEvent) => seekFromClientX(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const bufPct = duration > 0 ? Math.min(100, (buffered / duration) * 100) : 0;

  return (
    <div
      dir="ltr"
      className={cn(
        'group/audio flex items-center gap-2.5 rounded-full ps-1.5 pe-3 py-1.5 w-[264px] max-w-full border shadow-sm transition-colors',
        isAgent
          ? 'bg-primary-foreground/10 border-primary-foreground/20'
          : 'bg-background/80 border-border hover:bg-background',
      )}
    >
      <audio
        ref={ref}
        src={attachmentUrl(att.id)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrent(0); }}
        onWaiting={() => setLoading(true)}
        onCanPlay={() => setLoading(false)}
        onError={() => setLoading(false)}
        onLoadedMetadata={(e) => {
          setDuration((e.target as HTMLAudioElement).duration || 0);
          setLoading(false);
        }}
        onProgress={(e) => {
          const el = e.target as HTMLAudioElement;
          if (el.buffered.length) setBuffered(el.buffered.end(el.buffered.length - 1));
        }}
        onTimeUpdate={(e) => setCurrent((e.target as HTMLAudioElement).currentTime || 0)}
        className="hidden"
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
        className={cn(
          'relative w-9 h-9 rounded-full flex items-center justify-center shrink-0',
          'transition-transform duration-150 hover:scale-105 active:scale-95',
          isAgent
            ? 'bg-primary-foreground text-primary'
            : 'bg-primary text-primary-foreground shadow-sm shadow-primary/25',
        )}
      >
        {loading && (
          <span className="absolute inset-[3px] rounded-full border-2 border-current/25 border-t-current animate-spin" />
        )}
        {playing ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 ms-0.5 fill-current" />}
      </button>

      <div className="flex-1 min-w-0">
        <div
          ref={trackRef}
          onPointerDown={onPointerDown}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          tabIndex={0}
          className="relative h-1 rounded-full cursor-pointer bg-current/15 before:absolute before:inset-x-0 before:-inset-y-2 before:content-['']"
        >
          <div className="absolute inset-y-0 left-0 rounded-full bg-current/20" style={{ width: `${bufPct}%` }} />
          <div
            className={cn('absolute inset-y-0 left-0 rounded-full', isAgent ? 'bg-primary-foreground' : 'bg-primary')}
            style={{ width: `${pct}%` }}
          >
            <span
              className={cn(
                'absolute -right-[5px] top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full shadow',
                'opacity-0 group-hover/audio:opacity-100 transition-opacity',
                isAgent ? 'bg-primary-foreground' : 'bg-primary',
                playing && 'opacity-100',
              )}
            />
          </div>
        </div>
        <div className="flex items-center justify-between mt-1.5 text-[10px] tabular-nums opacity-75">
          <span className="inline-flex items-center gap-1">
            <Mic className="w-3 h-3" />
            <span>{clockTime(current)}{duration > 0 ? ` / ${clockTime(duration)}` : ''}</span>
          </span>
          <button
            type="button"
            onClick={cycleRate}
            className="px-1 rounded transition-colors hover:bg-current/10"
          >
            {rate}×
          </button>
        </div>
      </div>

      <a
        href={attachmentUrl(att.id, 'attachment')}
        download={att.file_name}
        className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
        aria-label="Download"
      >
        <Download className="w-3.5 h-3.5" />
      </a>
    </div>
  );
}

/**
 * Image attachment — undistorted thumbnail (intrinsic ratio preserved inside a
 * max box) that opens a JS lightbox instead of navigating to a new tab.
 */
function ImageAttachment({ att, url }: { att: { id: string; file_name: string }; url: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);



  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative block rounded-lg overflow-hidden border border-border bg-muted/40 cursor-zoom-in leading-none transition-transform hover:scale-[1.01]"
      >
        {failed ? (
          <span className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground">
            <FileText className="w-4 h-4" /> {att.file_name}
          </span>
        ) : (
          <>
            {/* Never show an empty bubble while the authenticated fetch runs. */}
            {!loaded && (
              <span className="flex items-center justify-center gap-2 w-[150px] h-[88px] text-[12px] text-muted-foreground">
                <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin opacity-70" />
                {t('inbox.receivingFile') || 'Receiving…'}
              </span>
            )}
            <img
              src={url}
              alt={att.file_name}
              loading="lazy"
              decoding="async"
              onLoad={() => setLoaded(true)}
              onError={() => { setLoaded(true); setFailed(true); }}
              className={cn(
                'block w-auto h-auto max-w-[180px] max-h-[200px] object-contain',
                // Do not use display:none here. Combined with loading="lazy"
                // it prevents the browser from ever requesting the image,
                // leaving the receiving placeholder visible forever.
                loaded ? 'opacity-100' : 'absolute inset-0 opacity-0 pointer-events-none',
              )}
            />
          </>
        )}

      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm p-6 animate-in fade-in duration-150"
            onClick={() => setOpen(false)}
            role="dialog"
            aria-modal="true"
            aria-label={att.file_name}
          >
            <img
              src={url}
              alt={att.file_name}
              onClick={(e) => e.stopPropagation()}
              className="max-w-full max-h-full object-contain rounded-lg shadow-2xl animate-in zoom-in-95 duration-150"
            />
            <div className="absolute top-4 end-4 flex items-center gap-2">
              <a
                href={attachmentUrl(att.id, 'attachment')}
                download={att.file_name}
                onClick={(e) => e.stopPropagation()}
                className="w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center transition-colors"
                aria-label="Download"
              >
                <Download className="w-4 h-4" />
              </a>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Attachment renderer for inbox messages — images render inline, audio gets
 * a player, video gets a native player, everything else is a download card.
 * Media always streams through the backend proxy; provider URLs never reach
 * the client.
 */
export function MessageAttachmentView({
  att,
  t,
  isAgent = false,
}: {
  att: { id: string; file_name: string; mime_type: string; size_bytes: number; kind: string };
  t: (key: any) => string;
  isAgent?: boolean;
}) {
  const url = attachmentUrl(att.id);
  const mime = att.mime_type || '';
  const isImage = att.kind === 'image' || /^image\//.test(mime);
  const isAudio = att.kind === 'audio' || /^audio\//.test(mime);
  const isVideo = att.kind === 'video' || /^video\//.test(mime);

  if (isImage) {
    return <ImageAttachment att={att} url={url} />;
  }
  if (isAudio) {
    return <AudioAttachmentPlayer att={att} isAgent={isAgent} />;
  }
  if (isVideo) {
    return (
      <video src={url} controls preload="metadata" className="block max-w-[300px] rounded-lg border border-border" />
    );
  }

  return (
    <a
      href={attachmentUrl(att.id, 'attachment')}
      target="_blank"
      rel="noopener noreferrer"
      download={att.file_name}
      className="flex items-center gap-2.5 rounded-lg border border-border bg-background/60 px-2.5 py-2 max-w-[280px] hover:bg-background transition-colors"
    >
      <div className="w-8 h-8 rounded-md bg-secondary flex items-center justify-center shrink-0 text-muted-foreground">
        <FileText className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-medium text-foreground truncate">{att.file_name}</div>
        <div className="text-[10px] text-muted-foreground">{humanSize(att.size_bytes)}</div>
      </div>
      <Download className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
    </a>
  );
}

