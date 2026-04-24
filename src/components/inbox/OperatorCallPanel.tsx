/**
 * Phase 9 — Invitation-first Operator Call Panel.
 *
 * Replaces the legacy direct-ringing buttons. The operator now creates a
 * call invitation that posts an interactive card into the visitor's
 * conversation; the actual media session only starts when the visitor
 * clicks Join. This panel:
 *
 *   - exposes Invite-to-audio / Invite-to-video buttons
 *   - polls /api/call-invitations?conversation_id=… so the latest
 *     invitation lifecycle (pending / joined / expired / cancelled /
 *     declined) is always visible without needing realtime
 *   - lets the operator cancel a pending invitation
 *
 * IMPORTANT: this component never mints tokens, never connects media, and
 * never puts the operator into a Busy state. The visitor join handler
 * (server) is the sole entry point into the existing call provider stack.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Phone, Video, Loader2, X, CheckCircle2, Clock, Ban, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  callInvitationsApi,
  type CallInvitation,
  type InvitationChannel,
  type InvitationStatus,
} from '@/lib/call-invitations-api';

interface OperatorCallPanelProps {
  workspaceId: string;
  conversationId: string;
  contactName?: string | null;
}

interface StatusVisual {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  className: string;
}

const STATUS_VISUAL: Record<InvitationStatus, StatusVisual> = {
  pending:   { label: 'Pending',   Icon: Loader2,        className: 'bg-warning/10 border-warning/30 text-warning' },
  joined:    { label: 'Joined',    Icon: CheckCircle2,   className: 'bg-success/10 border-success/30 text-success' },
  expired:   { label: 'Expired',   Icon: Clock,          className: 'bg-muted border-border text-muted-foreground' },
  cancelled: { label: 'Cancelled', Icon: Ban,            className: 'bg-muted border-border text-muted-foreground' },
  declined:  { label: 'Declined',  Icon: PhoneOff,       className: 'bg-destructive/10 border-destructive/30 text-destructive' },
};

function formatRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const total = Math.ceil(ms / 1000);
  if (total < 60) return total + 's left';
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? m + 'm left' : m + 'm ' + s + 's left';
}

export function OperatorCallPanel({ workspaceId, conversationId }: OperatorCallPanelProps) {
  const [latest, setLatest] = useState<CallInvitation | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<InvitationChannel | null>(null);
  const [, forceTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { invitations } = await callInvitationsApi.listForConversation(conversationId);
      // The list comes back ordered DESC by created_at; take the first.
      const next = invitations[0] ?? null;
      setLatest(next);
    } catch (e: any) {
      // Don't toast — silent retry on next interval.
      // 403 just means we joined a conversation we don't own; never spammy.
    }
  }, [conversationId]);

  // Poll lifecycle (every 4s while pending, every 15s otherwise).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = latest?.status === 'pending' ? 4000 : 15000;
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => { void refresh(); }, interval);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [latest?.status, refresh]);

  // Countdown ticker (re-render every second while pending so TTL updates).
  useEffect(() => {
    if (latest?.status !== 'pending') return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [latest?.status, latest?.id]);

  const sendInvite = useCallback(async (channel: InvitationChannel) => {
    if (creating || (latest?.status === 'pending')) return;
    setCreating(channel);
    setLoading(true);
    try {
      const { invitation } = await callInvitationsApi.create({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        channel,
      });
      setLatest(invitation);
      toast({
        title: channel === 'video' ? 'Video invite sent' : 'Audio invite sent',
        description: 'The visitor can join from the conversation card.',
      });
    } catch (e: any) {
      toast({
        title: 'Could not send invite',
        description: e?.message || String(e),
        variant: 'destructive',
      });
    } finally {
      setCreating(null);
      setLoading(false);
    }
  }, [workspaceId, conversationId, creating, latest?.status]);

  const cancelInvite = useCallback(async () => {
    if (!latest || latest.status !== 'pending') return;
    setLoading(true);
    try {
      const { invitation } = await callInvitationsApi.cancel(latest.id);
      setLatest(invitation);
    } catch (e: any) {
      toast({
        title: 'Could not cancel invitation',
        description: e?.message || String(e),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [latest]);

  const visual = useMemo(() => latest ? STATUS_VISUAL[latest.status] : null, [latest]);
  const isPending = latest?.status === 'pending';

  // Pending state — show the live invitation with cancel.
  if (isPending && latest && visual) {
    const remaining = formatRemaining(latest.expires_at);
    const VisualIcon = visual.Icon;
    const ChannelIcon = latest.channel === 'video' ? Video : Phone;
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-2 py-1">
        <ChannelIcon className="w-3 h-3 text-warning" />
        <span className="text-[10px] font-semibold text-foreground">
          {latest.channel === 'video' ? 'Video invite' : 'Audio invite'}
        </span>
        <Badge className={cn('h-4 px-1.5 text-[9px] font-semibold gap-1 border', visual.className)}>
          <VisualIcon className={cn('w-2.5 h-2.5', isPending && 'animate-spin')} />
          {remaining}
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
          onClick={cancelInvite}
          disabled={loading}
          aria-label="Cancel invitation"
          title="Cancel invitation"
        >
          <X className="w-3 h-3" />
        </Button>
      </div>
    );
  }

  // Idle / terminal — show invite buttons + last status pill if any.
  return (
    <div className="flex items-center gap-1.5">
      {latest && visual && (
        <Badge
          className={cn('h-5 px-1.5 text-[9px] font-semibold gap-1 border', visual.className)}
          title={'Last invitation: ' + visual.label.toLowerCase()}
        >
          <visual.Icon className="w-2.5 h-2.5" />
          {visual.label}
        </Badge>
      )}
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2.5 text-[10px] font-semibold"
        onClick={() => sendInvite('audio')}
        disabled={loading || creating !== null}
        aria-label="Invite to audio call"
      >
        {creating === 'audio' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Phone className="w-3 h-3" />}
        <span className="hidden sm:inline">Invite</span>
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2.5 text-[10px] font-semibold"
        onClick={() => sendInvite('video')}
        disabled={loading || creating !== null}
        aria-label="Invite to video call"
      >
        {creating === 'video' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Video className="w-3 h-3" />}
        <span className="hidden sm:inline">Video</span>
      </Button>
    </div>
  );
}