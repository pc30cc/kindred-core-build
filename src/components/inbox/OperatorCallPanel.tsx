/**
 * Phase 9 polish — Invitation-first Operator Call Panel.
 *
 * The operator creates an invitation; the actual media session only starts
 * when the visitor joins. This panel:
 *
 *   - exposes Invite-to-audio / Invite-to-video buttons
 *   - subscribes to realtime invitation lifecycle nudges via the
 *     `call_invitation_changed` bus (forwarded from useInboxRealtime in
 *     InboxPage). Polling remains as a 4s / 20s fallback.
 *   - lets the operator cancel a pending invitation
 *   - exposes a Resend action when the latest invitation is terminal
 *   - i18n + a11y polished, no Busy/ringing semantics here
 *
 * NEVER mints tokens, NEVER connects media, NEVER puts the operator into
 * a Busy state. The visitor join handler (server) is the sole entry point
 * into the existing call provider stack.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Phone, Video, Loader2, X, CheckCircle2, Clock, Ban, PhoneOff, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { InviteWaitDialog } from './InviteWaitDialog';

interface OperatorCallPanelProps {
  workspaceId: string;
  conversationId: string;
  contactName?: string | null;
}

interface StatusVisual {
  Icon: React.ComponentType<{ className?: string }>;
  className: string;
  /** translation key for the chip text */
  labelKey: string;
}

const STATUS_VISUAL: Record<InvitationStatus, StatusVisual> = {
  pending:   { Icon: Loader2,      className: 'bg-warning/10 border-warning/30 text-warning',                       labelKey: 'inbox.callInvite.statusPending' },
  joined:    { Icon: CheckCircle2, className: 'bg-success/10 border-success/30 text-success',                       labelKey: 'inbox.callInvite.statusJoined' },
  expired:   { Icon: Clock,        className: 'bg-muted border-border text-muted-foreground',                       labelKey: 'inbox.callInvite.statusExpired' },
  cancelled: { Icon: Ban,          className: 'bg-muted/60 border-border text-muted-foreground',                    labelKey: 'inbox.callInvite.statusCancelled' },
  declined:  { Icon: PhoneOff,     className: 'bg-destructive/10 border-destructive/30 text-destructive',           labelKey: 'inbox.callInvite.statusDeclined' },
};

export function OperatorCallPanel({ workspaceId, conversationId }: OperatorCallPanelProps) {
  const { t } = useTranslation();
  const [latest, setLatest] = useState<CallInvitation | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<InvitationChannel | null>(null);
  const [, forceTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Dialog state — the operator must pick a wait window before the
  // invitation is actually created. Channel here drives both the dialog
  // copy and the create payload on confirm.
  const [dialogChannel, setDialogChannel] = useState<InvitationChannel | null>(null);

  // ── Localized "Xm Ys left" formatter ──────────────────────────────
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

  // Reset state when switching conversations.
  useEffect(() => {
    setLatest(null);
    setCreating(null);
    setLoading(false);
  }, [conversationId]);

  const refresh = useCallback(async () => {
    try {
      const { invitations } = await callInvitationsApi.listForConversation(conversationId);
      const next = invitations[0] ?? null;
      setLatest(next);
    } catch {
      // Silent — polling retries.
    }
  }, [conversationId]);

  // Initial load.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Polling fallback (4s while pending, 20s otherwise — realtime drives most updates).
  useEffect(() => {
    const interval = latest?.status === 'pending' ? 4000 : 20000;
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => { void refresh(); }, interval);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [latest?.status, refresh]);

  // ── Realtime nudges from useInboxRealtime → bus ──────────────────
  // Patch local state immediately on a matching invitation event, then
  // background-refresh to confirm canonical row.
  useEffect(() => {
    return onInvitationChanged((evt) => {
      if (evt.conversation_id !== conversationId) return;
      setLatest((prev) => {
        // Same invitation — patch in place.
        if (prev && prev.id === evt.invitation_id) {
          return { ...prev, status: evt.status };
        }
        // New invitation we haven't fetched yet — schedule refresh.
        return prev;
      });
      void refresh();
    });
  }, [conversationId, refresh]);

  // Countdown ticker (re-render every second while pending so TTL updates).
  useEffect(() => {
    if (latest?.status !== 'pending') return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [latest?.status, latest?.id]);

  // Open the wait-time chooser. Actual create happens in handleConfirmWait.
  const openInviteDialog = useCallback((channel: InvitationChannel) => {
    if (creating || (latest?.status === 'pending')) return;
    setDialogChannel(channel);
  }, [creating, latest?.status]);

  const sendInvite = useCallback(async (channel: InvitationChannel, ttlSeconds: number) => {
    if (creating || (latest?.status === 'pending')) return;
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
      // Open the operator-side waiting/call surface immediately. The
      // surface listens for this event in the same tab and decides which
      // channel-specific UI (audio-only or video) to render.
      try {
        window.dispatchEvent(new CustomEvent('operator-call:invitation-created', {
          detail: { invitation, conversationId },
        }));
      } catch { /* ignore */ }
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
  }, [workspaceId, conversationId, creating, latest?.status, t]);

  const handleConfirmWait = useCallback((seconds: number) => {
    if (!dialogChannel) return;
    void sendInvite(dialogChannel, seconds);
  }, [dialogChannel, sendInvite]);

  const closeDialog = useCallback(() => {
    if (creating) return;
    setDialogChannel(null);
  }, [creating]);

  const cancelInvite = useCallback(async () => {
    if (!latest || latest.status !== 'pending') return;
    setLoading(true);
    try {
      const { invitation } = await callInvitationsApi.cancel(latest.id);
      setLatest(invitation);
    } catch (e: any) {
      toast({
        title: t('inbox.callInvite.cancelFailed') || 'Could not cancel invitation',
        description: e?.message || String(e),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [latest, t]);

  const visual = useMemo(() => latest ? STATUS_VISUAL[latest.status] : null, [latest]);
  const isPending = latest?.status === 'pending';
  const isTerminal = !!latest && !isPending;
  const lastChannel: InvitationChannel = latest?.channel === 'video' ? 'video' : 'audio';

  // Pending state — show the live invitation with cancel.
  if (isPending && latest && visual) {
    const remaining = formatRemaining(latest.expires_at);
    const VisualIcon = visual.Icon;
    const ChannelIcon = latest.channel === 'video' ? Video : Phone;
    const accentRing = latest.channel === 'video' ? 'ring-violet-500/30' : 'ring-warning/30';
    const accentBg = latest.channel === 'video' ? 'bg-violet-500/5 border-violet-500/30' : 'bg-warning/5 border-warning/30';
    const accentText = latest.channel === 'video' ? 'text-violet-600 dark:text-violet-400' : 'text-warning';
    return (
      <>
      <div
        className={cn(
          'flex items-center gap-1.5 rounded-md border px-2 py-1 ring-1 ring-inset transition-colors',
          accentBg,
          accentRing,
        )}
        role="status"
        aria-live="polite"
        aria-label={
          latest.channel === 'video'
            ? `${t('inbox.callInvite.statusPending') || 'Pending'} — ${t('inbox.callInvite.video') || 'Video'} · ${remaining}`
            : `${t('inbox.callInvite.statusPending') || 'Pending'} — ${t('inbox.callInvite.audio') || 'Audio'} · ${remaining}`
        }
      >
        <ChannelIcon className={cn('w-3 h-3', accentText)} aria-hidden="true" />
        <span className="text-[10px] font-semibold text-foreground">
          {latest.channel === 'video'
            ? (t('inbox.callInvite.video') || 'Video')
            : (t('inbox.callInvite.audio') || 'Audio')}
        </span>
        <Badge className={cn('h-4 px-1.5 text-[9px] font-semibold gap-1 border tabular-nums', visual.className)}>
          <VisualIcon className="w-2.5 h-2.5 animate-spin" aria-hidden="true" />
          <span>{remaining}</span>
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
          onClick={cancelInvite}
          disabled={loading}
          aria-label={t('inbox.callInvite.cancel') || 'Cancel invitation'}
          title={t('inbox.callInvite.cancel') || 'Cancel invitation'}
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <X className="w-3 h-3" aria-hidden="true" />}
        </Button>
      </div>
      </>
    );
  }

  // Idle / terminal — invite buttons + a status pill + (if terminal) a resend shortcut.
  const TerminalIcon = visual?.Icon ?? Clock;
  return (
    <>
    <div className="flex items-center gap-1.5" role="group" aria-label={t('inbox.callInvite.lastInvite') || 'Last invite'}>
      {isTerminal && latest && visual && (
        <Badge
          className={cn('h-5 px-1.5 text-[9px] font-semibold gap-1 border', visual.className)}
          title={`${t('inbox.callInvite.lastInvite') || 'Last invite'}: ${t(visual.labelKey as any) || visual.labelKey}`}
          aria-label={`${t('inbox.callInvite.lastInvite') || 'Last invite'}: ${t(visual.labelKey as any) || visual.labelKey}`}
        >
          <TerminalIcon className="w-2.5 h-2.5" aria-hidden="true" />
          <span>{t(visual.labelKey as any) || visual.labelKey}</span>
        </Badge>
      )}
      {isTerminal && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          onClick={() => openInviteDialog(lastChannel)}
          disabled={loading || creating !== null}
          aria-label={
            lastChannel === 'video'
              ? (t('inbox.callInvite.resendVideo') || 'Resend video invite')
              : (t('inbox.callInvite.resendAudio') || 'Resend audio invite')
          }
          title={t('inbox.callInvite.resend') || 'Resend'}
        >
          {creating === lastChannel
            ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
            : <RotateCw className="w-3 h-3" aria-hidden="true" />}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2.5 text-[10px] font-semibold gap-1.5 hover:bg-warning/5 hover:border-warning/30 hover:text-warning transition-colors"
        onClick={() => openInviteDialog('audio')}
        disabled={loading || creating !== null}
        aria-label={t('inbox.callInvite.audioAria') || 'Invite to audio call'}
        title={t('inbox.callInvite.inviteAudio') || 'Invite to audio'}
      >
        {creating === 'audio'
          ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
          : <Phone className="w-3 h-3" aria-hidden="true" />}
        <span className="hidden sm:inline">{t('inbox.callInvite.inviteAudioShort') || 'Invite'}</span>
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2.5 text-[10px] font-semibold gap-1.5 hover:bg-violet-500/5 hover:border-violet-500/30 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
        onClick={() => openInviteDialog('video')}
        disabled={loading || creating !== null}
        aria-label={t('inbox.callInvite.videoAria') || 'Invite to video call'}
        title={t('inbox.callInvite.inviteVideo') || 'Invite to video'}
      >
        {creating === 'video'
          ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
          : <Video className="w-3 h-3" aria-hidden="true" />}
        <span className="hidden sm:inline">{t('inbox.callInvite.inviteVideoShort') || 'Video'}</span>
      </Button>
    </div>
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