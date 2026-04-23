/**
 * Phase 8C / 8D — Operator Call Queue Panel.
 *
 * Adds in 8D:
 *  - SLA indicators (offer countdown + "long wait" highlight)
 *  - Offered-to-me highlight
 *  - Channel badges
 *  - Callback requests section
 *  - Waiting duration that ticks every 10s
 *
 * No backend logic changed — pure consumer of existing endpoints + the
 * new /api/callbacks operator endpoint.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Phone, Video, X, Loader2, CheckCircle2, Bell, Voicemail, AlertTriangle, Clock, Globe, User, MessageSquare, CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { callQueueApi, type CallQueueEntry } from '@/lib/call-queue-api';
import { callbacksApi, type CallbackRow } from '@/lib/callbacks-api';
import { useAuth } from '@/features/auth/AuthContext';
import { cn } from '@/lib/utils';

interface CallQueuePanelProps {
  workspaceId: string;
  /** Called when operator accepts an entry — host can switch to the conversation. */
  onAccept?: (entry: CallQueueEntry) => void;
}

const LONG_WAIT_SECONDS = 60;

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h';
}

function offerCountdown(iso: string | null | undefined): { secs: number; label: string } | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  const secs = Math.max(0, Math.ceil(ms / 1000));
  return { secs, label: secs + 's' };
}

export function CallQueuePanel({ workspaceId, onAccept }: CallQueuePanelProps) {
  const { user } = useAuth();
  const myId = user?.id ?? null;
  const [entries, setEntries] = useState<CallQueueEntry[]>([]);
  const [callbacks, setCallbacks] = useState<CallbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [perms, setPerms] = useState<{
    can_join_queue_calls: boolean;
    can_receive_audio_call: boolean;
    can_receive_video_call: boolean;
  } | null>(null);
  const [, force] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [r, cb] = await Promise.all([
        callQueueApi.list(workspaceId),
        callbacksApi.list(workspaceId, 'open').catch(() => [] as CallbackRow[]),
      ]);
      setEntries(r.entries.filter((e) =>
        e.state === 'queued' || e.state === 'offered' || e.state === 'callback_requested'
      ));
      setCallbacks(cb);
    } catch {
      /* network blips are fine — next tick will retry */
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await callQueueApi.myPermissions(workspaceId);
        if (!cancelled) setPerms(p);
      } catch {
        if (!cancelled) setPerms({ can_join_queue_calls: false, can_receive_audio_call: false, can_receive_video_call: false });
      }
    })();
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    const tickT = setInterval(() => force((n) => n + 1), 1000);
    return () => { cancelled = true; clearInterval(t); clearInterval(tickT); };
  }, [workspaceId, refresh]);

  const onOffer = useCallback(async (entry: CallQueueEntry) => {
    setBusy(entry.id);
    try {
      await callQueueApi.offer(workspaceId, entry.id);
      await refresh();
    } catch (e: any) {
      toast({ title: 'Could not offer', description: e?.message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  }, [workspaceId, refresh]);

  const onAcceptClick = useCallback(async (entry: CallQueueEntry) => {
    setBusy(entry.id);
    try {
      const r = await callQueueApi.accept(workspaceId, entry.id);
      toast({ title: 'Visitor accepted from queue' });
      onAccept?.(r.entry);
      await refresh();
    } catch (e: any) {
      toast({ title: 'Could not accept', description: e?.message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  }, [workspaceId, refresh, onAccept]);

  const onCancel = useCallback(async (entry: CallQueueEntry) => {
    setBusy(entry.id);
    try {
      await callQueueApi.cancel(workspaceId, entry.id, 'operator_cancelled');
      await refresh();
    } catch (e: any) {
      toast({ title: 'Could not cancel', description: e?.message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  }, [workspaceId, refresh]);

  const onCompleteCallback = useCallback(async (cb: CallbackRow) => {
    setBusy(cb.id);
    try {
      await callbacksApi.update(workspaceId, cb.id, 'completed');
      await refresh();
    } catch (e: any) {
      toast({ title: 'Could not update callback', description: e?.message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  }, [workspaceId, refresh]);

  const eligible = useMemo(() => {
    if (!perms || !perms.can_join_queue_calls) return [] as CallQueueEntry[];
    return entries.filter((e) =>
      (e.channel === 'audio' && perms.can_receive_audio_call) ||
      (e.channel === 'video' && perms.can_receive_video_call),
    );
  }, [entries, perms]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (perms && !perms.can_join_queue_calls) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-xs text-muted-foreground">
          You don't have permission to handle the call queue.
        </CardContent>
      </Card>
    );
  }

  if (eligible.length === 0 && callbacks.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-xs text-muted-foreground flex flex-col items-center gap-2">
          <Bell className="h-5 w-5 opacity-50" />
          <div>No visitors waiting.</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {eligible.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Bell className="h-4 w-4 text-primary" />
              Call Queue
              <Badge variant="secondary" className="ml-auto text-[10px]">{eligible.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {eligible.map((entry) => {
              const isVideo = entry.channel === 'video';
              const isOffered = entry.state === 'offered';
              const offeredToMe = isOffered && entry.offered_to_user_id === myId;
              const Icon = isVideo ? Video : Phone;
              const waitSecs = Math.max(0, Math.floor((Date.now() - new Date(entry.created_at).getTime()) / 1000));
              const longWait = waitSecs >= LONG_WAIT_SECONDS;
              const cd = isOffered ? offerCountdown(entry.last_offer_expires_at) : null;
              const slaBreached = !!entry.sla_breached;

              return (
                <div
                  key={entry.id}
                  className={cn(
                    'rounded-lg border p-2.5 flex flex-col gap-2 transition-colors',
                    offeredToMe ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                      : isOffered ? 'border-warning/50 bg-warning/5'
                      : slaBreached ? 'border-destructive/40 bg-destructive/5'
                      : 'border-border bg-card/40',
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className={cn(
                      'w-7 h-7 rounded-full flex items-center justify-center shrink-0',
                      isVideo ? 'bg-info/10 text-info' : 'bg-success/10 text-success',
                    )}>
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px] font-semibold text-foreground capitalize">
                          {entry.channel} call
                        </span>
                        <Badge variant="outline" className="text-[9px] py-0 h-4 capitalize">
                          {entry.channel}
                        </Badge>
                        {offeredToMe && (
                          <Badge className="text-[9px] py-0 h-4 bg-primary text-primary-foreground">
                            For you
                          </Badge>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground flex items-center gap-1.5 mt-0.5">
                        <Clock className="h-2.5 w-2.5" />
                        <span>Waiting {relTime(entry.created_at)}</span>
                        {longWait && !isOffered && (
                          <span className="text-warning font-medium">· long wait</span>
                        )}
                        {cd && (
                          <span className={cn('font-medium', cd.secs <= 5 ? 'text-destructive' : 'text-warning')}>
                            · offer {cd.label}
                          </span>
                        )}
                      </div>
                    </div>
                    <Badge variant={isOffered ? 'default' : 'outline'} className="text-[9px]">
                      {entry.state}
                    </Badge>
                  </div>

                  {(slaBreached || (entry.missed_offer_count ?? 0) > 0) && (
                    <div className="flex items-center gap-1.5 text-[10px] text-destructive">
                      <AlertTriangle className="h-3 w-3" />
                      {slaBreached && <span>SLA breached</span>}
                      {(entry.missed_offer_count ?? 0) > 0 && (
                        <span>· missed {entry.missed_offer_count}</span>
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-1.5">
                    {!isOffered && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[10px] flex-1"
                        disabled={busy === entry.id}
                        onClick={() => void onOffer(entry)}
                      >
                        {busy === entry.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Offer'}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      className={cn(
                        'h-7 px-2 text-[10px] flex-1',
                        offeredToMe
                          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                          : 'bg-success text-success-foreground hover:bg-success/90',
                      )}
                      disabled={busy === entry.id}
                      onClick={() => void onAcceptClick(entry)}
                    >
                      {busy === entry.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <>
                          <CheckCircle2 className="w-3 h-3 mr-1" />
                          Accept
                        </>
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      disabled={busy === entry.id}
                      onClick={() => void onCancel(entry)}
                      aria-label="Cancel"
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {callbacks.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Voicemail className="h-4 w-4 text-info" />
              Callback requests
              <Badge variant="secondary" className="ml-auto text-[10px]">{callbacks.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {callbacks.map((cb) => {
              const isVideo = cb.channel === 'video';
              const Icon = isVideo ? Video : Phone;
              return (
                <div
                  key={cb.id}
                  className="rounded-lg border border-info/30 bg-info/5 p-2.5 flex flex-col gap-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className={cn(
                      'w-7 h-7 rounded-full flex items-center justify-center shrink-0',
                      isVideo ? 'bg-info/10 text-info' : 'bg-success/10 text-success',
                    )}>
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-semibold text-foreground capitalize">
                        Callback · {cb.channel}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        Requested {relTime(cb.requested_at)}
                        {cb.contact_phone && ` · ${cb.contact_phone}`}
                        {cb.contact_email && ` · ${cb.contact_email}`}
                      </div>
                    </div>
                    <Badge variant="outline" className="text-[9px]">{cb.status}</Badge>
                  </div>
                  {cb.notes && (
                    <div className="text-[11px] text-muted-foreground bg-background/40 rounded p-1.5 line-clamp-2">
                      {cb.notes}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[10px] flex-1"
                      disabled={busy === cb.id}
                      onClick={() => void onCompleteCallback(cb)}
                    >
                      {busy === cb.id ? <Loader2 className="w-3 h-3 animate-spin" /> : (
                        <><CheckCircle2 className="w-3 h-3 mr-1" /> Mark completed</>
                      )}
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
