/**
 * FloatingOperatorCallWindow — persistent professional call surface.
 *
 * The LiveKit room is owned by OperatorCallProvider. This component only
 * renders controls/stages from the provider and switches presentation modes;
 * it never starts a second room and never disconnects on navigation.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Mic, MicOff, Video, VideoOff, PhoneOff, Maximize2, Minimize2, PanelRightOpen, Loader2, GripHorizontal, Signal, UserMinus, Settings2, ArrowRightLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useOperatorCall } from './OperatorCallContext';
import { VideoCallStage, AudioCallStage, LocalVideoPiP } from './CallStage';
import { useTranslation } from '@/i18n';
import { useCallCenterAgentPresence, useTransferCall } from '@/hooks/useCallCenter';
import { useWorkspaceMembers } from '@/hooks/useWorkspaceMembers';
import { useAuth } from '@/features/auth/AuthContext';
import { toast } from '@/hooks/use-toast';

const EXPANDED_W = 860;
const EXPANDED_H = 560;
// Portrait-shaped window when the remote stream is vertical (mobile visitor).
const EXPANDED_PORTRAIT_W = 380;
const EXPANDED_PORTRAIT_H = 640;

export function FloatingOperatorCallWindow() {
  const { surface, live, floatingMode, setFloatingMode, hangup, closeTerminal, lastEnded, videoQuality, setVideoQuality } = useOperatorCall();
  const i18n = useTranslation();
  const { user } = useAuth();
  const workspaceId = surface.workspaceId || null;
  const callId = surface.invitation?.call_session_id || null;
  const presence = useCallCenterAgentPresence(workspaceId);
  const members = useWorkspaceMembers(workspaceId || undefined);
  const transferMut = useTransferCall(workspaceId || undefined);
  const [transferOpen, setTransferOpen] = useState(false);
  const availableTargets = useMemo(() => {
    const rows = presence.data?.presence || [];
    const memberMap = new Map((members.data || []).map((m) => [m.user_id, m]));
    return rows
      .filter((p) => p.user_id !== user?.id)
      .filter((p) => p.status === 'available')
      .map((p) => ({
        user_id: p.user_id,
        name: memberMap.get(p.user_id)?.full_name || memberMap.get(p.user_id)?.email || p.user_id.slice(0, 8),
        status: p.status,
      }));
  }, [presence.data, members.data, user?.id]);
  const doTransfer = async (agentId: string) => {
    if (!callId || !workspaceId) return;
    try {
      await transferMut.mutateAsync({ callId, payload: { to_agent_id: agentId, reason: 'operator_transfer' } });
      setTransferOpen(false);
      toast({ title: 'Call transferred', description: 'Routing to the selected operator…' });
    } catch (e: any) {
      toast({ title: 'Transfer failed', description: String(e?.message || e), variant: 'destructive' });
    }
  };
  const safeT = (key: string, fallback: string): string => {
    const value = (i18n.t as unknown as (k: string) => string)(key);
    return value && value !== key ? value : fallback;
  };
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
    surface.phase === 'terminal' &&
    (surface.terminalStatus === 'remote_ended' || surface.terminalStatus === 'connect_failed_remote');
  const isConnectFailedRemoteTerminal =
    surface.phase === 'terminal' && surface.terminalStatus === 'connect_failed_remote';
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
  // Detect remote orientation from the first published remote video track
  // so we can resize/restyle the whole floating window to match — no more
  // black bars next to a portrait phone stream.
  const [remoteOrientation, setRemoteOrientation] = useState<'portrait' | 'landscape' | 'square' | null>(null);
  const firstRemoteVideoTrack = live.remote[0]?.videoTrack || null;
  useEffect(() => {
    if (!firstRemoteVideoTrack) { setRemoteOrientation(null); return; }
    const ms: MediaStreamTrack | undefined = (firstRemoteVideoTrack as any).mediaStreamTrack;
    if (!ms) return;
    let cancelled = false;
    const probe = () => {
      if (cancelled) return;
      const settings = ms.getSettings ? ms.getSettings() : ({} as MediaTrackSettings);
      const w = settings.width || 0;
      const h = settings.height || 0;
      if (!w || !h) return;
      const next: 'portrait' | 'landscape' | 'square' =
        h > w * 1.05 ? 'portrait' : w > h * 1.05 ? 'landscape' : 'square';
      setRemoteOrientation((prev) => (prev === next ? prev : next));
    };
    probe();
    const id = window.setInterval(probe, 1000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [firstRemoteVideoTrack]);
  // Also listen at the DOM layer — videoOrientation already toggles the
  // [data-video-orientation] attribute on the stage element.
  useEffect(() => {
    if (!isVideo) return;
    const root = document.querySelector('[data-call-video-stage]') as HTMLElement | null;
    if (!root) return;
    const sync = () => {
      const v = root.getAttribute('data-video-orientation');
      if (v === 'portrait' || v === 'landscape' || v === 'square') {
        setRemoteOrientation((prev) => (prev === v ? prev : v));
      }
    };
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(root, { attributes: true, attributeFilter: ['data-video-orientation'] });
    return () => obs.disconnect();
  }, [isVideo, firstRemoteVideoTrack]);
  const isPortraitStage = isVideo && remoteOrientation === 'portrait';
  const status =
    isRemoteEndedTerminal ? safeT('inbox.callSurface.callEnded', 'Call ended') :
    live.state === 'connecting' ? safeT('inbox.callSurface.statusConnecting', 'Connecting') :
    live.state === 'reconnecting' ? safeT('inbox.callSurface.statusReconnecting', 'Reconnecting') :
    isVideo && surface.phase === 'connected' && !hasRemoteVideo ? safeT('inbox.callSurface.cameraOffStatus', 'Camera off') :
    live.state === 'connected' ? safeT('inbox.callSurface.statusLive', 'Live') :
    live.state === 'failed' ? safeT('inbox.callSurface.statusFailed', 'Connection failed') :
    surface.phase === 'connecting' ? safeT('inbox.callSurface.statusConnecting', 'Connecting') :
    safeT('inbox.callSurface.statusLive', 'Live');

  const statusTone =
    isRemoteEndedTerminal ? 'bg-muted/70 text-muted-foreground border-border' :
    live.state === 'connected' ? 'bg-success/20 text-success border-success/40' :
    live.state === 'reconnecting' || live.state === 'connecting' ? 'bg-warning/20 text-warning border-warning/40' :
    live.state === 'failed' ? 'bg-destructive/20 text-destructive border-destructive/40' :
    'bg-muted/70 text-muted-foreground border-border';

  const title = surface.contactName || safeT('inbox.visitor', 'Visitor');
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
    if (slug && !isInboxRoute) navigate(`/${slug}/inbox`);
    setFloatingMode('docked');
  };

  if (!showWindow) return null;

  const isMinimized = effectiveMode === 'minimized';

  return (
    <div
      role="dialog"
      aria-label={safeT('inbox.callSurface.callDuration', 'Active call')}
      className={cn(
        'fixed z-[70] flex overflow-hidden border border-border bg-card shadow-elevated ring-1 ring-foreground/10',
        isMinimized
          ? 'bottom-4 right-4 h-16 w-[min(92vw,390px)] flex-row items-center gap-3 rounded-full bg-card/95 px-3 py-2 backdrop-blur-xl'
          : isPortraitStage
            ? 'h-[min(88vh,640px)] w-[min(85vw,380px)] min-w-[300px] flex-col rounded-xl bg-call-stage max-sm:inset-x-2 max-sm:bottom-2 max-sm:h-[80vh] max-sm:w-auto max-sm:min-w-0'
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
                <Signal className="h-3 w-3" aria-hidden="true" /> {safeT('inbox.callSurface.stableMedia', 'Stable media')}
              </span>
              <span className="text-[11px] font-medium text-call-stage-foreground/70">{isVideo ? safeT('inbox.callSurface.videoCall', 'Video call') : safeT('inbox.callSurface.audioCall', 'Audio call')}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className={cn('h-9 rounded-full px-3', isMinimized ? 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary' : 'bg-call-stage-foreground/10 text-call-stage-foreground hover:bg-call-stage-foreground/20 hover:text-call-stage-foreground')} onClick={stop(() => setFloatingMode(isMinimized ? 'expanded' : 'minimized'))} aria-label={isMinimized ? safeT('inbox.callSurface.expandAria', 'Expand call window') : safeT('inbox.callSurface.minimizeAria', 'Minimize call window')} title={isMinimized ? safeT('inbox.callSurface.expand', 'Expand') : safeT('inbox.callSurface.minimize', 'Minimize')}>
            {isMinimized ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
            {isMinimized && <span className="text-[12px] font-bold">{safeT('inbox.callSurface.expand', 'Expand')}</span>}
          </Button>
          {!isMinimized && (
            <Button size="sm" variant="ghost" className="h-8 w-8 rounded-full bg-call-stage-foreground/10 p-0 text-call-stage-foreground hover:bg-call-stage-foreground/20 hover:text-call-stage-foreground" onClick={stop(dockToInbox)} aria-label={safeT('inbox.callSurface.returnInbox', 'Return to inbox')} title={safeT('inbox.callSurface.returnInbox', 'Return to inbox')}>
              <PanelRightOpen className="h-4 w-4" />
            </Button>
          )}
          {isMinimized && (
            <Button size="sm" variant="default" className="h-8 w-8 rounded-full bg-destructive p-0 text-destructive-foreground hover:bg-destructive/90" onClick={stop(hangup)} aria-label={safeT('inbox.callSurface.hangup', 'End call')} title={safeT('inbox.callSurface.hangup', 'End call')}>
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
      )}
        data-portrait-stage={isPortraitStage ? 'true' : 'false'}
      >
        {isRemoteEndedTerminal ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-call-stage px-6 text-center text-call-stage-foreground">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-call-stage-foreground/10 ring-1 ring-call-stage-foreground/20">
              <UserMinus className="h-7 w-7 text-call-stage-foreground/85" aria-hidden="true" />
            </div>
            <div className="text-base font-semibold">
              {isConnectFailedRemoteTerminal
                ? safeT('inbox.callSurface.visitorConnectFailed', 'Visitor failed to connect')
                : (lastEnded?.ended_by === 'visitor'
                    ? safeT('inbox.callSurface.visitorEndedCall', 'Visitor ended the call')
                    : safeT('inbox.callSurface.visitorLeft', 'Visitor left the call'))}
            </div>
            {isConnectFailedRemoteTerminal ? (
              <div className="text-[13px] font-medium text-call-stage-foreground/70">
                {safeT('inbox.callSurface.visitorConnectFailedHint', 'Call could not be established')}
              </div>
            ) : (lastEnded && lastEnded.duration_seconds > 0 && (
              <div className="text-[13px] font-medium text-call-stage-foreground/70">
                {String(Math.floor(lastEnded.duration_seconds / 60)).padStart(2, '0')}
                {':'}
                {String(lastEnded.duration_seconds % 60).padStart(2, '0')}
              </div>
            ))}
          </div>
        ) : surface.phase === 'connecting' ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-call-stage text-call-stage-foreground/75">
            <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
            <span className="text-sm font-medium">{safeT('inbox.callSurface.establishing', 'Connecting media…')}</span>
          </div>
        ) : isVideo ? (
          <VideoCallStage remote={live.remote} size="large" />
        ) : (
          <AudioCallStage remote={live.remote} />
        )}

        {isVideo && surface.phase === 'connected' && !isRemoteEndedTerminal && (
          <LocalVideoPiP
            track={live.localVideoTrack}
            cameraEnabled={live.cameraEnabled}
            className={cn(
              'absolute z-20 overflow-hidden rounded-lg border border-call-stage-foreground/30 bg-call-stage shadow-elevated ring-1 ring-call-stage-foreground/15',
              isPortraitStage
                ? 'bottom-24 right-3 h-[120px] w-[88px] max-sm:bottom-24 max-sm:right-2 max-sm:h-[104px] max-sm:w-[78px]'
                : 'bottom-24 right-5 h-[160px] w-[120px] max-sm:bottom-24 max-sm:right-3 max-sm:h-[124px] max-sm:w-[92px]',
            )}
          />
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-44 bg-gradient-to-t from-call-stage via-call-stage/70 to-transparent" aria-hidden="true" />
        <div className="absolute inset-x-0 bottom-0 z-30 flex items-center justify-center gap-3 px-4 pb-5 pt-10">
          {!isRemoteEndedTerminal && (
            <Button size="sm" variant="outline" className={cn('h-12 w-12 rounded-full border-call-stage-foreground/20 bg-card/75 p-0 text-foreground shadow-elevated backdrop-blur-xl hover:bg-card', !live.micEnabled && 'border-destructive/40 bg-destructive/15 text-destructive')} onClick={stop(live.toggleMic)} aria-label={live.micEnabled ? safeT('inbox.callSurface.muteMic', 'Mute microphone') : safeT('inbox.callSurface.unmuteMic', 'Unmute microphone')} title={live.micEnabled ? safeT('inbox.callSurface.muteMic', 'Mute microphone') : safeT('inbox.callSurface.unmuteMic', 'Unmute microphone')}>
              {live.micEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
            </Button>
          )}
          {!isRemoteEndedTerminal && isVideo && (
            <Button size="sm" variant="outline" className={cn('h-12 w-12 rounded-full border-call-stage-foreground/20 bg-card/75 p-0 text-foreground shadow-elevated backdrop-blur-xl hover:bg-card', !live.cameraEnabled && 'border-destructive/40 bg-destructive/15 text-destructive')} onClick={stop(live.toggleCamera)} aria-label={live.cameraEnabled ? safeT('inbox.callSurface.cameraOff', 'Turn camera off') : safeT('inbox.callSurface.cameraOn', 'Turn camera on')} title={live.cameraEnabled ? safeT('inbox.callSurface.cameraOff', 'Turn camera off') : safeT('inbox.callSurface.cameraOn', 'Turn camera on')}>
              {live.cameraEnabled ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
            </Button>
          )}
          {!isRemoteEndedTerminal && isVideo && surface.phase === 'connected' && (
            <Select value={videoQuality} onValueChange={(v) => void setVideoQuality(v as any)}>
              <SelectTrigger className="h-12 w-auto gap-2 rounded-full border-call-stage-foreground/20 bg-card/75 px-3 text-foreground shadow-elevated backdrop-blur-xl hover:bg-card">
                <Settings2 className="h-4 w-4" />
                <span className="text-[12px] font-bold uppercase">{videoQuality}</span>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="auto">{safeT('inbox.callSurface.qualityAuto', 'Auto')}</SelectItem>
                <SelectItem value="low">{safeT('inbox.callSurface.qualityLow', 'Low (360p)')}</SelectItem>
                <SelectItem value="medium">{safeT('inbox.callSurface.qualityMedium', 'Medium (540p)')}</SelectItem>
                <SelectItem value="high">{safeT('inbox.callSurface.qualityHigh', 'High (720p)')}</SelectItem>
                <SelectItem value="hd">{safeT('inbox.callSurface.qualityHd', 'HD (1080p)')}</SelectItem>
              </SelectContent>
            </Select>
          )}
          {!isRemoteEndedTerminal && surface.phase === 'connected' && callId && (
            <Popover open={transferOpen} onOpenChange={setTransferOpen}>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" className="h-12 w-12 rounded-full border-call-stage-foreground/20 bg-card/75 p-0 text-foreground shadow-elevated backdrop-blur-xl hover:bg-card" aria-label="Transfer call" title="Transfer call">
                  <ArrowRightLeft className="h-5 w-5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-2">
                <div className="px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Transfer to</div>
                {availableTargets.length === 0 ? (
                  <div className="px-2 py-3 text-sm text-muted-foreground">No available operators</div>
                ) : (
                  <div className="flex max-h-64 flex-col gap-1 overflow-auto py-1">
                    {availableTargets.map((t) => (
                      <button
                        key={t.user_id}
                        type="button"
                        onClick={() => void doTransfer(t.user_id)}
                        disabled={transferMut.isPending}
                        className="flex items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                      >
                        <span className="truncate font-medium">{t.name}</span>
                        <span className="text-[10px] font-bold uppercase text-success">{t.status}</span>
                      </button>
                    ))}
                  </div>
                )}
              </PopoverContent>
            </Popover>
          )}
          <Button size="sm" variant="default" className="h-12 rounded-full bg-destructive px-6 text-destructive-foreground shadow-elevated hover:bg-destructive/90" onClick={stop(isRemoteEndedTerminal ? closeTerminal : hangup)} aria-label={isRemoteEndedTerminal ? safeT('inbox.callSurface.close', 'Close') : safeT('inbox.callSurface.hangup', 'End call')} title={isRemoteEndedTerminal ? safeT('inbox.callSurface.close', 'Close') : safeT('inbox.callSurface.hangup', 'End call')}>
            <PhoneOff className="h-5 w-5" />
            <span className="text-[13px] font-bold">{isRemoteEndedTerminal ? safeT('inbox.callSurface.close', 'Close') : safeT('inbox.callSurface.hangup', 'End')}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
