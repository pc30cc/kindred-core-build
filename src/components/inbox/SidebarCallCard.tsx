/**
 * SidebarCallCard — invitation entry point + in-place call surface inside
 * the inbox sidebar. State lives in OperatorCallProvider so route changes
 * never tear down the active LiveKit room.
 *
 * Modes:
 *   - IDLE for this conversation:        invite buttons + last-invite pill
 *   - WAITING / CONNECTING / CONNECTED:  channel-specific surface
 *   - TERMINAL:                          brief outcome, auto-revert
 *   - Active call belongs to a DIFFERENT conversation → show a compact
 *     "open active call" link rather than offering new invites.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone, Video, Loader2, X, CheckCircle2, Clock, Ban, PhoneOff, RotateCw,
  Mic, MicOff, VideoOff, Maximize2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import {
  type CallInvitation,
  type InvitationChannel,
  type InvitationStatus,
} from '@/lib/call-invitations-api';
import { useQuery } from '@tanstack/react-query';
import { InviteWaitDialog } from './InviteWaitDialog';
import { useLocalMediaPreview, type LocalPreviewState } from '@/hooks/useLocalMediaPreview';
import { useOperatorCall } from '@/features/calls/OperatorCallContext';
import { VideoCallStage, AudioCallStage } from '@/features/calls/CallStage';
import { usePlanAccess } from '@/hooks/useEntitlements';
import { fetchLimitUsage } from '@/lib/entitlements-api';
import {
  CALL_VIDEO_ORIENTATION_CORRECTION_MODE,
  CALL_VIDEO_STYLE,
  isCallOrientationDebugEnabled,
  logCallVideoOrientation,
} from '@/features/calls/videoOrientation';

interface SidebarCallCardProps {
  workspaceId: string;
  conversationId: string;
  contactName?: string | null;
  /** Notify the parent inbox so it can keep the sidebar mounted while a
   *  call is active for this conversation. */
  onActiveCallChange?: (conversationId: string | null) => void;
}

interface StatusVisual {
  Icon: React.ComponentType<{ className?: string }>;
  className: string;
  labelKey: string;
}

const STATUS_VISUAL: Record<InvitationStatus, StatusVisual> = {
  pending:   { Icon: Loader2,      className: 'bg-warning/10 border-warning/30 text-warning',                 labelKey: 'inbox.callInvite.statusPending' },
  joined:    { Icon: CheckCircle2, className: 'bg-success/10 border-success/30 text-success',                 labelKey: 'inbox.callInvite.statusJoined' },
  expired:   { Icon: Clock,        className: 'bg-muted border-border text-muted-foreground',                 labelKey: 'inbox.callInvite.statusExpired' },
  cancelled: { Icon: Ban,          className: 'bg-muted/60 border-border text-muted-foreground',              labelKey: 'inbox.callInvite.statusCancelled' },
  declined:  { Icon: PhoneOff,     className: 'bg-destructive/10 border-destructive/30 text-destructive',     labelKey: 'inbox.callInvite.statusDeclined' },
};

export function SidebarCallCard({ workspaceId, conversationId, contactName, onActiveCallChange }: SidebarCallCardProps) {
  const i18n = useTranslation();
  const safeT = (key: string, fallback = '', vars?: Record<string, string>): string => {
    const value = (i18n.t as unknown as (k: string, v?: Record<string, string>) => string)(key, vars);
    return value && value !== key ? value : fallback;
  };
  const t = (key: string, vars?: Record<string, string>): string => safeT(key, '', vars);

  const {
    surface, creating, loading, live, preview,
    floatingMode, setFloatingMode,
    latestForConversation, sendInvite, cancelInvite, hangup, closeTerminal, refreshLatest, lastEnded,
  } = useOperatorCall();

  const latest = latestForConversation(conversationId);
  const [, forceTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [dialogChannel, setDialogChannel] = useState<InvitationChannel | null>(null);

  // ── Plan-level entitlement gating ────────────────────────────────────
  // Drives visibility/disabled-state of the Audio/Video invite buttons
  // and the surrounding card. Server still enforces (returns 403
  // plan_forbidden / limit_reached), but the UI honors the effective
  // state up-front so operators don't see an Apply button they can't use.
  const plan = usePlanAccess(workspaceId);
  const planReady = plan.status === 'ready';
  const planVoiceVideoEnabled = plan.module('voice_video');
  const planVoiceEnabled = plan.channel('voice');
  const planVideoEnabled = plan.channel('video');
  // Numeric limits come from the snapshot; current usage from the same
  // resolvers the server's call gates count with, so "at the cap" here is
  // exactly what the server will answer. Only block when a finite cap is set
  // AND usage has been read AND it is at or over the cap.
  const { data: limitUsage } = useQuery({
    queryKey: ['limit-usage', workspaceId, 'calls'],
    enabled: !!workspaceId && planReady,
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: () => fetchLimitUsage(workspaceId, ['max_concurrent_calls', 'max_call_minutes_per_month']),
  });
  const reached = (limitKey: string) => {
    const cap = plan.limit(limitKey);
    const used = limitUsage?.usage[limitKey];
    return typeof cap === 'number' && cap !== -1 && !!used?.supported && used.value >= cap;
  };
  const concurrentReached = reached('max_concurrent_calls');
  const minutesReached = reached('max_call_minutes_per_month');

  // Notify parent when an active call belongs to this conversation.
  useEffect(() => {
    if (surface.phase !== 'idle' && surface.conversationId === conversationId) {
      onActiveCallChange?.(conversationId);
    } else if (surface.conversationId !== conversationId) {
      onActiveCallChange?.(null);
    }
  }, [surface.phase, surface.conversationId, conversationId, onActiveCallChange]);

  // Refresh latest invite for this conversation on mount + every 4–20s.
  useEffect(() => {
    void refreshLatest(conversationId);
  }, [conversationId, refreshLatest]);
  useEffect(() => {
    const interval = latest?.status === 'pending' ? 4000 : 20000;
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => { void refreshLatest(conversationId); }, interval);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [latest?.status, conversationId, refreshLatest]);

  // Ticker for countdown displays.
  useEffect(() => {
    const needsTicker = latest?.status === 'pending' ||
      (surface.phase === 'waiting' && surface.conversationId === conversationId);
    if (!needsTicker) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [latest?.status, surface.phase, surface.conversationId, conversationId]);

  const formatRemaining = useCallback((expiresAt: string): string => {
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) return t('inbox.callInvite.expired') || 'Expired';
    const total = Math.ceil(ms / 1000);
    let timeStr: string;
    if (total < 60) {
      timeStr = (t('inbox.callInvite.secondsShort', { s: String(total) }) || `${total}s`);
    } else {
      const m = Math.floor(total / 60);
      const s = total % 60;
      timeStr = s === 0
        ? (t('inbox.callInvite.minutesShort', { m: String(m) }) || `${m}m`)
        : (t('inbox.callInvite.minutesSeconds', { m: String(m), s: String(s) }) || `${m}m ${s}s`);
    }
    return t('inbox.callInvite.timeLeft', { time: timeStr }) || `${timeStr} left`;
  }, [t]);

  // ── Invite creation ─────────────────────────────────────────────────
  const openInviteDialog = useCallback((channel: InvitationChannel) => {
    if (creating || latest?.status === 'pending' || surface.phase !== 'idle') return;
    setDialogChannel(channel);
  }, [creating, latest?.status, surface.phase]);

  const handleConfirmWait = useCallback((seconds: number) => {
    if (!dialogChannel) return;
    void sendInvite({
      workspaceId,
      conversationId,
      contactName: contactName ?? null,
      channel: dialogChannel,
      ttlSeconds: seconds,
    }).then(() => {
      setDialogChannel(null);
      toast({
        title: dialogChannel === 'video'
          ? (t('inbox.callInvite.videoSent') || 'Video invite sent')
          : (t('inbox.callInvite.audioSent') || 'Audio invite sent'),
        description: t('inbox.callInvite.sentDesc') || 'Visitor can join from the conversation card.',
      });
    });
  }, [dialogChannel, workspaceId, conversationId, contactName, sendInvite, t]);

  const closeDialog = useCallback(() => {
    if (creating) return;
    setDialogChannel(null);
  }, [creating]);

  // ── Derived ─────────────────────────────────────────────────────────
  const visual = useMemo(() => latest ? STATUS_VISUAL[latest.status] : null, [latest]);
  const isPending = latest?.status === 'pending';
  const isTerminal = !!latest && !isPending;
  const lastChannel: InvitationChannel = latest?.channel === 'video' ? 'video' : 'audio';
  const planBlocked = !planVoiceVideoEnabled;
  const limitBlocked = concurrentReached || minutesReached;
  const disableAudio =
    loading || creating !== null || isPending || surface.phase !== 'idle'
    || planBlocked || !planVoiceEnabled || limitBlocked;
  const disableVideo =
    loading || creating !== null || isPending || surface.phase !== 'idle'
    || planBlocked || !planVideoEnabled || limitBlocked;
  const disableInvites = disableAudio && disableVideo;

  // Surface belongs to THIS conversation?
  const surfaceMatches = surface.phase !== 'idle' && surface.conversationId === conversationId;
  // Active call is for a DIFFERENT conversation.
  const otherActive = surface.phase !== 'idle' && surface.conversationId && surface.conversationId !== conversationId;

  const isVideo = surface.channel === 'video';
  const ChannelIcon = isVideo ? Video : Phone;
  const accentBg = isVideo ? 'bg-violet-500/5' : 'bg-warning/5';
  const accentText = isVideo ? 'text-violet-600 dark:text-violet-400' : 'text-warning';
  const accentRing = isVideo ? 'ring-violet-500/30' : 'ring-warning/30';

  const surfaceTitle =
    surface.phase === 'waiting'
      ? (isVideo
          ? (t('inbox.callSurface.waitingVideoTitle') || 'Waiting for visitor — video')
          : (t('inbox.callSurface.waitingAudioTitle') || 'Waiting for visitor — audio'))
      : surface.phase === 'connecting'
        ? (t('inbox.callSurface.connecting') || 'Connecting…')
        : surface.phase === 'connected'
          ? (isVideo
              ? (t('inbox.callSurface.connectedVideo') || 'Video call in progress')
              : (t('inbox.callSurface.connectedAudio') || 'Audio call in progress'))
          : (t('inbox.callSurface.ended') || 'Call ended');

  const terminalLabel = (() => {
    switch (surface.terminalStatus) {
      case 'expired':   return t('inbox.callSurface.terminalExpired')   || 'The visitor did not join in time.';
      case 'declined':  return t('inbox.callSurface.terminalDeclined')  || 'The visitor declined the call.';
      case 'cancelled': return t('inbox.callSurface.terminalCancelled') || 'Invitation cancelled.';
      case 'remote_ended': {
        const base = lastEnded?.ended_by === 'visitor'
          ? safeT('inbox.callSurface.visitorEndedCall', 'Visitor ended the call')
          : safeT('inbox.callSurface.visitorLeft', 'Visitor left the call');
        if (!lastEnded || lastEnded.duration_seconds <= 0) return base;
        const mm = String(Math.floor(lastEnded.duration_seconds / 60)).padStart(2, '0');
        const ss = String(lastEnded.duration_seconds % 60).padStart(2, '0');
        return `${base} · ${mm}:${ss}`;
      }
      case 'connect_failed_remote':
        return safeT(
          'inbox.callSurface.visitorConnectFailed',
          'Visitor failed to connect',
        );
      case 'failed':    return surface.errorMessage
        ? `${t('inbox.callSurface.terminalFailed') || 'Could not connect.'} ${surface.errorMessage}`
        : (t('inbox.callSurface.terminalFailed') || 'Could not connect.');
      default: return null;
    }
  })();

  const TerminalIcon =
    surface.terminalStatus === 'declined' ? PhoneOff
    : surface.terminalStatus === 'cancelled' ? Ban
    : surface.terminalStatus === 'expired' ? Clock
    : surface.terminalStatus === 'failed' ? PhoneOff
    : CheckCircle2;

  const remainingLabel = surface.invitation && surface.phase === 'waiting' && surfaceMatches
    ? (() => {
        const ms = new Date(surface.invitation.expires_at).getTime() - Date.now();
        if (ms <= 0) return t('inbox.callSurface.expiringNow') || 'Expiring…';
        const total = Math.ceil(ms / 1000);
        if (total < 60) return (t('inbox.callInvite.secondsShort', { s: String(total) }) || `${total}s`);
        const m = Math.floor(total / 60);
        const s = total % 60;
        return s === 0
          ? (t('inbox.callInvite.minutesShort', { m: String(m) }) || `${m}m`)
          : (t('inbox.callInvite.minutesSeconds', { m: String(m), s: String(s) }) || `${m}m ${s}s`);
      })()
    : null;

  // ── Active surface for THIS conversation ────────────────────────────
  if (surfaceMatches && floatingMode === 'docked') {
    return (
      <>
        <Card
          className={cn('border-border/70 shadow-sm overflow-hidden ring-1 ring-inset', accentRing)}
          role="region"
          aria-label={surfaceTitle}
        >
          <CardHeader className={cn('pb-2 border-b border-border', accentBg)}>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-xs font-semibold flex items-center gap-1.5 text-foreground min-w-0">
                <span className={cn('inline-flex items-center justify-center w-5 h-5 rounded-md bg-background shrink-0', accentText)}>
                  <ChannelIcon className="w-3 h-3" aria-hidden="true" />
                </span>
                <span className="truncate">{surfaceTitle}</span>
              </CardTitle>
              {surface.phase === 'connected' && (
                <Button
                  size="sm"
                  variant="default"
                  className="h-8 shrink-0 gap-1.5 rounded-full px-3 text-[11px] font-bold shadow-sm"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setFloatingMode('expanded'); }}
                  aria-label={t('inbox.callSurface.expand') || 'Expand call window'}
                  title={t('inbox.callSurface.expand') || 'Expand call window'}
                >
                  <Maximize2 className="w-4 h-4" />
                  <span>{t('inbox.callSurface.expand') || 'Expand'}</span>
                </Button>
              )}
            </div>
            {contactName && (
              <p className="text-[10px] text-muted-foreground truncate ms-6.5">{contactName}</p>
            )}
          </CardHeader>

          <CardContent className="pt-2.5 space-y-2.5">
            {surface.phase === 'waiting' && (
              <>
                {isVideo
                  ? <VideoWaitingTile previewStream={preview.stream} previewState={preview.state} />
                  : <AudioWaitingTile previewStream={preview.stream} previewState={preview.state} />}
                <div className="flex items-center justify-between gap-2">
                  <Badge className="h-5 px-1.5 text-[10px] font-semibold gap-1 border bg-warning/10 border-warning/30 text-warning">
                    <Loader2 className="w-2.5 h-2.5 animate-spin" aria-hidden="true" />
                    <span aria-live="polite" className="tabular-nums">{remainingLabel}</span>
                  </Badge>
                  <span className="text-[10px] text-muted-foreground truncate">
                    {contactName
                      ? (t('inbox.callInvite.waitingFor', { name: contactName }) || `Waiting for ${contactName}…`)
                      : (t('inbox.callInvite.waitingForVisitor') || 'Waiting for visitor…')}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full h-8 text-[11px] font-semibold gap-1.5 hover:bg-destructive/10 hover:border-destructive/30 hover:text-destructive transition-colors"
                  onClick={() => void cancelInvite()}
                  disabled={loading}
                >
                  {loading
                    ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                    : <X className="w-3 h-3" aria-hidden="true" />}
                  {t('inbox.callSurface.cancel') || 'Cancel invitation'}
                </Button>
              </>
            )}

            {surface.phase === 'connecting' && (
              <div className="py-4 flex flex-col items-center justify-center gap-2 text-center">
                <Loader2 className={cn('w-6 h-6 animate-spin', accentText)} aria-hidden="true" />
                <div className="text-[11px] text-muted-foreground">
                  {t('inbox.callSurface.establishing') || 'Establishing media connection…'}
                </div>
              </div>
            )}

            {surface.phase === 'connected' && (
              <>
                {isVideo
                  ? <VideoCallStage remote={live.remote} />
                  : <AudioCallStage remote={live.remote} />}
                <div className="flex items-center justify-center gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn(
                      'h-8 w-8 p-0 rounded-full',
                      live.micEnabled ? '' : 'bg-destructive/10 border-destructive/30 text-destructive',
                    )}
                    onClick={() => void live.toggleMic()}
                    aria-label={live.micEnabled ? 'Mute microphone' : 'Unmute microphone'}
                  >
                    {live.micEnabled ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
                  </Button>
                  {isVideo && (
                    <Button
                      size="sm"
                      variant="outline"
                      className={cn(
                        'h-8 w-8 p-0 rounded-full',
                        live.cameraEnabled ? '' : 'bg-destructive/10 border-destructive/30 text-destructive',
                      )}
                      onClick={() => void live.toggleCamera()}
                      aria-label={live.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
                    >
                      {live.cameraEnabled ? <Video className="w-3.5 h-3.5" /> : <VideoOff className="w-3.5 h-3.5" />}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="default"
                    className="h-8 px-3 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 gap-1.5"
                    onClick={() => void hangup()}
                    aria-label={safeT('inbox.callSurface.hangup', 'End call')}
                  >
                    <PhoneOff className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="text-[11px] font-semibold">{t('inbox.callSurface.hangup') || 'End'}</span>
                  </Button>
                </div>
              </>
            )}

            {surface.phase === 'terminal' && (
              <div className="py-3 flex flex-col items-center text-center gap-2">
                <div className={cn(
                  'w-9 h-9 rounded-full flex items-center justify-center',
                  surface.terminalStatus === 'failed' || surface.terminalStatus === 'declined'
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-muted text-muted-foreground',
                )}>
                  <TerminalIcon className="w-4 h-4" aria-hidden="true" />
                </div>
                <div className="text-[11px] text-foreground font-medium">
                  {terminalLabel}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[10px] text-muted-foreground"
                  onClick={() => closeTerminal()}
                >
                  {safeT('inbox.callSurface.close', 'Close')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <InviteWaitDialog
          open={dialogChannel !== null}
          channel={dialogChannel ?? 'audio'}
          submitting={creating !== null}
          onCancel={closeDialog}
          onConfirm={handleConfirmWait}
        />
      </>
    );
  }

  // ── Active surface is in THIS conversation but operator floated it
  //    out — show a "return" button so the inbox slot is not empty.
  if (surfaceMatches && floatingMode !== 'docked') {
    return (
      <Card className="border-border/70 shadow-sm">
        <CardContent className="p-3 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-success animate-pulse" aria-hidden="true" />
          <span className="text-[11px] font-medium text-foreground flex-1 truncate">
            {isVideo ? safeT('inbox.callSurface.videoCall', 'Video call') : safeT('inbox.callSurface.audioCall', 'Audio call')} — {safeT('inbox.callSurface.openInFloating', 'open in floating window')}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10px] gap-1"
            onClick={() => setFloatingMode('docked')}
          >
            {t('inbox.callSurface.returnHere') || 'Return here'}
          </Button>
          <Button
            size="sm"
            variant="default"
            className="h-7 w-7 p-0 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => void hangup()}
            aria-label={safeT('inbox.callSurface.hangup', 'End call')}
          >
            <PhoneOff className="w-3 h-3" />
          </Button>
        </CardContent>
      </Card>
    );
  }

  // ── Active call is for ANOTHER conversation ────────────────────────
  if (otherActive) {
    return (
      <Card className="border-border/70 shadow-sm">
        <CardContent className="p-3 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-warning animate-pulse" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-medium text-foreground truncate">
              {safeT('inbox.callSurface.activeOtherConv', 'Active call in another conversation')}
            </div>
            <div className="text-[10px] text-muted-foreground truncate">
              {safeT('inbox.callSurface.activeOtherConvHint', 'End it before starting a new one')}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10px]"
            onClick={() => setFloatingMode('expanded')}
          >
            {safeT('inbox.callSurface.activeOpen', 'Open')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // ── IDLE — invite buttons + last-invite pill ────────────────────────
  return (
    <>
      <Card className="border-border/70 shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-semibold flex items-center gap-1.5 text-foreground">
            <Phone className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            {t('inbox.sidebarCall.title') || 'Call visitor'}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          {isPending && latest && visual && (
            <div
              className={cn(
                'flex items-center gap-2 rounded-md border px-2 py-1.5 ring-1 ring-inset',
                latest.channel === 'video'
                  ? 'bg-violet-500/5 border-violet-500/30 ring-violet-500/30'
                  : 'bg-warning/5 border-warning/30 ring-warning/30',
              )}
              role="status"
              aria-live="polite"
            >
              {latest.channel === 'video'
                ? <Video className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400 shrink-0" aria-hidden="true" />
                : <Phone className="h-3.5 w-3.5 text-warning shrink-0" aria-hidden="true" />}
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold text-foreground truncate">
                  {contactName
                    ? (t('inbox.callInvite.waitingFor', { name: contactName }) || `Waiting for ${contactName}…`)
                    : (t('inbox.callInvite.waitingForVisitor') || 'Waiting for visitor…')}
                </div>
                <div className="text-[10px] text-muted-foreground tabular-nums">
                  {formatRemaining(latest.expires_at)}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                onClick={() => void cancelInvite()}
                disabled={loading}
                aria-label={t('inbox.callInvite.cancel') || 'Cancel invitation'}
                title={t('inbox.callInvite.cancel') || 'Cancel invitation'}
              >
                {loading
                  ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                  : <X className="w-3 h-3" aria-hidden="true" />}
              </Button>
            </div>
          )}

          {isTerminal && latest && visual && (
            <div className="flex items-center gap-1.5">
              <Badge
                className={cn('h-5 px-1.5 text-[10px] font-semibold gap-1 border', visual.className)}
                title={`${t('inbox.callInvite.lastInvite') || 'Last invite'}: ${t(visual.labelKey) || visual.labelKey}`}
              >
                <visual.Icon className="w-2.5 h-2.5" aria-hidden="true" />
                <span>{t(visual.labelKey) || visual.labelKey}</span>
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground gap-1 ms-auto"
                onClick={() => openInviteDialog(lastChannel)}
                disabled={loading || creating !== null}
              >
                {creating === lastChannel
                  ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                  : <RotateCw className="w-3 h-3" aria-hidden="true" />}
                {t('inbox.callInvite.resend') || 'Resend'}
              </Button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2 text-[11px] font-semibold gap-1.5 hover:bg-warning/5 hover:border-warning/40 hover:text-warning transition-colors"
              onClick={() => openInviteDialog('audio')}
              disabled={disableAudio}
              aria-label={t('inbox.callInvite.audioAria') || 'Invite visitor to an audio call'}
              title={
                planBlocked ? safeT('inbox.sidebarCall.planBlocked', 'Voice & Video is not included in your plan')
                : !planVoiceEnabled ? safeT('inbox.sidebarCall.voiceLocked', 'Voice calls are not included in your plan')
                : concurrentReached ? safeT('inbox.sidebarCall.limitConcurrent', 'Concurrent call limit reached on your plan')
                : minutesReached ? safeT('inbox.sidebarCall.limitMinutes', 'Monthly call minutes exhausted')
                : (t('inbox.callInvite.inviteAudio') || 'Invite to audio')
              }
            >
              {creating === 'audio'
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                : <Phone className="w-3.5 h-3.5" aria-hidden="true" />}
              <span className="truncate">{t('inbox.callInvite.audio') || 'Audio'}</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2 text-[11px] font-semibold gap-1.5 hover:bg-violet-500/5 hover:border-violet-500/40 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
              onClick={() => openInviteDialog('video')}
              disabled={disableVideo}
              aria-label={t('inbox.callInvite.videoAria') || 'Invite visitor to a video call'}
              title={
                planBlocked ? safeT('inbox.sidebarCall.planBlocked', 'Voice & Video is not included in your plan')
                : !planVideoEnabled ? safeT('inbox.sidebarCall.videoLocked', 'Video calls are not included in your plan')
                : concurrentReached ? safeT('inbox.sidebarCall.limitConcurrent', 'Concurrent call limit reached on your plan')
                : minutesReached ? safeT('inbox.sidebarCall.limitMinutes', 'Monthly call minutes exhausted')
                : (t('inbox.callInvite.inviteVideo') || 'Invite to video')
              }
            >
              {creating === 'video'
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                : <Video className="w-3.5 h-3.5" aria-hidden="true" />}
              <span className="truncate">{t('inbox.callInvite.video') || 'Video'}</span>
            </Button>
          </div>

          {planReady && (planBlocked || !planVoiceEnabled || !planVideoEnabled || limitBlocked) && (
            <p className="text-[10px] text-warning leading-snug">
              {planBlocked
                ? safeT('inbox.sidebarCall.planBlocked', 'Voice & Video is not included in your plan')
                : concurrentReached
                  ? safeT('inbox.sidebarCall.limitConcurrent', 'Concurrent call limit reached on your plan')
                  : minutesReached
                    ? safeT('inbox.sidebarCall.limitMinutes', 'Monthly call minutes exhausted')
                    : !planVoiceEnabled && !planVideoEnabled
                      ? safeT('inbox.sidebarCall.channelsLocked', 'Voice/Video channels are not enabled on your plan')
                      : !planVoiceEnabled
                        ? safeT('inbox.sidebarCall.voiceLocked', 'Voice calls are not included in your plan')
                        : safeT('inbox.sidebarCall.videoLocked', 'Video calls are not included in your plan')}
            </p>
          )}

          {!isPending && !isTerminal && !planBlocked && !limitBlocked && planVoiceEnabled && planVideoEnabled && (
            <p className="text-[10px] text-muted-foreground leading-snug">
              {t('inbox.sidebarCall.hint') || 'Send an invitation — the visitor joins from their chat when ready.'}
            </p>
          )}
        </CardContent>
      </Card>

      <InviteWaitDialog
        open={dialogChannel !== null}
        channel={dialogChannel ?? 'audio'}
        submitting={creating !== null}
        onCancel={closeDialog}
        onConfirm={handleConfirmWait}
      />
    </>
  );
}

// ─── Channel-specific waiting tiles (kept here, sidebar-only) ────────

interface WaitingTileProps {
  previewStream: MediaStream | null;
  previewState: LocalPreviewState;
}

function AudioWaitingTile({ previewStream, previewState }: WaitingTileProps) {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!previewStream) { setLevel(0); return; }
    const AudioCtx: typeof AudioContext | undefined =
      window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(previewStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        setLevel(Math.min(1, sum / (data.length * 128)));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* analyser unavailable */ }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      if (audioCtxRef.current) {
        try { void audioCtxRef.current.close(); } catch { /* noop */ }
        audioCtxRef.current = null;
      }
      setLevel(0);
    };
  }, [previewStream]);

  const live = previewState === 'ready';
  return (
    <div className="rounded-lg bg-warning/5 border border-warning/20 px-3 py-3 flex items-center gap-3">
      <div className="relative">
        <div className="w-9 h-9 rounded-full bg-warning/10 flex items-center justify-center text-warning">
          <Phone className="w-4 h-4" aria-hidden="true" />
        </div>
        <span className="absolute inset-0 rounded-full ring-2 ring-warning/30 animate-ping" aria-hidden="true" />
      </div>
      <div className="flex-1 flex items-end gap-1 h-6" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => {
          const dist = Math.abs(i - 3);
          const target = live
            ? Math.max(4, Math.min(22, level * 24 * (1 - dist * 0.18) + 4))
            : 10 + ((i * 7) % 14);
          return (
            <span
              key={i}
              className={cn(
                'block w-1 rounded-sm transition-all duration-150',
                live ? 'bg-warning' : 'bg-warning/40 animate-pulse',
              )}
              style={{ height: `${target}px`, animationDelay: `${i * 90}ms` }}
            />
          );
        })}
      </div>
    </div>
  );
}

function VideoWaitingTile({ previewStream, previewState }: WaitingTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (previewStream) {
      if (el.srcObject !== previewStream) el.srcObject = previewStream;
      logCallVideoOrientation('operator-local-waiting', el);
    } else {
      el.srcObject = null;
    }
  }, [previewStream]);
  const showVideo = previewState === 'ready' && !!previewStream;
  return (
    <div className="relative aspect-video w-full rounded-lg overflow-hidden border border-violet-500/20 bg-gradient-to-br from-violet-500/10 via-violet-500/5 to-transparent">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={cn(
          'call-video call-video-local absolute inset-0 w-full h-full object-cover bg-call-stage transition-opacity duration-200',
          showVideo ? 'opacity-100' : 'opacity-0',
        )}
        data-call-video
        data-local-video
        data-call-video-role="operator-local-waiting"
        data-orientation-correction={CALL_VIDEO_ORIENTATION_CORRECTION_MODE}
        style={CALL_VIDEO_STYLE}
      />
      {isCallOrientationDebugEnabled() && (
        <div className="pointer-events-none absolute inset-0 z-20 text-call-stage-foreground">
          <div className="absolute left-2 top-1/2 -translate-y-1/2 rounded bg-call-stage/70 px-2 py-1 text-[10px] font-bold">LEFT</div>
          <div className="absolute right-2 top-1/2 -translate-y-1/2 rounded bg-call-stage/70 px-2 py-1 text-[10px] font-bold">RIGHT</div>
          <div className="absolute left-2 top-2 rounded bg-call-stage/80 px-2 py-1 text-[10px] leading-tight">
            <div className="font-bold">REAL ORIENTATION TEST</div>
            <div>operator-local-waiting · {CALL_VIDEO_ORIENTATION_CORRECTION_MODE}</div>
          </div>
        </div>
      )}
      {!showVideo && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <div className="relative">
            <div className="w-12 h-12 rounded-full bg-violet-500/10 flex items-center justify-center text-violet-600 dark:text-violet-400">
              {previewState === 'denied'
                ? <VideoOff className="w-5 h-5" aria-hidden="true" />
                : <Video className="w-5 h-5" aria-hidden="true" />}
            </div>
            {previewState === 'requesting' && (
              <span className="absolute inset-0 rounded-full ring-2 ring-violet-500/30 animate-ping" aria-hidden="true" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
