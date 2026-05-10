import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterQueue, useCallCenterCall } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { callCenterApi } from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from '@/hooks/use-toast';
import { Phone, Video, Globe, Headphones, RadioTower, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';

function waitTime(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
function urgencyTone(iso: string): 'neutral' | 'warn' | 'danger' {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec > 180) return 'danger';
  if (sec > 60) return 'warn';
  return 'neutral';
}

export default function LiveQueuePage() {
  const { workspace } = useActiveWorkspace();
  const { data, isLoading } = useCallCenterQueue(workspace?.id);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const { data: detail } = useCallCenterCall(workspace?.id, selectedCallId);
  // Tick to refresh wait timers
  const [, force] = useState(0);
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  async function accept(callId: string) {
    if (!workspace) return;
    setBusy(callId);
    try {
      const r = await callCenterApi.acceptCall(workspace.id, callId);
      toast({ title: 'Call accepted', description: `Provider: ${r.provider}` });
      qc.invalidateQueries({ queryKey: ['call-center'] });
    } catch (e: any) {
      toast({ title: 'Accept failed', description: e.message, variant: 'destructive' });
    } finally { setBusy(null); }
  }
  async function reject(callId: string) {
    if (!workspace) return;
    setBusy(callId);
    try {
      await callCenterApi.rejectCall(workspace.id, callId);
      qc.invalidateQueries({ queryKey: ['call-center'] });
    } catch (e: any) {
      toast({ title: 'Reject failed', description: e.message, variant: 'destructive' });
    } finally { setBusy(null); }
  }

  const queue = data?.queue || [];
  if (!selectedCallId && queue.length > 0) {
    // auto-select top of queue
    setTimeout(() => setSelectedCallId(queue[0].call_session_id), 0);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4 h-full">
      {/* Queue column */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Inbox className="h-4 w-4" /> Incoming queue
            <span className="text-xs font-normal text-muted-foreground">({queue.length})</span>
          </h2>
          <span className="text-[11px] text-muted-foreground flex items-center gap-1">
            <RadioTower className="h-3 w-3" /> Polling 5s
          </span>
        </div>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && queue.length === 0 && (
          <Card className="p-6 text-center space-y-2">
            <Headphones className="h-7 w-7 mx-auto text-muted-foreground" />
            <p className="text-sm font-medium">No calls waiting</p>
            <p className="text-xs text-muted-foreground">When a visitor calls, they'll appear here.</p>
          </Card>
        )}
        {queue.map((q, idx) => {
          const c = q.call_session;
          const tone = urgencyTone(q.created_at);
          const isSel = selectedCallId === q.call_session_id;
          return (
            <Card
              key={q.id}
              onClick={() => setSelectedCallId(q.call_session_id)}
              className={cn(
                'p-3 cursor-pointer transition-all border-2',
                isSel ? 'border-primary shadow-md' : 'border-transparent hover:border-border',
                tone === 'warn' && !isSel && 'border-amber-500/30',
                tone === 'danger' && !isSel && 'border-destructive/40 bg-destructive/5',
              )}
            >
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-primary/10 text-primary p-2">
                  {q.channel === 'video' ? <Video className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="font-medium truncate text-sm">
                      {c?.visitor_name || c?.visitor_email || c?.visitor_phone || 'Anonymous visitor'}
                    </div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted">#{idx + 1}</span>
                  </div>
                  <div className={cn('text-xs mt-0.5',
                    tone === 'danger' ? 'text-destructive font-medium' : tone === 'warn' ? 'text-amber-600' : 'text-muted-foreground',
                  )}>
                    waiting {waitTime(q.created_at)} · {q.channel}
                  </div>
                  {c?.subject && <div className="text-xs text-muted-foreground truncate mt-0.5">{c.subject}</div>}
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                <Button variant="outline" size="sm" className="flex-1" onClick={(e) => { e.stopPropagation(); reject(q.call_session_id); }} disabled={busy === q.call_session_id}>Reject</Button>
                <Button size="sm" className="flex-1" onClick={(e) => { e.stopPropagation(); accept(q.call_session_id); }} disabled={busy === q.call_session_id}>Accept</Button>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Detail column */}
      <Card className="p-5 h-fit lg:sticky lg:top-0">
        {!detail ? (
          <div className="text-sm text-muted-foreground text-center py-12">
            Select a call to view details.
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="text-xs text-muted-foreground">Caller</div>
              <div className="text-lg font-semibold">
                {detail.call.visitor_name || detail.call.visitor_email || detail.call.visitor_phone || 'Anonymous'}
              </div>
              <div className="text-xs text-muted-foreground space-y-0.5 mt-1">
                {detail.call.visitor_email && <div>✉ {detail.call.visitor_email}</div>}
                {detail.call.visitor_phone && <div>📞 {detail.call.visitor_phone}</div>}
              </div>
            </div>
            {detail.call.subject && (
              <div>
                <div className="text-xs text-muted-foreground">Subject</div>
                <div className="text-sm">{detail.call.subject}</div>
              </div>
            )}
            {detail.call.page_url && (
              <div>
                <div className="text-xs text-muted-foreground">Page context</div>
                <div className="text-sm flex items-center gap-1.5"><Globe className="h-3.5 w-3.5" /> {detail.call.page_title || detail.call.page_url}</div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div><div className="text-xs text-muted-foreground">Type</div>{detail.call.call_type}</div>
              <div><div className="text-xs text-muted-foreground">State</div>{detail.call.state}</div>
              <div><div className="text-xs text-muted-foreground">Provider</div>{detail.call.provider || '—'}</div>
              <div><div className="text-xs text-muted-foreground">Source</div>Call Widget</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Timeline</div>
              <ol className="space-y-1 text-xs max-h-40 overflow-y-auto">
                {detail.events.map((e) => (
                  <li key={e.id} className="flex gap-2">
                    <span className="text-muted-foreground shrink-0">{new Date(e.created_at).toLocaleTimeString()}</span>
                    <span>{e.event_type}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
