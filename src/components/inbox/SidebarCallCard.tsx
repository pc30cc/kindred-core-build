/**
 * SidebarCallCard — invitation-first call entry point + active call surface
 * for the inbox sidebar.
 *
 * This single component owns the operator's full call lifecycle so that the
 * UI never opens a floating dock. It lives in the right column above the
 * Info / Activity tabs and morphs in-place between two modes:
 *
 *   IDLE       → "Call visitor" card with [Audio] [Video] CTAs.
 *   WAITING    → channel-specific waiting tile (audio bars OR violet video
 *                placeholder), countdown, Cancel.
 *   CONNECTING → spinner while the LiveKit token is fetched and the room
 *                is joined.
 *   CONNECTED  → live AudioCallStage or VideoCallStage with mic/camera
 *                toggles and a destructive Hangup button.
 *   TERMINAL   → brief status (declined / expired / cancelled / failed)
 *                that auto-reverts to IDLE so the operator can invite again.
 *
 * Strict rules carried over from the previous OperatorCallSurface:
 *   - Token + URLs come from /api/calls/:id/token (callsApi.token). Never
 *     minted client-side.
 *   - Audio invitations NEVER publish camera and NEVER show video stages.
 *   - Disconnect is fired on every terminal/close path so the operator is
 *     never stuck "Busy" client-side.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone, Video, Loader2, X, CheckCircle2, Clock, Ban, PhoneOff, RotateCw,
  Mic, MicOff, VideoOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import {
  callInvitationsApi,
  type CallInvitation,
  type InvitationChannel,
  type InvitationStatus,
} from '@/lib/call-invitations-api';
import { onInvitationChanged } from '@/lib/call-invitations-events';
import { useLiveKitCall } from '@/hooks/useLiveKitCall';
import { callsApi } from '@/lib/calls-api';
import { InviteWaitDialog } from './InviteWaitDialog';
import { rtDebug } from '@/realtime/debug';

interface SidebarCallCardProps {
  workspaceId: string;
  conversationId: string;
  contactName?: string | null;
}

// ─── Surface phases (mirror previous OperatorCallSurface) ────────────────
type SurfacePhase = 'idle' | 'waiting' | 'connecting' | 'connected' | 'terminal';

interface SurfaceState {
  phase: SurfacePhase;
  invitation: CallInvitation | null;
  terminalStatus: 'expired' | 'cancelled' | 'declined' | 'failed' | null;
  errorMessage: string | null;
}

const INITIAL_SURFACE: SurfaceState = {
  phase: 'idle',
  invitation: null,
  terminalStatus: null,
  errorMessage: null,
};

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

export function SidebarCallCard({ workspaceId, conversationId, contactName }: SidebarCallCardProps) {
  const i18n = useTranslation();
  // Loose-typed translator so newer keys (callSurface.*, callInvite.*) that
  // are not yet in the static KnownKeys union still resolve at runtime.
  const t = (key: string, vars?: Record<string, string>): string =>
    (i18n.t as unknown as (k: string, v?: Record<string, string>) => string)(key, vars) || '';

  // ── Last invitation (drives terminal pill + resend shortcut) ──────────
  const [latest, setLatest] = useState<CallInvitation | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<InvitationChannel | null>(null);
  const [, forceTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [dialogChannel, setDialogChannel] = useState<InvitationChannel | null>(null);

  // ── Active surface state (waiting → connecting → connected → terminal)
  const [surface, setSurface] = useState<SurfaceState>(INITIAL_SURFACE);
  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancellingRef = useRef(false);
  // Tracks the invitation id we have *already* connected for. Once a
  // connect succeeds for an invitation, ignore further realtime/poll
  // updates for it — those are stale echoes and would orphan the live
  // LiveKit Room, which the server then logs as CLIENT_REQUEST_LEAVE.
  const connectedInvitationIdRef = useRef<string | null>(null);
  // Tracks the invitation id we have started a connect attempt for, so
  // the connecting effect cannot re-fire and double-mount the LiveKit
  // Room when the surface state transiently re-enters 'connecting'.
  const startedConnectInvitationIdRef = useRef<string | null>(null);

  const surfaceChannel: InvitationChannel = surface.invitation?.channel ?? 'audio';
  const live = useLiveKitCall({
    publishMic: true,
    publishCamera: surfaceChannel === 'video',
  });

  // Localized "Xm Ys" helper used both in pending pill and surface countdown.
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

  // Reset everything when switching conversations.
  useEffect(() => {
    setLatest(null);
    setCreating(null);
    setLoading(false);
    if (autoCloseRef.current) { clearTimeout(autoCloseRef.current); autoCloseRef.current = null; }
    rtDebug('call', 'conversation-switch disconnect', { conversationId });
    try { void live.disconnect(); } catch { /* ignore */ }
    connectedInvitationIdRef.current = null;
    startedConnectInvitationIdRef.current = null;
    setSurface(INITIAL_SURFACE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (autoCloseRef.current) clearTimeout(autoCloseRef.current);
      rtDebug('call', 'unmount disconnect');
      try { live.disconnect(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Refresh latest invitation summary (drives the terminal pill) ──────
  const refresh = useCallback(async () => {
    try {
      const { invitations } = await callInvitationsApi.listForConversation(conversationId);
      setLatest(invitations[0] ?? null);
    } catch {
      /* polling will retry */
    }
  }, [conversationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Polling fallback (4s while pending, 20s otherwise).
  useEffect(() => {
    const interval = latest?.status === 'pending' ? 4000 : 20000;
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => { void refresh(); }, interval);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [latest?.status, refresh]);

  // ── Realtime → both latest pill AND active surface phase ──────────────
  useEffect(() => {
    return onInvitationChanged((evt) => {
      if (evt.conversation_id !== conversationId) return;

      // Update the latest pill summary.
      setLatest((prev) => {
        if (prev && prev.id === evt.invitation_id) {
          return { ...prev, status: evt.status };
        }
        return prev;
      });
      void refresh();

      // Drive the active surface lifecycle.
      setSurface((prev) => {
        if (!prev.invitation) return prev;
        if (prev.invitation.id !== evt.invitation_id) return prev;
        // Critical: once we have a live, connected room for this
        // invitation, ignore *all* further server-side status echoes.
        // - Re-delivered "joined" events would re-trigger the connect
        //   effect and orphan the existing Room (CLIENT_REQUEST_LEAVE).
        // - Late "expired"/"cancelled" can race the join transition and
        //   would yank us into terminal mid-call.
        // The only legitimate way out of 'connected' is operator hangup
        // or true unmount, both of which are local actions.
        if (
          connectedInvitationIdRef.current === evt.invitation_id &&
          (prev.phase === 'connected' || prev.phase === 'connecting')
        ) {
          rtDebug('call', 'ignoring stale invitation event', {
            invitation_id: evt.invitation_id,
            status: evt.status,
            phase: prev.phase,
          });
          return prev;
        }
        const status = evt.status;
        if (status === 'pending') {
          return { ...prev, invitation: { ...prev.invitation, status: 'pending' } };
        }
        if (status === 'joined') {
          // Only transition to 'connecting' from 'waiting'. If we are
          // already 'connecting' or 'connected', this is a re-delivered
          // event and must be ignored to avoid spinning a second Room.
          if (prev.phase !== 'waiting') {
            return prev;
          }
          return {
            ...prev,
            phase: 'connecting',
            invitation: { ...prev.invitation, status: 'joined' },
          };
        }
        // expired | cancelled | declined → terminal
        return {
          ...prev,
          phase: 'terminal',
          invitation: { ...prev.invitation, status },
          terminalStatus: status as 'expired' | 'cancelled' | 'declined',
        };
      });
    });
  }, [conversationId, refresh]);

  // Countdown ticker — runs whenever there's a pending invitation OR the
  // surface is in waiting state.
  useEffect(() => {
    const needsTicker =
      latest?.status === 'pending' ||
      surface.phase === 'waiting';
    if (!needsTicker) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [latest?.status, surface.phase]);

  // Schedule auto-close of the terminal surface so it briefly shows the
  // outcome and then reverts to IDLE, exposing the invite buttons again.
  const scheduleAutoClose = useCallback((delayMs: number) => {
    if (autoCloseRef.current) clearTimeout(autoCloseRef.current);
    autoCloseRef.current = setTimeout(() => {
      try { void live.disconnect(); } catch { /* ignore */ }
      setSurface(INITIAL_SURFACE);
    }, delayMs);
  }, [live]);

  useEffect(() => {
    if (surface.phase !== 'terminal') return;
    const delay = surface.terminalStatus === 'cancelled' ? 1800 : 3500;
    scheduleAutoClose(delay);
  }, [surface.phase, surface.terminalStatus, scheduleAutoClose]);

  // ── On 'connecting' phase → resolve call_session_id then connect media
  useEffect(() => {
    if (surface.phase !== 'connecting') return;
    let cancelled = false;
    (async () => {
      try {
        const fresh = surface.invitation
          ? await callInvitationsApi.get(surface.invitation.id).then((r) => r.invitation).catch(() => surface.invitation)
          : null;
        if (cancelled) return;
        const callSessionId = fresh?.call_session_id;
        if (!callSessionId) throw new Error('missing_call_session');
        const tok = await callsApi.token(callSessionId);
        if (cancelled) return;
        if (!tok.ws_url) throw new Error('missing_ws_url');
        await live.connect({
          wsUrl: tok.ws_url,
          token: tok.token,
          iceServers: tok.turn?.urls?.length
            ? [{
                urls: tok.turn.urls,
                username: tok.turn.username || undefined,
                credential: tok.turn.credential || undefined,
              }]
            : undefined,
          iceTransportPolicy: tok.ice_policy,
        });
        if (cancelled) return;
        setSurface((prev) => prev.phase === 'connecting' ? { ...prev, phase: 'connected' } : prev);
      } catch (err: any) {
        if (cancelled) return;
        setSurface((prev) => ({
          ...prev,
          phase: 'terminal',
          terminalStatus: 'failed',
          errorMessage: err?.message || String(err),
        }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.phase]);

  // ── Invite creation ───────────────────────────────────────────────────
  const openInviteDialog = useCallback((channel: InvitationChannel) => {
    if (creating || latest?.status === 'pending' || surface.phase !== 'idle') return;
    setDialogChannel(channel);
  }, [creating, latest?.status, surface.phase]);

  const sendInvite = useCallback(async (channel: InvitationChannel, ttlSeconds: number) => {
    if (creating || latest?.status === 'pending' || surface.phase !== 'idle') return;
    setCreating(channel);
    setLoading(true);
    try {
      const { invitation } = await callInvitationsApi.create({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        channel,
        ttl_seconds: ttlSeconds,
      });
      setLatest(invitation);
      setDialogChannel(null);
      // Move the surface into WAITING immediately — no floating dock anymore.
      setSurface({
        phase: 'waiting',
        invitation,
        terminalStatus: null,
        errorMessage: null,
      });
      toast({
        title: channel === 'video'
          ? (t('inbox.callInvite.videoSent') || 'Video invite sent')
          : (t('inbox.callInvite.audioSent') || 'Audio invite sent'),
        description: t('inbox.callInvite.sentDesc') || 'Visitor can join from the conversation card.',
      });
    } catch (e: any) {
      toast({
        title: t('inbox.callInvite.sendFailed') || 'Could not send invite',
        description: e?.message || String(e),
        variant: 'destructive',
      });
    } finally {
      setCreating(null);
      setLoading(false);
    }
  }, [workspaceId, conversationId, creating, latest?.status, surface.phase, t]);

  const handleConfirmWait = useCallback((seconds: number) => {
    if (!dialogChannel) return;
    void sendInvite(dialogChannel, seconds);
  }, [dialogChannel, sendInvite]);

  const closeDialog = useCallback(() => {
    if (creating) return;
    setDialogChannel(null);
  }, [creating]);

  // ── Cancel pending invitation (from either pill or surface) ───────────
  const cancelInvite = useCallback(async () => {
    const target = surface.invitation ?? (latest && latest.status === 'pending' ? latest : null);
    if (!target || cancellingRef.current) return;
    cancellingRef.current = true;
    setLoading(true);
    try {
      const { invitation } = await callInvitationsApi.cancel(target.id);
      setLatest(invitation);
      // Realtime echo will flip the surface to terminal; if not the active
      // invitation, just sync the pill.
    } catch (err: any) {
      toast({
        title: t('inbox.callInvite.cancelFailed') || 'Could not cancel invitation',
        description: err?.message || String(err),
        variant: 'destructive',
      });
    } finally {
      cancellingRef.current = false;
      setLoading(false);
    }
  }, [surface.invitation, latest, t]);

  // ── Hangup an active call (or close terminal early) ───────────────────
  const onHangup = useCallback(async () => {
    if (autoCloseRef.current) { clearTimeout(autoCloseRef.current); autoCloseRef.current = null; }
    try { await live.disconnect(); } catch { /* ignore */ }
    setSurface(INITIAL_SURFACE);
  }, [live]);

  // ── Derived state ─────────────────────────────────────────────────────
  const visual = useMemo(() => latest ? STATUS_VISUAL[latest.status] : null, [latest]);
  const isPending = latest?.status === 'pending';
  const isTerminal = !!latest && !isPending;
  const lastChannel: InvitationChannel = latest?.channel === 'video' ? 'video' : 'audio';
  const disableInvites = loading || creating !== null || isPending || surface.phase !== 'idle';

  // Whether we render the SURFACE vs the IDLE invite UI.
  const showSurface = surface.phase !== 'idle' && surface.invitation !== null;
  const isVideo = surfaceChannel === 'video';
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

  const remainingLabel = surface.invitation && surface.phase === 'waiting'
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

  // ─────────────────────────────────────────────────────────────────────
  // Active surface mode — replaces the idle "Call visitor" card.
  // ─────────────────────────────────────────────────────────────────────
  if (showSurface) {
    return (
      <>
        <Card
          className={cn(
            'border-border/70 shadow-sm overflow-hidden ring-1 ring-inset',
            accentRing,
          )}
          role="region"
          aria-label={surfaceTitle}
        >
          <CardHeader className={cn('pb-2 border-b border-border', accentBg)}>
            <CardTitle className="text-xs font-semibold flex items-center gap-1.5 text-foreground">
              <span className={cn('inline-flex items-center justify-center w-5 h-5 rounded-md bg-background', accentText)}>
                <ChannelIcon className="w-3 h-3" aria-hidden="true" />
              </span>
              <span className="truncate">{surfaceTitle}</span>
            </CardTitle>
            {contactName && (
              <p className="text-[10px] text-muted-foreground truncate ms-6.5">{contactName}</p>
            )}
          </CardHeader>

          <CardContent className="pt-2.5 space-y-2.5">
            {surface.phase === 'waiting' && (
              <>
                {isVideo ? <VideoWaitingTile /> : <AudioWaitingTile />}
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
                  aria-label={t('inbox.callSurface.cancel') || 'Cancel invitation'}
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
                    aria-label={live.micEnabled
                      ? (t('inbox.callSurface.muteMic') || 'Mute microphone')
                      : (t('inbox.callSurface.unmuteMic') || 'Unmute microphone')}
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
                      aria-label={live.cameraEnabled
                        ? (t('inbox.callSurface.cameraOff') || 'Turn camera off')
                        : (t('inbox.callSurface.cameraOn') || 'Turn camera on')}
                    >
                      {live.cameraEnabled ? <Video className="w-3.5 h-3.5" /> : <VideoOff className="w-3.5 h-3.5" />}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="default"
                    className="h-8 px-3 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 gap-1.5"
                    onClick={() => void onHangup()}
                    aria-label={t('inbox.callSurface.hangup') || 'End call'}
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
                  onClick={() => void onHangup()}
                >
                  {t('common.close') || 'Close'}
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

  // ─────────────────────────────────────────────────────────────────────
  // Idle mode — invite buttons + last-invite pill (existing behavior).
  // ─────────────────────────────────────────────────────────────────────
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
          {/* Pending invitation pill (only relevant if surface is somehow
              not yet showing — kept for safety). */}
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

          {/* Terminal status pill + resend shortcut */}
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
                aria-label={
                  lastChannel === 'video'
                    ? (t('inbox.callInvite.resendVideo') || 'Resend video invite')
                    : (t('inbox.callInvite.resendAudio') || 'Resend audio invite')
                }
              >
                {creating === lastChannel
                  ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                  : <RotateCw className="w-3 h-3" aria-hidden="true" />}
                {t('inbox.callInvite.resend') || 'Resend'}
              </Button>
            </div>
          )}

          {/* Primary CTAs */}
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2 text-[11px] font-semibold gap-1.5 hover:bg-warning/5 hover:border-warning/40 hover:text-warning transition-colors"
              onClick={() => openInviteDialog('audio')}
              disabled={disableInvites}
              aria-label={t('inbox.callInvite.audioAria') || 'Invite visitor to an audio call'}
              title={t('inbox.callInvite.inviteAudio') || 'Invite to audio'}
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
              disabled={disableInvites}
              aria-label={t('inbox.callInvite.videoAria') || 'Invite visitor to a video call'}
              title={t('inbox.callInvite.inviteVideo') || 'Invite to video'}
            >
              {creating === 'video'
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                : <Video className="w-3.5 h-3.5" aria-hidden="true" />}
              <span className="truncate">{t('inbox.callInvite.video') || 'Video'}</span>
            </Button>
          </div>

          {!isPending && !isTerminal && (
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

// ─── Channel-specific tiles (carried over from OperatorCallSurface) ──────

function AudioWaitingTile() {
  return (
    <div className="rounded-lg bg-warning/5 border border-warning/20 px-3 py-3 flex items-center gap-3">
      <div className="relative">
        <div className="w-9 h-9 rounded-full bg-warning/10 flex items-center justify-center text-warning">
          <Phone className="w-4 h-4" aria-hidden="true" />
        </div>
        <span
          className="absolute inset-0 rounded-full ring-2 ring-warning/30 animate-ping"
          aria-hidden="true"
        />
      </div>
      <div className="flex-1 flex items-center gap-1" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <span
            key={i}
            className="block w-1 rounded-sm bg-warning/40 animate-pulse"
            style={{ height: `${10 + ((i * 7) % 14)}px`, animationDelay: `${i * 90}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

function VideoWaitingTile() {
  return (
    <div className="aspect-video w-full rounded-lg border border-violet-500/20 bg-gradient-to-br from-violet-500/10 via-violet-500/5 to-transparent flex flex-col items-center justify-center gap-2">
      <div className="relative">
        <div className="w-12 h-12 rounded-full bg-violet-500/10 flex items-center justify-center text-violet-600 dark:text-violet-400">
          <Video className="w-5 h-5" aria-hidden="true" />
        </div>
        <span
          className="absolute inset-0 rounded-full ring-2 ring-violet-500/30 animate-ping"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

function AudioCallStage({ remote }: { remote: ReturnType<typeof useLiveKitCall>['remote'] }) {
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  useEffect(() => {
    for (const r of remote) {
      const el = audioRefs.current[r.participantSid];
      if (!el) continue;
      if (r.audio) {
        const stream = new MediaStream([r.audio]);
        if (el.srcObject !== stream) el.srcObject = stream;
      }
    }
  }, [remote]);
  const hasAudio = remote.some((r) => !!r.audio);
  return (
    <div className="rounded-lg bg-success/5 border border-success/20 px-3 py-3 flex items-center gap-3">
      <div className="w-9 h-9 rounded-full bg-success/10 flex items-center justify-center text-success">
        <Phone className="w-4 h-4" aria-hidden="true" />
      </div>
      <div className="flex-1 text-[11px] text-muted-foreground">
        {hasAudio ? '🔊' : '…'}
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

function VideoCallStage({ remote }: { remote: ReturnType<typeof useLiveKitCall>['remote'] }) {
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  useEffect(() => {
    for (const r of remote) {
      const el = videoRefs.current[r.participantSid];
      if (!el) continue;
      const tracks: MediaStreamTrack[] = [];
      if (r.video) tracks.push(r.video);
      if (r.audio) tracks.push(r.audio);
      if (tracks.length === 0) {
        el.srcObject = null;
        return;
      }
      const stream = new MediaStream(tracks);
      if (el.srcObject !== stream) el.srcObject = stream;
    }
  }, [remote]);
  if (remote.length === 0) {
    return (
      <div className="aspect-video w-full rounded-lg border border-border bg-muted flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      {remote.map((r) => (
        <div key={r.participantSid} className="aspect-video w-full rounded-lg overflow-hidden border border-border bg-black">
          <video
            ref={(el) => { videoRefs.current[r.participantSid] = el; }}
            autoPlay
            playsInline
            muted={false}
            className="w-full h-full object-cover"
          />
        </div>
      ))}
    </div>
  );
}
