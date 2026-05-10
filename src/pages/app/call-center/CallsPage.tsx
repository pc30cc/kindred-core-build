import { useState } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterCalls, useCallCenterCall } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { callCenterApi } from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';

const STATUS = ['all', 'pending', 'ringing', 'active', 'ended', 'cancelled', 'missed', 'failed'];

export default function CallsPage() {
  const { workspace } = useActiveWorkspace();
  const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const qc = useQueryClient();
  const { data } = useCallCenterCalls(workspace?.id, { status: status === 'all' ? undefined : status });
  const { data: detail } = useCallCenterCall(workspace?.id, selected);

  async function endCall(id: string) {
    if (!workspace) return;
    await callCenterApi.endCall(workspace.id, id);
    qc.invalidateQueries({ queryKey: ['call-center'] });
  }

  return (
    <div className="space-y-4">
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          {STATUS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
        </SelectContent>
      </Select>
      <Card className="divide-y">
        {(data?.calls || []).map((c) => (
          <button key={c.id} onClick={() => setSelected(c.id)} className="w-full text-start p-3 hover:bg-muted/50 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{c.visitor_name || c.visitor_email || c.visitor_phone || 'Anonymous'}</div>
              <div className="text-xs text-muted-foreground">{new Date(c.created_at).toLocaleString()} · {c.call_type}</div>
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full bg-muted">{c.state}</span>
          </button>
        ))}
        {(!data || data.calls.length === 0) && <div className="p-8 text-center text-sm text-muted-foreground">No calls.</div>}
      </Card>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto">
          <SheetHeader><SheetTitle>Call detail</SheetTitle></SheetHeader>
          {detail && (
            <div className="space-y-4 mt-4">
              <div className="text-sm space-y-1">
                <div><span className="text-muted-foreground">Visitor:</span> {detail.call.visitor_name || detail.call.visitor_email || '—'}</div>
                <div><span className="text-muted-foreground">State:</span> {detail.call.state}</div>
                <div><span className="text-muted-foreground">Type:</span> {detail.call.call_type}</div>
                <div><span className="text-muted-foreground">Subject:</span> {detail.call.subject || '—'}</div>
                <div><span className="text-muted-foreground">Page:</span> {detail.call.page_url || '—'}</div>
                <div><span className="text-muted-foreground">Duration:</span> {detail.call.duration_seconds ?? '—'}s</div>
                <div><span className="text-muted-foreground">End reason:</span> {detail.call.end_reason || '—'}</div>
              </div>
              {['active', 'ringing', 'connecting'].includes(detail.call.state) && (
                <Button variant="destructive" size="sm" onClick={() => endCall(detail.call.id)}>End call</Button>
              )}
              <div>
                <h3 className="text-sm font-medium mb-2">Timeline</h3>
                <ol className="space-y-2 text-xs">
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
        </SheetContent>
      </Sheet>
    </div>
  );
}
