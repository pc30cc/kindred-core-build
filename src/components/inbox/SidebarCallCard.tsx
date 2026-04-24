/**
 * SidebarCallCard — invitation-first call entry point for the inbox sidebar.
 *
 * Replaces the legacy OperatorCallDock + CallQueuePanel which belonged to
 * the old direct-ringing/queue model. This card is purely invitation-first:
 *
 *   - Two prominent CTAs (Invite to audio / Invite to video) opening the
 *     existing InviteWaitDialog so the operator picks a TTL.
 *   - Live status pill while a pending invitation is in flight, with the
 *     remaining time and a Cancel action.
 *   - Terminal status (joined / declined / expired / cancelled) with a
 *     Resend shortcut for the same channel.
 *   - Fully translated, keyboard-accessible, dark-mode safe, RTL safe.
 *
 * Mints no tokens and never connects media. The OperatorCallSurface (driven
 * by the same `operator-call:invitation-created` custom event) is the
 * single owner of the actual call lifecycle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Phone, Video, Loader2, X, CheckCircle2, Clock, Ban, PhoneOff, RotateCw } from 'lucide-react';
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
import { InviteWaitDialog } from './InviteWaitDialog';

interface SidebarCallCardProps {
  workspaceId: string;
  conversationId: string;
  contactName?: string | null;
}

interface StatusVisual {
  Icon: React.ComponentType<{ className?: string }>;
  className: string;
  labelKey: string;
}

const STATUS_VISUAL: Record<InvitationStatus, StatusVisual> = {
  pending:   { Icon: Loader2,      className: 'bg-warning/10 border-warning/30 text-warning',                       labelKey: 'inbox.callInvite.statusPending' },
  joined:    { Icon: CheckCircle2, className: 'bg-success/10 border-success/30 text-success',                       labelKey: 'inbox.callInvite.statusJoined' },
  expired:   { Icon: Clock,        className: 'bg-muted border-border text-muted-foreground',                       labelKey: 'inbox.callInvite.statusExpired' },
  cancelled: { Icon: Ban,          className: 'bg-muted/60 border-border text-muted-foreground',                    labelKey: 'inbox.callInvite.statusCancelled' },
  declined:  { Icon: PhoneOff,     className: 'bg-destructive/10 border-destructive/30 text-destructive',           labelKey: 'inbox.callInvite.statusDeclined' },
};

export function SidebarCallCard({ workspaceId, conversationId, contactName }: SidebarCallCardProps) {
  const { t } = useTranslation();
  const [latest, setLatest] = useState<CallInvitation | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<InvitationChannel | null>(null);
  const [, forceTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      setLatest(invitations[0] ?? null);
    } catch {
      /* polling will retry */
    }
  }, [conversationId]);

  useEffect(() => { void refresh(); }, [refresh]);

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

  // Realtime nudges from useInboxRealtime → bus.
  useEffect(() => {
    return onInvitationChanged((evt) => {
      if (evt.conversation_id !== conversationId) return;
      setLatest((prev) => {
        if (prev && prev.id === evt.invitation_id) {
          return { ...prev, status: evt.status };
        }
        return prev;
      });
      void refresh();
    });
  }, [conversationId, refresh]);

  // Countdown ticker.
  useEffect(() => {
    if (latest?.status !== 'pending') return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [latest?.status, latest?.id]);

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
  const disableInvites = loading || creating !== null || isPending;

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
          {/* Pending invitation pill */}
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
                    ? (t('inbox.callInvite.waitingFor', { name: contactName }) || `Waiting for ${contactName} to join…`)
                    : (t('inbox.callInvite.waitingForVisitor') || 'Waiting for visitor to join…')}
                </div>
                <div className="text-[10px] text-muted-foreground tabular-nums">
                  {formatRemaining(latest.expires_at)}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                onClick={cancelInvite}
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
                title={`${t('inbox.callInvite.lastInvite') || 'Last invite'}: ${t(visual.labelKey as any) || visual.labelKey}`}
              >
                <visual.Icon className="w-2.5 h-2.5" aria-hidden="true" />
                <span>{t(visual.labelKey as any) || visual.labelKey}</span>
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

          {/* Primary CTAs — full-width, labeled, accessible */}
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