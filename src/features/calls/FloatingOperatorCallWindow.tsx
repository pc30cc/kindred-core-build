/**
 * FloatingOperatorCallWindow — survives route changes within AppLayout.
 *
 * Mounted once at AppLayout level next to <Outlet />. Reads the active
 * call from OperatorCallProvider so navigation never disconnects the
 * room. Renders nothing when there is no live or waiting call OR when
 * the operator has minimized into the inbox dock (mode === 'docked')
 * AND the inbox is also showing the surface — i.e. the floating window
 * is the secondary view.
 *
 * UX modes:
 *   - 'docked'    → not floating, sidebar card owns the view
 *   - 'expanded'  → large draggable card bottom-right
 *   - 'minimized' → compact pill bottom-right with status + expand
 */
import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Video, VideoOff, PhoneOff, Maximize2, Minimize2, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useOperatorCall } from './OperatorCallContext';
import { VideoCallStage, AudioCallStage } from './CallStage';

export function FloatingOperatorCallWindow() {
  const { surface, live, floatingMode, setFloatingMode, hangup } = useOperatorCall();
  const isVideo = surface.channel === 'video';
  const showWindow =
    surface.phase !== 'idle' &&
    surface.phase !== 'waiting' &&
    surface.phase !== 'terminal' &&
    floatingMode !== 'docked';

  // Drag state for expanded mode (cheap pointer-based drag, no deps).
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    if (floatingMode !== 'expanded') return;
    const onMove = (e: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const x = start.ox + (e.clientX - start.x);
      const y = start.oy + (e.clientY - start.y);
      // Clamp inside viewport.
      const w = 720; const h = 520;
      const nx = Math.max(8, Math.min(window.innerWidth - w - 8, x));
      const ny = Math.max(8, Math.min(window.innerHeight - h - 8, y));
      setPos({ x: nx, y: ny });
    };
    const onUp = () => { dragStartRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [floatingMode]);

  if (!showWindow) return null;

  const status =
    live.state === 'connecting' ? 'Connecting…' :
    live.state === 'reconnecting' ? 'Reconnecting…' :
    live.state === 'connected' ? 'Live' :
    live.state === 'failed' ? 'Connection failed' :
    surface.phase === 'connecting' ? 'Connecting…' :
    'Live';

  const statusTone =
    live.state === 'connected' ? 'bg-success/15 text-success border-success/30' :
    live.state === 'reconnecting' || live.state === 'connecting' ? 'bg-warning/15 text-warning border-warning/30' :
    live.state === 'failed' ? 'bg-destructive/15 text-destructive border-destructive/30' :
    'bg-muted text-muted-foreground border-border';

  const isMinimized = floatingMode === 'minimized';

  // ─── Minimized pill ───
  if (isMinimized) {
    return (
      <div
        role="dialog"
        aria-label="Call in progress"
        className="fixed bottom-4 right-4 z-[60] flex items-center gap-2 rounded-full bg-card border border-border shadow-elevated px-3 py-2"
      >
        <span className={cn('h-2.5 w-2.5 rounded-full', live.state === 'connected' ? 'bg-success animate-pulse' : 'bg-warning')} aria-hidden="true" />
        <span className="text-[12px] font-medium text-foreground truncate max-w-[180px]">
          {surface.contactName || 'Visitor'} — {status}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 rounded-full"
          onClick={() => setFloatingMode('expanded')}
          aria-label="Expand call window"
          title="Expand"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </Button>
        <Button
          size="sm"
          variant="default"
          className="h-7 w-7 p-0 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
          onClick={() => void hangup()}
          aria-label="End call"
          title="End call"
        >
          <PhoneOff className="w-3.5 h-3.5" />
        </Button>
      </div>
    );
  }

  // ─── Expanded card ───
  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : { right: 16, bottom: 16 };

  return (
    <div
      role="dialog"
      aria-label="Active call"
      className={cn(
        'fixed z-[60] flex flex-col rounded-2xl border border-border bg-card shadow-elevated overflow-hidden',
        'w-[min(90vw,720px)] max-h-[min(90vh,560px)]',
        // Mobile: full-width sheet from bottom.
        'sm:w-[min(90vw,720px)]',
      )}
      style={style}
    >
      {/* Drag handle / header */}
      <div
        className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-card/95 cursor-move select-none touch-none"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
          dragStartRef.current = { x: e.clientX, y: e.clientY, ox: rect.left, oy: rect.top };
          if (!pos) setPos({ x: rect.left, y: rect.top });
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn('h-2.5 w-2.5 rounded-full', live.state === 'connected' ? 'bg-success animate-pulse' : 'bg-warning')} aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-foreground truncate">
              {surface.contactName || 'Visitor'}
            </div>
            <div className="flex items-center gap-1.5">
              <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded border', statusTone)}>
                {status}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {isVideo ? 'Video' : 'Audio'}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={() => setFloatingMode('minimized')}
            aria-label="Minimize call window"
            title="Minimize"
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={() => setFloatingMode('docked')}
            aria-label="Return to inbox dock"
            title="Return to inbox"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Stage */}
      <div className="flex-1 min-h-0 p-3 bg-slate-950/40">
        {surface.phase === 'connecting' ? (
          <div className="aspect-video w-full rounded-xl border border-border bg-black flex items-center justify-center">
            <Loader2 className="w-7 h-7 animate-spin text-white/70" aria-hidden="true" />
          </div>
        ) : isVideo ? (
          <VideoCallStage remote={live.remote} size="large" />
        ) : (
          <AudioCallStage remote={live.remote} />
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-2 px-3 py-3 border-t border-border bg-card/95">
        <Button
          size="sm"
          variant="outline"
          className={cn(
            'h-10 w-10 p-0 rounded-full',
            live.micEnabled ? '' : 'bg-destructive/10 border-destructive/30 text-destructive',
          )}
          onClick={() => void live.toggleMic()}
          aria-label={live.micEnabled ? 'Mute microphone' : 'Unmute microphone'}
        >
          {live.micEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
        </Button>
        {isVideo && (
          <Button
            size="sm"
            variant="outline"
            className={cn(
              'h-10 w-10 p-0 rounded-full',
              live.cameraEnabled ? '' : 'bg-destructive/10 border-destructive/30 text-destructive',
            )}
            onClick={() => void live.toggleCamera()}
            aria-label={live.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
          >
            {live.cameraEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
          </Button>
        )}
        <Button
          size="sm"
          variant="default"
          className="h-10 px-4 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 gap-2"
          onClick={() => void hangup()}
          aria-label="End call"
        >
          <PhoneOff className="w-4 h-4" />
          <span className="text-[12px] font-semibold">End</span>
        </Button>
      </div>
    </div>
  );
}