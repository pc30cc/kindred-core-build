/**
 * Phase 8C — Operator Call Queue Panel.
 *
 * Mounted in the inbox sidebar/header area. Polls the queue every 5s
 * and lets eligible operators accept or cancel waiting visitors.
 * On accept we call the queue accept API, then route the operator into
 * the existing OperatorCallPanel-style flow by surfacing a button that
 * opens the conversation referenced by the entry (so the existing
 * per-conversation call panel handles the actual ringing).
 *
 * Strict rules:
 *  - No duplicate permissions logic — uses /me/permissions.
 *  - No bespoke realtime — 5s poll + on-demand refresh.
 *  - No backend logic changes — pure consumer of existing endpoints.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Phone, Video, X, Loader2, CheckCircle2, Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { callQueueApi, type CallQueueEntry } from '@/lib/call-queue-api';
import { cn } from '@/lib/utils';

interface CallQueuePanelProps {
  workspaceId: string;
  /** Called when operator accepts an entry — host can switch to the conversation. */
  onAccept?: (entry: CallQueueEntry) => void;
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h';
}

export function CallQueuePanel({ workspaceId, onAccept }: CallQueuePanelProps) {
  const [entries, setEntries] = useState<CallQueueEntry[]>([]);
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
      const r = await callQueueApi.list(workspaceId);
      setEntries(r.entries.filter((e) => e.state === 'queued' || e.state === 'offered'));
    } catch {
      /* network blips are fine — next tick will retry */
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  // Initial perms + first list, then poll every 5s.
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
    // Also tick the relative-time labels every 10s.
    const tickT = setInterval(() => force((n) => n + 1), 10_000);
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

  if (eligible.length === 0) {
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
          const Icon = isVideo ? Video : Phone;
          return (
            <div
              key={entry.id}
              className={cn(
                'rounded-lg border p-2.5 flex flex-col gap-2',
                isOffered ? 'border-warning/50 bg-warning/5' : 'border-border bg-card/40',
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
                  <div className="text-[12px] font-semibold text-foreground capitalize">
                    {entry.channel} call
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Waiting {relTime(entry.created_at)}
                    {isOffered && ' · offered'}
                  </div>
                </div>
                <Badge variant={isOffered ? 'default' : 'outline'} className="text-[9px]">
                  {entry.state}
                </Badge>
              </div>
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
                  className="h-7 px-2 text-[10px] flex-1 bg-success text-success-foreground hover:bg-success/90"
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
  );
}