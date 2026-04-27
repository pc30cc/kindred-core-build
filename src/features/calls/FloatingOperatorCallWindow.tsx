/**
 * FloatingOperatorCallWindow — persistent professional call surface.
 *
 * The LiveKit room is owned by OperatorCallProvider. This component only
 * renders controls/stages from the provider and switches presentation modes;
 * it never starts a second room and never disconnects on navigation.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Mic, MicOff, Video, VideoOff, PhoneOff, Maximize2, Minimize2, PanelRightOpen, Loader2, GripHorizontal, Signal, UserMinus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useOperatorCall } from './OperatorCallContext';
import { VideoCallStage, AudioCallStage, LocalVideoPiP } from './CallStage';

const EXPANDED_W = 860;
const EXPANDED_H = 560;

export function FloatingOperatorCallWindow() {
  const { surface, live, floatingMode, setFloatingMode, hangup, lastEnded } = useOperatorCall();
  const isVideo = surface.channel === 'video';
  const navigate = useNavigate();
  const location = useLocation();
  const { slug } = useParams<{ slug: string }>();
  const isInboxRoute = /\/inbox\/?$/.test(location.pathname);
  const effectiveMode = floatingMode === 'docked' && !isInboxRoute ? 'expanded' : floatingMode;
  // Keep the window visible briefly during the 'remote_ended' terminal
  // state so the operator gets a clear "Visitor ended the call" message
  // instead of the floating window vanishing into thin air.
  const isRemoteEndedTerminal =
    surface.phase === 'terminal' && surface.terminalStatus === 'remote_ended';
  const showWindow =
    surface.phase !== 'idle' &&
    surface.phase !== 'waiting' &&
    (surface.phase !== 'terminal' || isRemoteEndedTerminal) &&
    effectiveMode !== 'docked';

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    if (effectiveMode !== 'expanded') return;
    const onMove = (e: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const width = Math.min(EXPANDED_W, window.innerWidth * 0.85);
      const height = Math.min(EXPANDED_H, window.innerHeight * 0.85);
      const x = start.ox + (e.clientX - start.x);
      const y = start.oy + (e.clientY - start.y);
      setPos({
        x: Math.max(8, Math.min(window.innerWidth - width - 8, x)),
        y: Math.max(8, Math.min(window.innerHeight - height - 8, y)),
      });
    };
    const onUp = () => { dragStartRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [effectiveMode]);

  const hasRemoteVideo = live.remote.some((r) => !!r.videoTrack);
  const status =
    live.state === 'connecting' ? 'Connecting' :
    live.state === 'reconnecting' ? 'Reconnecting' :
    isVideo && surface.phase === 'connected' && !hasRemoteVideo ? 'Camera off' :
    live.state === 'connected' ? 'Live' :
    live.state === 'failed' ? 'Connection failed' :
    surface.phase === 'connecting' ? 'Connecting' :
    'Live';

  const statusTone =
    live.state === 'connected' ? 'bg-success/20 text-success border-success/40' :
    live.state === 'reconnecting' || live.state === 'connecting' ? 'bg-warning/20 text-warning border-warning/40' :
    live.state === 'failed' ? 'bg-destructive/20 text-destructive border-destructive/40' :
    'bg-muted/70 text-muted-foreground border-border';

  const title = surface.contactName || 'Visitor';
  const expandedStyle: CSSProperties = useMemo(() => {
    if (pos) return { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' };
    return { right: 24, bottom: 24 };
  }, [pos]);

  const stop = (fn: () => void | Promise<void>) => (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    void fn();
  };

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (effectiveMode !== 'expanded') return;
    if ((e.target as HTMLElement).closest('button')) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    dragStartRef.current = { x: e.clientX, y: e.clientY, ox: rect.left, oy: rect.top };
    if (!pos) setPos({ x: rect.left, y: rect.top });
  };

  const dockToInbox = () => {
    if (slug && !isInboxRoute) navigate(`/app/w/${slug}/inbox`);
    setFloatingMode('docked');
  };

  if (!showWindow) return null;

  const isMinimized = effectiveMode === 'minimized';

  return (
    <div
      role="dialog"
      aria-label="Active call"
      className={cn(
        'fixed z-[70] flex overflow-hidden border border-border bg-card shadow-elevated ring-1 ring-foreground/10',
        isMinimized
          ? 'bottom-4 right-4 h-16 w-[min(92vw,390px)] flex-row items-center gap-3 rounded-full bg-card/95 px-3 py-2 backdrop-blur-xl'
          : 'h-[min(85vh,560px)] w-[min(85vw,860px)] min-w-[520px] flex-col rounded-xl bg-call-stage max-sm:inset-x-2 max-sm:bottom-2 max-sm:h-[78vh] max-sm:w-auto max-sm:min-w-0',
      )}
      style={isMinimized ? undefined : expandedStyle}
    >
      <div
        className={cn(
          isMinimized
            ? 'relative z-20 flex min-w-0 flex-1 select-none items-center justify-between gap-2 text-foreground'
            : 'absolute inset-x-0 top-0 z-20 flex cursor-move select-none items-center justify-between gap-3 bg-gradient-to-b from-call-stage/90 via-call-stage/55 to-transparent px-4 pb-8 pt-3 text-call-stage-foreground touch-none',
        )}
        onPointerDown={isMinimized ? undefined : startDrag}
      >
        <div className="flex min-w-0 items-center gap-3">
          {!isMinimized && <GripHorizontal className="h-4 w-4 shrink-0 text-call-stage-foreground/55" aria-hidden="true" />}
          {isMinimized && <span className={cn('h-3 w-3 shrink-0 rounded-full ring-4 ring-success/10', live.state === 'connected' ? 'bg-success animate-pulse' : 'bg-warning')} aria-hidden="true" />}
          <div className="min-w-0">
            <div className={cn('truncate font-semibold drop-shadow-sm', isMinimized ? 'text-[13px]' : 'text-sm')}>{title}{isMinimized ? ` · ${status}` : ''}</div>
            <div className={cn('mt-1 flex items-center gap-2', isMinimized && 'hidden')}>
              <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase leading-none backdrop-blur-md', statusTone)}>
                {status}
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-call-stage-foreground/70">
                <Signal className="h-3 w-3" aria-hidden="true" /> Stable media
              </span>
              <span className="text-[11px] font-medium text-call-stage-foreground/70">{isVideo ? 'Video call' : 'Audio call'}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className={cn('h-9 rounded-full px-3', isMinimized ? 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary' : 'bg-call-stage-foreground/10 text-call-stage-foreground hover:bg-call-stage-foreground/20 hover:text-call-stage-foreground')} onClick={stop(() => setFloatingMode(isMinimized ? 'expanded' : 'minimized'))} aria-label={isMinimized ? 'Expand call window' : 'Minimize call window'} title={isMinimized ? 'Expand' : 'Minimize'}>
            {isMinimized ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
            {isMinimized && <span className="text-[12px] font-bold">Expand</span>}
          </Button>
          {!isMinimized && (
            <Button size="sm" variant="ghost" className="h-8 w-8 rounded-full bg-call-stage-foreground/10 p-0 text-call-stage-foreground hover:bg-call-stage-foreground/20 hover:text-call-stage-foreground" onClick={stop(dockToInbox)} aria-label="Return to inbox dock" title="Return to inbox">
              <PanelRightOpen className="h-4 w-4" />
            </Button>
          )}
          {isMinimized && (
            <Button size="sm" variant="default" className="h-8 w-8 rounded-full bg-destructive p-0 text-destructive-foreground hover:bg-destructive/90" onClick={stop(hangup)} aria-label="End call" title="End call">
              <PhoneOff className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div className={cn(
        'bg-call-stage',
        isMinimized
          ? 'pointer-events-none absolute -left-[10000px] top-0 h-px w-px overflow-hidden opacity-0'
          : 'relative min-h-0 flex-1 overflow-hidden',
      )}>
        {surface.phase === 'connecting' ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-call-stage text-call-stage-foreground/75">
            <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
            <span className="text-sm font-medium">Connecting media…</span>
          </div>
        ) : isVideo ? (
          <VideoCallStage remote={live.remote} size="large" />
        ) : (
          <AudioCallStage remote={live.remote} />
        )}

        {isVideo && surface.phase === 'connected' && (
          <LocalVideoPiP
            track={live.localVideoTrack}
            cameraEnabled={live.cameraEnabled}
            className="absolute bottom-24 right-5 z-20 aspect-[3/4] w-[136px] overflow-hidden rounded-lg border border-call-stage-foreground/30 bg-call-stage shadow-elevated ring-1 ring-call-stage-foreground/15 max-sm:bottom-24 max-sm:right-3 max-sm:w-[98px]"
          />
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-44 bg-gradient-to-t from-call-stage via-call-stage/70 to-transparent" aria-hidden="true" />
        <div className="absolute inset-x-0 bottom-0 z-30 flex items-center justify-center gap-3 px-4 pb-5 pt-10">
          <Button size="sm" variant="outline" className={cn('h-12 w-12 rounded-full border-call-stage-foreground/20 bg-card/75 p-0 text-foreground shadow-elevated backdrop-blur-xl hover:bg-card', !live.micEnabled && 'border-destructive/40 bg-destructive/15 text-destructive')} onClick={stop(live.toggleMic)} aria-label={live.micEnabled ? 'Mute microphone' : 'Unmute microphone'} title={live.micEnabled ? 'Mute microphone' : 'Unmute microphone'}>
            {live.micEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          </Button>
          {isVideo && (
            <Button size="sm" variant="outline" className={cn('h-12 w-12 rounded-full border-call-stage-foreground/20 bg-card/75 p-0 text-foreground shadow-elevated backdrop-blur-xl hover:bg-card', !live.cameraEnabled && 'border-destructive/40 bg-destructive/15 text-destructive')} onClick={stop(live.toggleCamera)} aria-label={live.cameraEnabled ? 'Turn camera off' : 'Turn camera on'} title={live.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}>
              {live.cameraEnabled ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
            </Button>
          )}
          <Button size="sm" variant="default" className="h-12 rounded-full bg-destructive px-6 text-destructive-foreground shadow-elevated hover:bg-destructive/90" onClick={stop(hangup)} aria-label="End call" title="End call">
            <PhoneOff className="h-5 w-5" />
            <span className="text-[13px] font-bold">End</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
