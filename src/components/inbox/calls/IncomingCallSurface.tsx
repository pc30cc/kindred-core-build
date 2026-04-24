/**
 * Phase — Inbox Call Hardening · Pass 3
 *
 * Operator-side incoming-call surface.
 *
 * Source of truth: the existing call queue (offered_to_user_id === me).
 * This intentionally REUSES the polling already done by CallQueuePanel /
 * OperatorCallDock so we don't open a third polling channel for the same
 * data. The widget core, departments, and queue routing are untouched.
 *
 * Lifecycle:
 *   1. Poll /api/call-queue every 5s (own poll — the panel mounts above
 *      the inbox shell and we don't want to depend on its mount).
 *   2. When an entry's state === 'offered' AND offered_to_user_id === me,
 *      enter "incoming ringing" UI and start the incoming ringtone.
 *   3. Operator clicks Accept → call queueApi.accept → host receives the
 *      conversation and CallQueuePanel's onAccept switches the inbox.
 *      Operator clicks Decline → call queueApi.cancel with reason
 *      'operator_declined' so the engine cleans up.
 *   4. On any transition out (accepted/cancelled/expired/missed/poll
 *      reveals a different offer), stop the ringtone idempotently.
 *
 * Hard rules:
 *   - Ringtone uses the central controller → impossible to overlap with
 *     ringback or with another incoming surface mounted twice.
 *   - Cleanup runs on offer change, accept, decline, unmount, and
 *     visibility change. Each is idempotent.
 *   - Modal is closed automatically when the offer goes away — the
 *     operator never has to manually dismiss a stale ringing card.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Phone, Video, PhoneOff, CheckCircle2, Loader2, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { callQueueApi, type CallQueueEntry } from '@/lib/call-queue-api';
import { ringtone } from '@/lib/calls/ringtone';
import { useAuth } from '@/features/auth/AuthContext';

const POLL_MS = 5000;

function offerVisitorName(entry: CallQueueEntry): string {
  const md = (entry.metadata || {}) as Record<string, unknown>;
  if (typeof md.visitor_name === 'string' && md.visitor_name.trim()) return md.visitor_name;
  return 'Visitor';
}

function offerCountry(entry: CallQueueEntry): string | null {
  const md = (entry.metadata || {}) as Record<string, unknown>;
  return typeof md.country === 'string' && md.country ? md.country : null;
}

export interface IncomingCallSurfaceProps {
  workspaceId: string;
  /** Called when operator accepts. Host should switch to the conversation. */
  onAccepted?: (entry: CallQueueEntry) => void;
}

export function IncomingCallSurface({ workspaceId, onAccepted }: IncomingCallSurfaceProps) {
  const { user } = useAuth();
  const myId = user?.id ?? null;
  const [active, setActive] = useState<CallQueueEntry | null>(null);
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  // Track which offer we already rang for, to avoid re-starting the
  // ringtone every poll tick (start() is already idempotent for the same
  // kind, but this also resets per-offer state cleanly).
  const ringingForRef = useRef<string | null>(null);

  const stopRing = useCallback(() => {
    if (ringtone.currentKind() === 'incoming') ringtone.stop();
    ringingForRef.current = null;
  }, []);

  // ── Polling ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!workspaceId || !myId) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const r = await callQueueApi.list(workspaceId);
        if (cancelled) return;
        const offer = r.entries.find(
          (e) => e.state === 'offered' && e.offered_to_user_id === myId,
        ) ?? null;
        setActive((prev) => {
          if (!offer) return null;
          if (!prev || prev.id !== offer.id) return offer;
          // Keep the same reference when nothing meaningful changed —
          // avoids needless re-renders of the modal.
          return offer;
        });
      } catch {
        /* network blips: keep current state, next tick recovers */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [workspaceId, myId]);

  // ── Ringtone lifecycle, driven by `active` ──────────────────────────
  useEffect(() => {
    if (active && ringingForRef.current !== active.id) {
      ringingForRef.current = active.id;
      // start() is idempotent for the same kind; switching from ringback
      // (operator initiated outgoing while an offer arrived — rare) is
      // also handled by the controller's start() guard.
      ringtone.start('incoming');
    } else if (!active) {
      stopRing();
    }
  }, [active, stopRing]);

  // Final safety net — unmount.
  useEffect(() => () => stopRing(), [stopRing]);

  // Stop sound when the tab is hidden — visual modal stays so the
  // operator can still see who's calling when they return.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        if (ringtone.currentKind() === 'incoming') ringtone.stop();
      } else if (active) {
        ringtone.start('incoming');
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [active]);

  const accept = useCallback(async () => {
    if (!active) return;
    setBusy('accept');
    try {
      const r = await callQueueApi.accept(workspaceId, active.id);
      stopRing();
      onAccepted?.(r.entry);
      setActive(null);
    } catch (e: any) {
      toast({ title: 'Could not accept', description: e?.message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  }, [active, workspaceId, onAccepted, stopRing]);

  const decline = useCallback(async () => {
    if (!active) return;
    setBusy('decline');
    try {
      await callQueueApi.cancel(workspaceId, active.id, 'operator_declined');
      stopRing();
      setActive(null);
    } catch (e: any) {
      toast({ title: 'Could not decline', description: e?.message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  }, [active, workspaceId, stopRing]);

  const open = !!active;
  const isVideo = active?.channel === 'video';
  const Icon = isVideo ? Video : Phone;
  const visitor = useMemo(() => (active ? offerVisitorName(active) : ''), [active]);
  const country = active ? offerCountry(active) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && open) {
          // Treat a dismissal as a soft decline so we don't keep ringing
          // someone who closed the modal.
          void decline();
        }
      }}
    >
      <DialogContent className="max-w-sm" onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span
              className={cn(
                'inline-flex items-center justify-center w-8 h-8 rounded-full',
                isVideo ? 'bg-info/10 text-info' : 'bg-success/10 text-success',
                'animate-call-ring-pulse',
              )}
              aria-hidden
            >
              <Icon className="w-4 h-4" />
            </span>
            Incoming {isVideo ? 'video' : 'audio'} call
            <Badge variant="secondary" className="ml-auto text-[10px] capitalize">
              {active?.channel}
            </Badge>
          </DialogTitle>
          <DialogDescription className="text-xs flex items-center gap-1.5 pt-1">
            <User className="w-3 h-3 text-muted-foreground" />
            <span className="font-medium text-foreground">{visitor}</span>
            {country && <span className="text-muted-foreground">· {country}</span>}
            <span className="text-warning ml-auto inline-flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Ringing…
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 mt-2">
          <Button
            variant="outline"
            className="h-10 border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={() => void decline()}
            disabled={busy !== null}
            aria-label="Decline incoming call"
          >
            {busy === 'decline' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <PhoneOff className="w-4 h-4 mr-1.5" />
                Decline
              </>
            )}
          </Button>
          <Button
            className="h-10 bg-success text-success-foreground hover:bg-success/90"
            onClick={() => void accept()}
            disabled={busy !== null}
            aria-label="Accept incoming call"
          >
            {busy === 'accept' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4 mr-1.5" />
                Accept
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}