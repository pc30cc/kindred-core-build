import { useMemo, useState } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterCalls, useCallCenterCall } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { callCenterApi } from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';
import { Phone, Video, Search, Copy } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

const STATUS = ['all', 'pending', 'ringing', 'active', 'ended', 'cancelled', 'missed', 'failed'];
const TYPES = ['all', 'audio', 'video'];

function fmtDuration(s?: number | null) {
  if (!s && s !== 0) return '—';
  const m = Math.floor(s / 60); const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
function stateTone(s: string) {
  if (['active', 'ringing', 'connecting'].includes(s)) return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  if (['ended'].includes(s)) return 'bg-muted text-muted-foreground';
  if (['missed', 'failed'].includes(s)) return 'bg-destructive/15 text-destructive';
  if (['cancelled'].includes(s)) return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  return 'bg-muted text-muted-foreground';
}

export default function CallsPage() {
  const { workspace } = useActiveWorkspace();
  const [status, setStatus] = useState('all');
  const [type, setType] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const qc = useQueryClient();
  const { data } = useCallCenterCalls(workspace?.id, { status: status === 'all' ? undefined : status });
  const { data: detail } = useCallCenterCall(workspace?.id, selected);

  async function endCall(id: string) {
    if (!workspace) return;
    await callCenterApi.endCall(workspace.id, id);
    qc.invalidateQueries({ queryKey: ['call-center'] });
  }

  const allCalls = data?.calls || [];
  const filtered = useMemo(() => allCalls.filter((c) => {
    if (type !== 'all' && c.call_type !== type) return false;
    if (search) {
      const s = search.toLowerCase();
      if (!(c.visitor_name || '').toLowerCase().includes(s) &&
          !(c.visitor_email || '').toLowerCase().includes(s) &&
          !(c.visitor_phone || '').toLowerCase().includes(s)) return false;
    }
    return true;
  }), [allCalls, type, search]);

  const summary = useMemo(() => {
    let answered = 0, missed = 0, rejected = 0, totalDur = 0, durCount = 0;
    for (const c of filtered) {
      if (c.state === 'ended') answered++;
      else if (c.state === 'missed') missed++;
      else if (c.state === 'cancelled') rejected++;
      if (c.duration_seconds) { totalDur += c.duration_seconds; durCount++; }
    }
    return { answered, missed, rejected, avg: durCount ? Math.round(totalDur / durCount) : null };
  }, [filtered]);

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs text-muted-foreground me-1">Status:</div>
          {STATUS.map((s) => (
            <Button key={s} size="sm" variant={status === s ? 'default' : 'outline'} className="h-7 text-xs capitalize" onClick={() => setStatus(s)}>{s}</Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs text-muted-foreground me-1">Type:</div>
          {TYPES.map((s) => (
            <Button key={s} size="sm" variant={type === s ? 'default' : 'outline'} className="h-7 text-xs capitalize" onClick={() => setType(s)}>{s}</Button>
          ))}
          <div className="relative flex-1 min-w-[200px] ms-auto max-w-sm">
            <Search className="h-3.5 w-3.5 absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="ps-8 h-8 text-sm" placeholder="Visitor, email, phone…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3"><div className="text-xs text-muted-foreground">Answered</div><div className="text-xl font-semibold">{summary.answered}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Missed</div><div className="text-xl font-semibold text-destructive">{summary.missed}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Rejected/Cancelled</div><div className="text-xl font-semibold">{summary.rejected}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Avg duration</div><div className="text-xl font-semibold">{summary.avg != null ? fmtDuration(summary.avg) : '—'}</div></Card>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b">
              <th className="text-start py-2 px-3">Visitor</th>
              <th className="text-start py-2 px-3">Type</th>
              <th className="text-start py-2 px-3">State</th>
              <th className="text-start py-2 px-3">Duration</th>
              <th className="text-start py-2 px-3">Page</th>
              <th className="text-start py-2 px-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const display = c.visitor_name || c.visitor_email || c.visitor_phone || 'Anonymous';
              const initials = display.slice(0, 1).toUpperCase();
              return (
              <tr key={c.id} onClick={() => setSelected(c.id)} className="border-b cursor-pointer hover:bg-muted/40">
                <td className="py-2 px-3">
                  <div className="flex items-center gap-2">
                    <div className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">{initials}</div>
                    <span className="font-medium">{display}</span>
                  </div>
                </td>
                <td className="py-2 px-3">
                  <span className="inline-flex items-center gap-1 text-xs">
                    {c.call_type === 'video' ? <Video className="h-3 w-3" /> : <Phone className="h-3 w-3" />}
                    {c.call_type}
                  </span>
                </td>
                <td className="py-2 px-3"><span className={cn('text-xs px-2 py-0.5 rounded-full', stateTone(c.state))}>{c.state}</span></td>
                <td className="py-2 px-3">{fmtDuration(c.duration_seconds)}</td>
                <td className="py-2 px-3 text-xs text-muted-foreground truncate max-w-[200px]">{c.page_title || c.page_url || '—'}</td>
                <td className="py-2 px-3 text-xs text-muted-foreground">{new Date(c.created_at).toLocaleString()}</td>
              </tr>
              );
            })}
            {filtered.length === 0 && (<tr><td colSpan={6} className="py-8 text-center text-sm text-muted-foreground">No calls match your filters.</td></tr>)}
          </tbody>
        </table>
      </Card>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto">
          <SheetHeader><SheetTitle>Call detail</SheetTitle></SheetHeader>
          {detail && (
            <div className="space-y-4 mt-4">
              <div className="space-y-2">
                <div className="text-sm font-semibold">{detail.call.visitor_name || detail.call.visitor_email || 'Anonymous'}</div>
                <div className="flex flex-wrap gap-2">
                  <span className={cn('text-xs px-2 py-0.5 rounded-full', stateTone(detail.call.state))}>{detail.call.state}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-muted">{detail.call.call_type}</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><div className="text-xs text-muted-foreground">Subject</div>{detail.call.subject || '—'}</div>
                <div><div className="text-xs text-muted-foreground">Duration</div>{fmtDuration(detail.call.duration_seconds)}</div>
                <div><div className="text-xs text-muted-foreground">Provider</div>{detail.call.provider || '—'}</div>
                <div><div className="text-xs text-muted-foreground">End reason</div>{detail.call.end_reason || '—'}</div>
              </div>
              {detail.call.page_url && (
                <div className="text-sm"><div className="text-xs text-muted-foreground">Page</div><a href={detail.call.page_url} target="_blank" rel="noreferrer" className="underline truncate block">{detail.call.page_title || detail.call.page_url}</a></div>
              )}
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(detail.call.id); toast({ title: 'Call ID copied' }); }}>
                  <Copy className="h-3.5 w-3.5 me-1" /> Copy ID
                </Button>
                {['active', 'ringing', 'connecting'].includes(detail.call.state) && (
                  <Button variant="destructive" size="sm" onClick={() => endCall(detail.call.id)}>End call</Button>
                )}
              </div>
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
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Debug metadata</summary>
                <pre className="mt-2 bg-muted p-2 rounded overflow-x-auto">{JSON.stringify(detail.call, null, 2)}</pre>
              </details>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
