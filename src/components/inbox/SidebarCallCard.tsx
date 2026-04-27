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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Phone, Video, Loader2, X, CheckCircle2, Clock, Ban, PhoneOff, RotateCw,
  Mic, MicOff, VideoOff, WifiOff,
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
import type { RemoteAudioTrack, RemoteVideoTrack } from 'livekit-client';
import { callsApi } from '@/lib/calls-api';
import { InviteWaitDialog } from './InviteWaitDialog';
import { rtDebug } from '@/realtime/debug';
import { useLocalMediaPreview, type LocalPreviewState } from '@/hooks/useLocalMediaPreview';

interface SidebarCallCardProps {
  workspaceId: string;
  conversationId: string;
  contactName?: string | null;
  onActiveCallChange?: (conversationId: string | null) => void;
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

export function SidebarCallCard({ workspaceId, conversationId, contactName, onActiveCallChange }: SidebarCallCardProps) {
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
  const activeCallConversationIdRef = useRef<string | null>(null);
  const activeCallSessionIdRef = useRef<string | null>(null);
  const previousConversationIdRef = useRef<string>(conversationId);

  const surfaceChannel: InvitationChannel = surface.invitation?.channel ?? 'audio';
  const live = useLiveKitCall({
    publishMic: true,
    publishCamera: surfaceChannel === 'video',
  });

  // Phase 9 — local-device preview during the waiting phase. Decoupled
  // from LiveKit; releases the camera/mic the instant we move out of
  // 'waiting' so the LiveKit client can re-acquire them on connect.
  const preview = useLocalMediaPreview({
    enabled: surface.phase === 'waiting',
    wantVideo: surfaceChannel === 'video',
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

  const disconnectLive = useCallback((reason: Parameters<typeof live.disconnect>[0], currentConversationId = conversationId) => {
    return live.disconnect(reason, {
      activeCallSessionId: activeCallSessionIdRef.current,
      activeCallConversationId: activeCallConversationIdRef.current,
      currentConversationId,
    });
  }, [conversationId, live]);

  const clearActiveCallRefs = useCallback(() => {
    activeCallConversationIdRef.current = null;
    activeCallSessionIdRef.current = null;
    connectedInvitationIdRef.current = null;
    startedConnectInvitationIdRef.current = null;
    onActiveCallChange?.(null);
  }, [onActiveCallChange]);

  // Reset conversation-scoped UI only when the selected conversation id truly
  // changes. Realtime object refreshes and same-id re-renders must never tear
  // down the LiveKit Room.
  useEffect(() => {
    const previousConversationId = previousConversationIdRef.current;
    if (previousConversationId === conversationId) return;
    const activeConversationId = activeCallConversationIdRef.current;
    const activeSessionId = activeCallSessionIdRef.current;
    previousConversationIdRef.current = conversationId;

    if (activeSessionId && activeConversationId && conversationId !== activeConversationId) {
      console.warn('[livekit] conversation switch while active call is being left intentionally', {
        activeCallSessionId: activeSessionId,
        activeCallConversationId: activeConversationId,
        currentConversationId: conversationId,
      });
      rtDebug('call', 'conversation switch active-call disconnect', {
        activeCallSessionId: activeSessionId,
        activeCallConversationId: activeConversationId,
        currentConversationId: conversationId,
      });
      try { void disconnectLive('conversation_switch_active_call', conversationId); } catch { /* ignore */ }
      clearActiveCallRefs();
    }

    setLatest(null);
    setCreating(null);
    setLoading(false);
    if (autoCloseRef.current) { clearTimeout(autoCloseRef.current); autoCloseRef.current = null; }
    if (!activeSessionId) clearActiveCallRefs();
    setSurface(INITIAL_SURFACE);
  }, [conversationId, clearActiveCallRefs, disconnectLive]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (autoCloseRef.current) clearTimeout(autoCloseRef.current);
      if (activeCallSessionIdRef.current) {
        console.warn('[livekit] SidebarCallCard unmounted with active call; LiveKit room is not disconnected here', {
          activeCallSessionId: activeCallSessionIdRef.current,
          activeCallConversationId: activeCallConversationIdRef.current,
          currentConversationId: conversationId,
        });
        rtDebug('call', 'active unmount preserved');
        return;
      }
      rtDebug('call', 'unmount no-active-call disconnect');
      try { live.disconnect('component_unmount_no_active_call', {
        activeCallSessionId: activeCallSessionIdRef.current,
        activeCallConversationId: activeCallConversationIdRef.current,
        currentConversationId: conversationId,
      }); } catch { /* ignore */ }
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
      rtDebug('call', 'auto-close terminal disconnect');
      try { void disconnectLive('server_call_ended'); } catch { /* ignore */ }
      clearActiveCallRefs();
      setSurface(INITIAL_SURFACE);
    }, delayMs);
  }, [clearActiveCallRefs, disconnectLive]);

  useEffect(() => {
    if (surface.phase !== 'terminal') return;
    const delay = surface.terminalStatus === 'cancelled' ? 1800 : 3500;
    scheduleAutoClose(delay);
  }, [surface.phase, surface.terminalStatus, scheduleAutoClose]);

  // ── On 'connecting' phase → resolve call_session_id then connect media
  useEffect(() => {
    if (surface.phase !== 'connecting') return;
    const inv = surface.invitation;
    if (!inv) return;
    // Guard against re-runs for the same invitation. Without this, a
    // re-delivered realtime 'joined' event (or a re-render that briefly
    // re-enters 'connecting') would call live.connect a second time on
    // the same invitation — orphaning the active Room. The hook itself
    // also has an idempotency guard, but checking here keeps the logs
    // clean and avoids unnecessary token re-fetches.
    if (startedConnectInvitationIdRef.current === inv.id) {
      return;
    }
    startedConnectInvitationIdRef.current = inv.id;
    let cancelled = false;
    (async () => {
      try {
        const fresh = surface.invitation
          ? await callInvitationsApi.get(surface.invitation.id).then((r) => r.invitation).catch(() => surface.invitation)
          : null;
        if (cancelled) return;
        const callSessionId = fresh?.call_session_id;
        if (!callSessionId) throw new Error('missing_call_session');
        activeCallConversationIdRef.current = inv.conversation_id;
        activeCallSessionIdRef.current = callSessionId;
        onActiveCallChange?.(inv.conversation_id);
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
        // Latch this invitation as "connected" so subsequent stale
        // realtime/poll updates for it cannot tear down the active room.
        connectedInvitationIdRef.current = inv.id;
        rtDebug('call', 'connected', { invitation_id: inv.id, channel: inv.channel });
        setSurface((prev) => prev.phase === 'connecting' ? { ...prev, phase: 'connected' } : prev);
      } catch (err: any) {
        if (cancelled) return;
        // Allow a fresh attempt only if this invitation actually failed
        // to connect. Terminal cleanup will clear the ref next.
        startedConnectInvitationIdRef.current = null;
        rtDebug('call', 'connect failed', { invitation_id: inv.id, error: err?.message });
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
  }, [surface.phase, surface.invitation?.id]);

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
      // Optimistically transition the surface to terminal so the operator
      // sees immediate feedback even when the realtime echo is delayed
      // (e.g. Centrifugo permission/connection errors). The realtime echo
      // will harmlessly re-confirm 'cancelled'.
      setSurface((prev) => {
        if (!prev.invitation || prev.invitation.id !== target.id) return prev;
        // Don't yank a live, connected room into terminal.
        if (prev.phase === 'connected') return prev;
        return {
          ...prev,
          phase: 'terminal',
          invitation: { ...prev.invitation, status: 'cancelled' },
          terminalStatus: 'cancelled',
        };
      });
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
    rtDebug('call', 'operator hangup disconnect');
    try { await disconnectLive('explicit_hangup'); } catch { /* ignore */ }
    clearActiveCallRefs();
    setSurface(INITIAL_SURFACE);
  }, [clearActiveCallRefs, disconnectLive]);

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

interface WaitingTileProps {
  previewStream: MediaStream | null;
  previewState: LocalPreviewState;
}

function AudioWaitingTile({ previewStream, previewState }: WaitingTileProps) {
  // Local mic-level meter (best-effort). Falls back to animated bars if
  // AudioContext / analyser is unavailable. Released in cleanup so we
  // don't leak audio nodes after the visitor joins.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!previewStream) {
      setLevel(0);
      return;
    }
    const AudioCtx: typeof AudioContext | undefined =
      (window as any).AudioContext || (window as any).webkitAudioContext;
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
    } catch {
      /* analyser unavailable — bars will animate via CSS */
    }
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
        <span
          className="absolute inset-0 rounded-full ring-2 ring-warning/30 animate-ping"
          aria-hidden="true"
        />
      </div>
      <div className="flex-1 flex items-end gap-1 h-6" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => {
          // Distance from center → louder bars in the middle when speaking.
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
    } else {
      el.srcObject = null;
    }
  }, [previewStream]);
  const showVideo = previewState === 'ready' && !!previewStream;
  return (
    <div className="relative aspect-video w-full rounded-lg overflow-hidden border border-violet-500/20 bg-gradient-to-br from-violet-500/10 via-violet-500/5 to-transparent">
      {/* Local self-view — rendered as soon as getUserMedia resolves.
          NOT mirrored: per current product rules no video element
          (local or remote) is ever flipped. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={cn(
          'absolute inset-0 w-full h-full object-cover bg-black transition-opacity duration-200',
          showVideo ? 'opacity-100' : 'opacity-0',
        )}
        style={{ transform: 'none' }}
      />
      {!showVideo && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <div className="relative">
            <div className="w-12 h-12 rounded-full bg-violet-500/10 flex items-center justify-center text-violet-600 dark:text-violet-400">
              {previewState === 'denied'
                ? <VideoOff className="w-5 h-5" aria-hidden="true" />
                : <Video className="w-5 h-5" aria-hidden="true" />}
            </div>
            {previewState === 'requesting' && (
              <span
                className="absolute inset-0 rounded-full ring-2 ring-violet-500/30 animate-ping"
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AudioCallStage({ remote }: { remote: ReturnType<typeof useLiveKitCall>['remote'] }) {
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  // Bind audio via LiveKit's RemoteAudioTrack.attach/detach so the SDK
  // owns srcObject lifecycle. Manual MediaStream wrapping was the source
  // of frozen-frame bugs on the video path; keep audio symmetric.
  const boundAudioRef = useRef<Record<string, string>>({});
  useLayoutEffect(() => {
    for (const r of remote) {
      const el = audioRefs.current[r.participantSid];
      if (!el) continue;
      const prevSid = boundAudioRef.current[r.participantSid] || '';
      if (r.audioTrack) {
        const sid = (r.audioTrack as any).sid || r.audio?.id || '';
        if (prevSid !== sid) {
          try { r.audioTrack.attach(el); } catch { /* ignore */ }
          boundAudioRef.current[r.participantSid] = sid;
          // eslint-disable-next-line no-console
          console.debug('[livekit] RemoteAudioTrack.attach', r.participantSid, sid);
        }
        const p = el.play();
        if (p && typeof (p as Promise<void>).catch === 'function') {
          (p as Promise<void>).catch(() => { /* autoplay — UI recovers on gesture */ });
        }
      } else if (prevSid) {
        try { el.srcObject = null; } catch { /* ignore */ }
        boundAudioRef.current[r.participantSid] = '';
      }
    }
  }, [remote]);
  // Cleanup on unmount: detach known audio tracks so we never leak SDK refs.
  useEffect(() => {
    const refs = audioRefs.current;
    return () => {
      for (const sid of Object.keys(refs)) {
        const el = refs[sid];
        if (el) {
          try { el.srcObject = null; } catch { /* ignore */ }
        }
      }
    };
  }, []);
  const hasAudio = remote.some((r) => !!r.audioTrack);
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
  // Track currently-attached LiveKit RemoteVideoTrack per participant so
  // we know exactly when to detach (track replaced, gone, or stalled).
  const attachedTrackRef = useRef<Record<string, RemoteVideoTrack | null>>({});
  // Audio mirrors the dedicated <audio> element; LiveKit owns the binding
  // via attach/detach, kept fully separate from video so a video-only
  // mute/stall cannot tear down audio.
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const attachedAudioRef = useRef<Record<string, RemoteAudioTrack | null>>({});

  // ── Video attach / detach ───────────────────────────────────────────
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
        // eslint-disable-next-line no-console
        console.debug('[livekit] RemoteVideoTrack.detach', r.participantSid);
      }
      if (next) {
        try { next.attach(el); } catch { /* ignore */ }
        // eslint-disable-next-line no-console
        console.debug('[livekit] RemoteVideoTrack.attach', r.participantSid, (next as any).sid);
        const p = el.play();
        if (p && typeof (p as Promise<void>).catch === 'function') {
          (p as Promise<void>).catch(() => { /* autoplay — recovers on user gesture */ });
        }
      }
      attachedTrackRef.current[r.participantSid] = next;
    }
    // Clean up entries for participants that vanished from the snapshot.
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

  // ── Diagnostic media events on the <video> element ─────────────────
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    for (const r of remote) {
      const el = videoRefs.current[r.participantSid];
      if (!el) continue;
      const log = (kind: string) => () => {
        // eslint-disable-next-line no-console
        console.debug('[livekit] remote video element', kind, r.participantSid, {
          trackSid: (r.videoTrack as any)?.sid,
          currentTime: el.currentTime,
          readyState: el.readyState,
          videoWidth: el.videoWidth,
          videoHeight: el.videoHeight,
        });
      };
      const events: Array<keyof HTMLMediaElementEventMap> = [
        'playing', 'pause', 'stalled', 'waiting', 'emptied', 'error', 'suspend', 'ended',
      ];
      const handlers = events.map((ev) => {
        const h = log(ev);
        el.addEventListener(ev, h);
        return [ev, h] as const;
      });
      // timeupdate is noisy; throttle its logging.
      let lastLog = 0;
      const tu = () => {
        const now = Date.now();
        if (now - lastLog < 5000) return;
        lastLog = now;
        // eslint-disable-next-line no-console
        console.debug('[livekit] remote video timeupdate', r.participantSid, {
          currentTime: el.currentTime,
          videoWidth: el.videoWidth,
        });
      };
      el.addEventListener('timeupdate', tu);
      cleanups.push(() => {
        for (const [ev, h] of handlers) el.removeEventListener(ev, h);
        el.removeEventListener('timeupdate', tu);
      });
    }
    return () => { for (const c of cleanups) c(); };
  }, [remote]);

  // ── Real freeze watchdog ────────────────────────────────────────────
  // Polls each remote <video>'s currentTime. If the LiveKit track is
  // still 'live' but currentTime hasn't advanced for ≥3s, we detach +
  // re-attach via the SDK. We never disconnect the room from here.
  useEffect(() => {
    if (remote.length === 0) return;
    const lastTimes: Record<string, { t: number; at: number }> = {};
    const id = setInterval(() => {
      for (const r of remote) {
        const el = videoRefs.current[r.participantSid];
        const tr = r.videoTrack;
        if (!el || !tr) continue;
        // If the track is gone or dead, skip — the attach/detach effect
        // will handle the cleanup the next time `remote` updates.
        const ms = (tr as any).mediaStreamTrack as MediaStreamTrack | undefined;
        if (!ms || ms.readyState !== 'live') continue;
        const now = Date.now();
        const prev = lastTimes[r.participantSid];
        const ct = el.currentTime;
        if (!prev) {
          lastTimes[r.participantSid] = { t: ct, at: now };
          continue;
        }
        if (ct > prev.t + 0.05) {
          // moving — reset baseline
          lastTimes[r.participantSid] = { t: ct, at: now };
          continue;
        }
        // Frozen for 3s+ → reattach via SDK (no room disconnect).
        if (now - prev.at >= 3000) {
          // eslint-disable-next-line no-console
          console.warn('[livekit] remote video watchdog reattach', r.participantSid, {
            currentTime: ct,
            stalledForMs: now - prev.at,
          });
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

  // ── Audio attach / detach ───────────────────────────────────────────
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
          (p as Promise<void>).catch(() => { /* autoplay — recovers on gesture */ });
        }
      }
      attachedAudioRef.current[r.participantSid] = next;
    }
  }, [remote]);

  // Detach everything on unmount so no SDK refs leak.
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
      <div className="aspect-video w-full rounded-lg border border-border bg-muted flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      {remote.map((r) => (
        <div key={r.participantSid} className="relative aspect-video w-full rounded-lg overflow-hidden border border-border bg-black">
          <video
            ref={(el) => { videoRefs.current[r.participantSid] = el; }}
            autoPlay
            playsInline
            muted={false}
            className="w-full h-full object-cover bg-black"
            style={{ transform: 'none' }}
          />
          {!r.videoTrack && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/70 text-white/80">
              <WifiOff className="w-5 h-5" aria-hidden="true" />
              <span className="text-[11px] font-medium">Video paused / reconnecting…</span>
            </div>
          )}
          {/* Dedicated audio element — survives video mute/unmute cycles. */}
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
