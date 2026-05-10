import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterQueue } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { callCenterApi } from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from '@/hooks/use-toast';
import { Phone, Video, Globe } from 'lucide-react';

function waitTime(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export default function LiveQueuePage() {
  const { workspace } = useActiveWorkspace();
  const { data, isLoading } = useCallCenterQueue(workspace?.id);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

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

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const queue = data?.queue || [];
  if (queue.length === 0) return <Card className="p-8 text-center text-sm text-muted-foreground">No calls in queue.</Card>;

  return (
    <div className="space-y-3">
      {queue.map((q) => {
        const c = q.call_session;
        return (
          <Card key={q.id} className="p-4 flex items-center gap-4">
            <div className="rounded-lg bg-primary/10 text-primary p-2">
              {q.channel === 'video' ? <Video className="h-5 w-5" /> : <Phone className="h-5 w-5" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">
                {c?.visitor_name || c?.visitor_email || c?.visitor_phone || 'Anonymous visitor'}
              </div>
              <div className="text-xs text-muted-foreground truncate flex items-center gap-2">
                <span className="capitalize">{q.channel}</span> · waiting {waitTime(q.created_at)}
                {c?.subject && <> · {c.subject}</>}
              </div>
              {c?.page_url && (
                <div className="text-[11px] text-muted-foreground flex items-center gap-1 mt-1 truncate">
                  <Globe className="h-3 w-3" /> {c.page_title || c.page_url}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => reject(q.call_session_id)} disabled={busy === q.call_session_id}>Reject</Button>
              <Button size="sm" onClick={() => accept(q.call_session_id)} disabled={busy === q.call_session_id}>Accept</Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
