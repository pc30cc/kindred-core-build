/**
 * Phase — Inbox Call Unification · Pass C + D
 *
 * Pure-presentation incoming-call modal. Reads engine state from the
 * shared CallSessionProvider. Owns ZERO lifecycle:
 *   - polling lives in useIncomingCallSignal
 *   - ringtone is gated by phase === 'incoming_ringing' (one effect)
 *   - accept/decline call engine commands; engine connects media + handles
 *     every failure path (busy release, queue cancel, transport teardown)
 *
 * Visual: video calls now render the video icon during ringing too, so
 * the audio-vs-video split applies across the full lifecycle instead of
 * only at connected.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Phone, Video, PhoneOff, CheckCircle2, Loader2, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { ringtone } from '@/lib/calls/ringtone';
import { useAuth } from '@/features/auth/AuthContext';
import { useCallSessionContext } from '@/features/calls/CallSessionProvider';
import { useIncomingCallSignal } from '@/hooks/useIncomingCallSignal';
import { isTerminalPhase } from '@/lib/calls/CallSessionEngine';
import { operatorCallErrorMessage } from '@/lib/calls/selectors';

export interface IncomingCallSurfaceProps {
  workspaceId: string;
  /** Called when operator accepts — host can focus the linked conversation. */
  onAccepted?: (info: { conversationId: string | null }) => void;
}

export function IncomingCallSurface({ workspaceId, onAccepted }: IncomingCallSurfaceProps) {
  const { user } = useAuth();
  const myId = user?.id ?? null;
  const session = useCallSessionContext();
  const { state, engine, acceptIncoming, declineIncoming } = session;
  const phase = state.phase;
  const offer = state.incomingOffer;
  const isRinging = phase === 'incoming_ringing' && !!offer;
  const isConnecting = phase === 'connecting' && state.direction === 'incoming';
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const lastErrorRef = useRef<string | null>(null);

  // Single signal source — feeds the engine via the central adapter
  // (realtime-first, polling fallback). Stats are unused here; the
  // OperatorCallDock surfaces the secondary "another call waiting" badge.
  useIncomingCallSignal({ workspaceId, userId: myId, engine });

  // Ringtone strictly follows engine phase.
  useEffect(() => {
    if (phase === 'incoming_ringing') {
      ringtone.start('incoming');
    } else if (ringtone.currentKind() === 'incoming') {
      ringtone.stop();
    }
  }, [phase]);

  // Final safety net — unmount.
  useEffect(() => () => {
    if (ringtone.currentKind() === 'incoming') ringtone.stop();
  }, []);

  // Pause sound while tab hidden; visuals stay so operator sees on return.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        if (ringtone.currentKind() === 'incoming') ringtone.stop();
      } else if (phase === 'incoming_ringing') {
        ringtone.start('incoming');
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [phase]);

  const accept = useCallback(async () => {
    if (!offer) return;
    setBusy('accept');
    const convId = offer.conversationId;
    try {
      await acceptIncoming({ displayName: 'Operator' });
      // Focus the conversation so the operator lands in the right thread.
      if (convId) onAccepted?.({ conversationId: convId });
    } catch (e: any) {
      // Engine has already classified + cleaned up; we just surface it.
      toast({ title: 'Could not accept', description: e?.message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  }, [offer, acceptIncoming, onAccepted]);

  const decline = useCallback(async () => {
    if (!offer) return;
    setBusy('decline');
    try {
      await declineIncoming('operator_declined');
    } catch (e: any) {
      toast({ title: 'Could not decline', description: e?.message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  }, [offer, declineIncoming]);

  // Surface terminal failures from accept attempts.
  useEffect(() => {
    if (phase === 'failed' && state.direction === 'incoming') {
      const key = (state.errorCode ?? '') + ':' + (state.errorMessage ?? '');
      if (lastErrorRef.current === key) return;
      lastErrorRef.current = key;
      toast({
        title: 'Could not start the call',
        description: operatorCallErrorMessage(state.errorCode, state.errorMessage),
        variant: 'destructive',
      });
    } else if (phase === 'idle') {
      lastErrorRef.current = null;
    }
  }, [phase, state.direction, state.errorCode, state.errorMessage]);

  // Keep the modal up across ringing → connecting → (terminal grace).
  const open = isRinging || isConnecting;
  const isVideo = (offer?.callType ?? 'audio') === 'video';
  const Icon = isVideo ? Video : Phone;
  const visitor = useMemo(() => offer?.visitorName || 'Visitor', [offer?.visitorName]);
  const country = offer?.country ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // Only "soft decline" while still ringing — dismissing during
        // connecting would tear down media we just attached.
        if (!v && isRinging) {
          void decline();
        }
      }}
    >
      <DialogContent
        className="max-w-sm"
        onEscapeKeyDown={(e) => e.preventDefault()}
        // Don't let outside-clicks tear down a connecting call.
        onPointerDownOutside={(e) => { if (!isRinging) e.preventDefault(); }}
        onInteractOutside={(e) => { if (!isRinging) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span
              className={cn(
                'inline-flex items-center justify-center w-8 h-8 rounded-full',
                isVideo ? 'bg-info/10 text-info' : 'bg-success/10 text-success',
                isRinging && 'animate-call-ring-pulse',
              )}
              aria-hidden
            >
              <Icon className="w-4 h-4" />
            </span>
            {isConnecting ? 'Connecting…' : `Incoming ${isVideo ? 'video' : 'audio'} call`}
            <Badge variant="secondary" className="ml-auto text-[10px] capitalize">
              {offer?.callType}
            </Badge>
          </DialogTitle>
          <DialogDescription className="text-xs flex items-center gap-1.5 pt-1">
            <User className="w-3 h-3 text-muted-foreground" />
            <span className="font-medium text-foreground">{visitor}</span>
            {country && <span className="text-muted-foreground">· {country}</span>}
            {isRinging && (
              <span className="text-warning ml-auto inline-flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Ringing…
              </span>
            )}
            {isConnecting && (
              <span className="text-info ml-auto inline-flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Connecting…
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 mt-2">
          <Button
            variant="outline"
            className="h-10 border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={() => void decline()}
            disabled={busy !== null || !isRinging}
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
            disabled={busy !== null || !isRinging}
            aria-label="Accept incoming call"
          >
            {busy === 'accept' || isConnecting ? (
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

// Suppress unused-import warning for isTerminalPhase if pruned later.
void isTerminalPhase;