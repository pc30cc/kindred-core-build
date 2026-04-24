/**
 * OperatorCallSurface — channel-aware waiting/active call dock for the operator.
 *
 * Lifecycle (driven by call_invitation_changed events forwarded from
 * useInboxRealtime + a direct trigger from OperatorCallPanel right after
 * a successful invite create):
 *
 *   create-success → waiting (audio | video, channel-specific UI)
 *   joined         → connecting → connected (mounts useLiveKitCall)
 *   expired        → terminal (auto-close ~3.5s)
 *   cancelled      → terminal (auto-close ~2s)
 *   declined       → terminal (auto-close ~3.5s)
 *   failed/error   → terminal (auto-close ~5s, surfaces error)
 *   user closes    → cleanup (disconnects media if connected)
 *
 * Strict rules:
 *   - Token + URL come from /api/calls/:id/token (callsApi.token). Never minted here.
 *   - Audio invites NEVER publish camera and NEVER show a video stage.
 *   - Video invites publish camera and show local + remote video tiles.
 *   - Disconnect ALWAYS releases media on every terminal/close path so the
 *     operator never gets stuck "Busy" client-side. Server-side Busy is
 *     released by the LiveKit webhook when the room ends.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone, Video, Mic, MicOff, VideoOff, PhoneOff, X, Loader2,
  CheckCircle2, Ban, Clock, PhoneOff as PhoneOffIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { toast } from '@/hooks/use-toast';
import {
  callInvitationsApi,
  type CallInvitation,
  type InvitationChannel,
} from '@/lib/call-invitations-api';
import { onInvitationChanged } from '@/lib/call-invitations-events';
import { useLiveKitCall } from '@/hooks/useLiveKitCall';
import { callsApi } from '@/lib/calls-api';

interface OperatorCallSurfaceProps {
  workspaceId: string;
  conversationId: string | null;
  contactName?: string | null;
}

type SurfacePhase =
  | 'idle'
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'terminal';

interface SurfaceState {
  phase: SurfacePhase;
  invitation: CallInvitation | null;
  /** Cached terminal status so we can show the right copy after the row mutates. */
  terminalStatus: 'expired' | 'cancelled' | 'declined' | 'failed' | null;
  errorMessage: string | null;
}

const INITIAL: SurfaceState = {
  phase: 'idle',
  invitation: null,
  terminalStatus: null,
  errorMessage: null,
};

export function OperatorCallSurface({
  workspaceId,
  conversationId,
  contactName,
}: OperatorCallSurfaceProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<SurfaceState>(INITIAL);
  const [, forceTick] = useState(0);
  const autoCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancellingRef = useRef(false);

  const channel: InvitationChannel = state.invitation?.channel ?? 'audio';

  // Media — mic always; camera only for video invites.
  const live = useLiveKitCall({
    publishMic: true,
    publishCamera: channel === 'video',
  });

  /** Hard reset: clears state + disconnects any media. */
  const fullReset = useCallback(async () => {
    if (autoCloseRef.current) {
      clearTimeout(autoCloseRef.current);
      autoCloseRef.current = null;
    }
    try { await live.disconnect(); } catch { /* ignore */ }
    setState(INITIAL);
  }, [live]);

  /** Schedule a deferred close so the operator briefly sees the terminal state. */
  const scheduleAutoClose = useCallback((delayMs: number) => {
    if (autoCloseRef.current) clearTimeout(autoCloseRef.current);
    autoCloseRef.current = setTimeout(() => {
      void fullReset();
    }, delayMs);
  }, [fullReset]);

  // ── Trigger from OperatorCallPanel (custom event in same tab) ─────────
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{
        invitation: CallInvitation;
        conversationId: string;
      }>).detail;
      if (!detail) return;
      if (detail.conversationId !== conversationId) return;
      if (autoCloseRef.current) {
        clearTimeout(autoCloseRef.current);
        autoCloseRef.current = null;
      }
      setState({
        phase: 'waiting',
        invitation: detail.invitation,
        terminalStatus: null,
        errorMessage: null,
      });
    };
    window.addEventListener('operator-call:invitation-created', handler as EventListener);
    return () => {
      window.removeEventListener('operator-call:invitation-created', handler as EventListener);
    };
  }, [conversationId]);

  // ── Conversation switch — release everything ─────────────────────────
  useEffect(() => {
    void fullReset();
    // intentionally not depending on fullReset to avoid re-running on hook identity churn
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // ── Realtime invitation lifecycle → surface phase transitions ────────
  useEffect(() => {
    return onInvitationChanged((evt) => {
      if (evt.conversation_id !== conversationId) return;
      setState((prev) => {
        if (!prev.invitation) return prev;
        if (prev.invitation.id !== evt.invitation_id) return prev;
        const status = evt.status;
        if (status === 'pending') {
          return { ...prev, invitation: { ...prev.invitation, status: 'pending' } };
        }
        if (status === 'joined') {
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
  }, [conversationId]);

  // ── When the invitation flips to terminal, schedule auto-close ───────
  useEffect(() => {
    if (state.phase !== 'terminal') return;
    const delay = state.terminalStatus === 'cancelled' ? 1800 : 3500;
    scheduleAutoClose(delay);
  }, [state.phase, state.terminalStatus, scheduleAutoClose]);

  // ── On 'connecting' phase → resolve call_session_id then connect media
  useEffect(() => {
    if (state.phase !== 'connecting') return;
    let cancelled = false;
    (async () => {
      try {
        // The invitation row may not yet have call_session_id locally; refetch.
        const fresh = state.invitation
          ? await callInvitationsApi.get(state.invitation.id).then((r) => r.invitation).catch(() => state.invitation)
          : null;
        if (cancelled) return;
        const callSessionId = fresh?.call_session_id;
        if (!callSessionId) {
          throw new Error('missing_call_session');
        }
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
        setState((prev) => prev.phase === 'connecting' ? { ...prev, phase: 'connected' } : prev);
      } catch (err: any) {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          phase: 'terminal',
          terminalStatus: 'failed',
          errorMessage: err?.message || String(err),
        }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // ── Pending countdown ticker ──────────────────────────────────────────
  useEffect(() => {
    if (state.phase !== 'waiting') return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [state.phase]);

  // ── Cleanup on unmount ────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (autoCloseRef.current) clearTimeout(autoCloseRef.current);
      try { live.disconnect(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Local Cancel ──────────────────────────────────────────────────────
  const onCancel = useCallback(async () => {
    if (!state.invitation || cancellingRef.current) return;
    cancellingRef.current = true;
    try {
      await callInvitationsApi.cancel(state.invitation.id);
      // Realtime echo will flip us to terminal; do nothing here.
    } catch (err: any) {
      toast({
        title: t('callSurface.cancelFailed') || 'Could not cancel',
        description: err?.message || String(err),
        variant: 'destructive',
      });
    } finally {
      cancellingRef.current = false;
    }
  }, [state.invitation, t]);

  // ── Local Hangup ──────────────────────────────────────────────────────
  const onHangup = useCallback(async () => {
    await fullReset();
  }, [fullReset]);

  // ── Local Close while terminal ────────────────────────────────────────
  const onClose = useCallback(async () => {
    await fullReset();
  }, [fullReset]);

  const remainingLabel = useMemo(() => {
    if (!state.invitation || state.phase !== 'waiting') return null;
    const ms = new Date(state.invitation.expires_at).getTime() - Date.now();
    if (ms <= 0) return t('callSurface.expiringNow') || 'Expiring…';
    const total = Math.ceil(ms / 1000);
    if (total < 60) {
      return (t('callInvite.secondsShort', { s: String(total) }) || `${total}s`);
    }
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s === 0
      ? (t('callInvite.minutesShort', { m: String(m) }) || `${m}m`)
      : (t('callInvite.minutesSeconds', { m: String(m), s: String(s) }) || `${m}m ${s}s`);
  }, [state.invitation, state.phase, t]);

  if (state.phase === 'idle' || !state.invitation) return null;

  const isVideo = channel === 'video';
  const ChannelIcon = isVideo ? Video : Phone;
  const accentRing = isVideo ? 'ring-violet-500/30' : 'ring-warning/30';
  const accentBg = isVideo ? 'bg-violet-500/5' : 'bg-warning/5';
  const accentText = isVideo ? 'text-violet-600 dark:text-violet-400' : 'text-warning';

  const headerTitle =
    state.phase === 'waiting'
      ? (isVideo
          ? (t('callSurface.waitingVideoTitle') || 'Waiting for visitor — video')
          : (t('callSurface.waitingAudioTitle') || 'Waiting for visitor — audio'))
      : state.phase === 'connecting'
        ? (t('callSurface.connecting') || 'Connecting…')
        : state.phase === 'connected'
          ? (isVideo
              ? (t('callSurface.connectedVideo') || 'Video call in progress')
              : (t('callSurface.connectedAudio') || 'Audio call in progress'))
          : (t('callSurface.ended') || 'Call ended');

  // Terminal label
  const terminalLabel = (() => {
    switch (state.terminalStatus) {
      case 'expired':   return t('callSurface.terminalExpired')   || 'The visitor did not join in time.';
      case 'declined':  return t('callSurface.terminalDeclined')  || 'The visitor declined the call.';
      case 'cancelled': return t('callSurface.terminalCancelled') || 'Invitation cancelled.';
      case 'failed':    return state.errorMessage
        ? `${t('callSurface.terminalFailed') || 'Could not connect.'} ${state.errorMessage}`
        : (t('callSurface.terminalFailed') || 'Could not connect.');
      default: return null;
    }
  })();

  const TerminalIcon =
    state.terminalStatus === 'declined' ? PhoneOffIcon
    : state.terminalStatus === 'cancelled' ? Ban
    : state.terminalStatus === 'expired' ? Clock
    : state.terminalStatus === 'failed' ? PhoneOffIcon
    : CheckCircle2;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={headerTitle}
      className={cn(
        'fixed z-40 bottom-4 right-4 w-[320px] max-w-[calc(100vw-2rem)]',
        'rounded-xl border border-border bg-card text-card-foreground',
        'shadow-xl ring-1 ring-inset',
        accentRing,
        'animate-in fade-in slide-in-from-bottom-4',
      )}
    >
      {/* Header */}
      <div className={cn('flex items-center gap-2 px-3 py-2 border-b border-border rounded-t-xl', accentBg)}>
        <div className={cn('flex items-center justify-center w-7 h-7 rounded-md bg-background', accentText)}>
          <ChannelIcon className="w-3.5 h-3.5" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-semibold text-foreground truncate">
            {headerTitle}
          </div>
          {contactName && (
            <div className="text-[10px] text-muted-foreground truncate">
              {contactName}
            </div>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          onClick={() => void onClose()}
          aria-label={t('common.close') || 'Close'}
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
      </div>

      {/* Body — phase-specific */}
      {state.phase === 'waiting' && (
        <div className="p-3 space-y-3">
          {isVideo ? (
            <VideoWaitingTile />
          ) : (
            <AudioWaitingTile />
          )}
          <div className="flex items-center justify-between gap-2">
            <Badge className="h-5 px-1.5 text-[10px] font-semibold gap-1 border bg-warning/10 border-warning/30 text-warning">
              <Loader2 className="w-2.5 h-2.5 animate-spin" aria-hidden="true" />
              <span aria-live="polite">{remainingLabel}</span>
            </Badge>
            <span className="text-[10px] text-muted-foreground">
              {contactName
                ? (t('callInvite.waitingFor', { name: contactName }) || `Waiting for ${contactName} to join…`)
                : (t('callInvite.waitingForVisitor') || 'Waiting for visitor to join…')}
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="w-full h-8 text-[11px] font-semibold gap-1.5 hover:bg-destructive/10 hover:border-destructive/30 hover:text-destructive transition-colors"
            onClick={() => void onCancel()}
            aria-label={t('callSurface.cancel') || 'Cancel invitation'}
          >
            <X className="w-3 h-3" aria-hidden="true" />
            {t('callSurface.cancel') || 'Cancel invitation'}
          </Button>
        </div>
      )}

      {state.phase === 'connecting' && (
        <div className="p-4 flex flex-col items-center justify-center gap-2 text-center">
          <Loader2 className={cn('w-6 h-6 animate-spin', accentText)} aria-hidden="true" />
          <div className="text-[11px] text-muted-foreground">
            {t('callSurface.establishing') || 'Establishing media connection…'}
          </div>
        </div>
      )}

      {state.phase === 'connected' && (
        <div className="p-3 space-y-3">
          {isVideo ? (
            <VideoCallStage remote={live.remote} />
          ) : (
            <AudioCallStage remote={live.remote} />
          )}
          <div className="flex items-center justify-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className={cn(
                'h-8 w-8 p-0 rounded-full',
                live.micEnabled ? '' : 'bg-destructive/10 border-destructive/30 text-destructive',
              )}
              onClick={() => void live.toggleMic()}
              aria-label={live.micEnabled
                ? (t('callSurface.muteMic') || 'Mute microphone')
                : (t('callSurface.unmuteMic') || 'Unmute microphone')}
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
                  ? (t('callSurface.cameraOff') || 'Turn camera off')
                  : (t('callSurface.cameraOn') || 'Turn camera on')}
              >
                {live.cameraEnabled ? <Video className="w-3.5 h-3.5" /> : <VideoOff className="w-3.5 h-3.5" />}
              </Button>
            )}
            <Button
              size="sm"
              variant="default"
              className="h-8 px-3 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 gap-1.5"
              onClick={() => void onHangup()}
              aria-label={t('callSurface.hangup') || 'End call'}
            >
              <PhoneOff className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="text-[11px] font-semibold">{t('callSurface.hangup') || 'End'}</span>
            </Button>
          </div>
        </div>
      )}

      {state.phase === 'terminal' && (
        <div className="p-4 flex flex-col items-center text-center gap-2">
          <div className={cn(
            'w-9 h-9 rounded-full flex items-center justify-center',
            state.terminalStatus === 'failed' || state.terminalStatus === 'declined'
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
            onClick={() => void onClose()}
          >
            {t('common.close') || 'Close'}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Channel-specific tiles ─────────────────────────────────────────────

function AudioWaitingTile() {
  return (
    <div className="rounded-lg bg-warning/5 border border-warning/20 px-3 py-4 flex items-center gap-3">
      <div className="relative">
        <div className="w-10 h-10 rounded-full bg-warning/10 flex items-center justify-center text-warning">
          <Phone className="w-4 h-4" aria-hidden="true" />
        </div>
        <span
          className="absolute inset-0 rounded-full ring-2 ring-warning/30 animate-ping"
          aria-hidden="true"
        />
      </div>
      <div className="flex-1 flex items-center gap-1" aria-hidden="true">
        {/* fake audio bars */}
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
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
  // Render an <audio> element per remote participant audio track.
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
    <div className="rounded-lg bg-success/5 border border-success/20 px-3 py-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-full bg-success/10 flex items-center justify-center text-success">
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
