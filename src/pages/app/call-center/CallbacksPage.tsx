import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterCallbacks } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { callCenterApi, type CallbackRequest } from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useMemo, useState } from 'react';
import {
  PhoneCall, Mail, Globe, Clock, Search, Video, Phone, User2,
  CheckCircle2, XCircle, UserPlus, Flame, CalendarClock, RefreshCw, Copy, MessageSquare,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';

type StatusKey = 'requested' | 'in_progress' | 'scheduled' | 'completed' | 'cancelled';

const TAB_DEFS: Array<{ key: StatusKey | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'requested', label: 'Pending' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];

function relativeTime(iso?: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    requested: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/20',
    in_progress: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/20',
    scheduled: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/20',
    completed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/20',
    cancelled: 'bg-muted text-muted-foreground border-border',
  };
  return (
    <span className={cn('text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase tracking-wide', map[status])}>
      {status.replace('_', ' ')}
    </span>
  );
}

function KpiCard({ label, value, accent, icon: Icon }: { label: string; value: number | string; accent: string; icon: any }) {
  return (
    <Card className="p-3.5 flex items-center gap-3">
      <div className={cn('h-10 w-10 rounded-lg flex items-center justify-center', accent)}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
        <div className="text-xl font-bold tabular-nums leading-tight">{value}</div>
      </div>
    </Card>
  );
}

function CallbackRow({ c, onAction }: { c: CallbackRequest; onAction: (id: string, fn: 'assignCallback' | 'completeCallback' | 'cancelCallback') => void }) {
  const meta = (c.metadata || {}) as Record<string, any>;
  const name: string = meta.name || c.contact_email || c.contact_phone || 'Anonymous visitor';
  const subject: string = meta.subject || '—';
  const message: string = meta.message || c.notes || '';
  const pageUrl: string | undefined = meta.page_url;
  const urgency: string = meta.urgency || 'normal';
  const isUrgent = urgency === 'urgent';
  const isVideo = c.channel === 'video';
  const requested = c.requested_at || c.created_at;
  const ref = c.id.slice(0, 8).toUpperCase();
  const isOpen = c.status === 'requested' || c.status === 'in_progress' || c.status === 'scheduled';

  function copyRef() {
    navigator.clipboard.writeText(ref);
    toast({ title: 'Reference copied', description: ref });
  }

  return (
    <Card className={cn(
      'p-0 overflow-hidden transition hover:shadow-md',
      isUrgent && isOpen && 'ring-1 ring-red-500/40',
    )}>
      {isUrgent && isOpen && (
        <div className="bg-red-500/10 text-red-700 dark:text-red-300 px-4 py-1.5 text-xs font-semibold flex items-center gap-1.5 border-b border-red-500/20">
          <Flame className="h-3.5 w-3.5" /> Urgent — handle ASAP
        </div>
      )}
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className={cn(
            'h-11 w-11 rounded-xl flex items-center justify-center shrink-0 shadow-sm',
            isVideo ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400' : 'bg-primary/10 text-primary',
          )}>
            {isVideo ? <Video className="h-5 w-5" /> : <Phone className="h-5 w-5" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold truncate">{name}</span>
              <StatusPill status={c.status} />
              <Badge variant="outline" className="text-[10px] font-mono cursor-pointer hover:bg-muted" onClick={copyRef}>
                #{ref} <Copy className="h-2.5 w-2.5 ms-1" />
              </Badge>
            </div>
            {subject !== '—' && (
              <div className="text-sm text-foreground/80 mt-0.5 truncate">{subject}</div>
            )}
            {message && (
              <div className="text-xs text-muted-foreground mt-1 line-clamp-2 flex gap-1.5">
                <MessageSquare className="h-3 w-3 shrink-0 mt-0.5" />
                <span>{message}</span>
              </div>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground mt-2">
              {c.contact_phone && (
                <a href={`tel:${c.contact_phone}`} className="inline-flex items-center gap-1 hover:text-primary">
                  <PhoneCall className="h-3 w-3" />{c.contact_phone}
                </a>
              )}
              {c.contact_email && (
                <a href={`mailto:${c.contact_email}`} className="inline-flex items-center gap-1 hover:text-primary">
                  <Mail className="h-3 w-3" />{c.contact_email}
                </a>
              )}
              {pageUrl && (
                <a href={pageUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-primary truncate max-w-[220px]">
                  <Globe className="h-3 w-3" /><span className="truncate">{new URL(pageUrl).hostname}</span>
                </a>
              )}
              <span className="inline-flex items-center gap-1" title={new Date(requested).toLocaleString()}>
                <Clock className="h-3 w-3" />{relativeTime(requested)}
              </span>
              {c.scheduled_for && (
                <span className="inline-flex items-center gap-1 text-violet-600 dark:text-violet-400">
                  <CalendarClock className="h-3 w-3" />{new Date(c.scheduled_for).toLocaleString()}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mt-3 justify-end">
          {c.contact_phone && isOpen && (
            <Button size="sm" variant="outline" asChild>
              <a href={`tel:${c.contact_phone}`}><PhoneCall className="h-3.5 w-3.5 me-1" />Dial</a>
            </Button>
          )}
          {c.contact_email && isOpen && (
            <Button size="sm" variant="outline" asChild>
              <a href={`mailto:${c.contact_email}`}><Mail className="h-3.5 w-3.5 me-1" />Email</a>
            </Button>
          )}
          {c.status === 'requested' && (
            <Button size="sm" variant="secondary" onClick={() => onAction(c.id, 'assignCallback')}>
              <UserPlus className="h-3.5 w-3.5 me-1" />Assign me
            </Button>
          )}
          {isOpen && (
            <Button size="sm" onClick={() => onAction(c.id, 'completeCallback')}>
              <CheckCircle2 className="h-3.5 w-3.5 me-1" />Complete
            </Button>
          )}
          {isOpen && (
            <Button size="sm" variant="ghost" onClick={() => onAction(c.id, 'cancelCallback')}>
              <XCircle className="h-3.5 w-3.5 me-1" />Cancel
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function CallbacksPage() {
  const { workspace } = useActiveWorkspace();
  const { data, isFetching, refetch, dataUpdatedAt } = useCallCenterCallbacks(workspace?.id);
  const qc = useQueryClient();
  const [tab, setTab] = useState<string>('requested');
  const [q, setQ] = useState('');

  async function act(id: string, fn: 'assignCallback' | 'completeCallback' | 'cancelCallback') {
    if (!workspace) return;
    try {
      await callCenterApi[fn](workspace.id, id);
      qc.invalidateQueries({ queryKey: ['call-center', 'callbacks'] });
      const label = fn === 'assignCallback' ? 'assigned to you' : fn === 'completeCallback' ? 'completed' : 'cancelled';
      toast({ title: `Callback ${label}` });
    } catch (e: any) {
      toast({ title: 'Action failed', description: e?.message || 'Try again.', variant: 'destructive' });
    }
  }

  const items: CallbackRequest[] = data?.callbacks || [];

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: items.length };
    for (const c of items) m[c.status] = (m[c.status] || 0) + 1;
    return m;
  }, [items]);

  const today = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return items.filter((c) => new Date(c.created_at).getTime() >= start.getTime()).length;
  }, [items]);

  const urgent = useMemo(
    () => items.filter((c) => (c.metadata as any)?.urgency === 'urgent' && (c.status === 'requested' || c.status === 'in_progress')).length,
    [items],
  );

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return items.filter((c) => {
      if (tab !== 'all' && c.status !== tab) return false;
      if (!term) return true;
      const meta = (c.metadata || {}) as any;
      const hay = `${meta.name || ''} ${meta.subject || ''} ${c.notes || ''} ${c.contact_email || ''} ${c.contact_phone || ''}`.toLowerCase();
      return hay.includes(term);
    });
  }, [items, tab, q]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Callbacks</h1>
          <p className="text-sm text-muted-foreground">Manage every visitor who asked to be called back.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Updated {relativeTime(new Date(dataUpdatedAt).toISOString())}
          </span>
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('h-3.5 w-3.5 me-1', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <KpiCard label="Pending" value={counts.requested || 0} icon={PhoneCall} accent="bg-amber-500/15 text-amber-600" />
        <KpiCard label="In progress" value={counts.in_progress || 0} icon={User2} accent="bg-blue-500/15 text-blue-600" />
        <KpiCard label="Scheduled" value={counts.scheduled || 0} icon={CalendarClock} accent="bg-violet-500/15 text-violet-600" />
        <KpiCard label="Urgent open" value={urgent} icon={Flame} accent="bg-red-500/15 text-red-600" />
        <KpiCard label="Today" value={today} icon={Clock} accent="bg-primary/15 text-primary" />
        <KpiCard label="Completed" value={counts.completed || 0} icon={CheckCircle2} accent="bg-emerald-500/15 text-emerald-600" />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, phone, subject…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList className="bg-muted/50 flex-wrap h-auto">
          {TAB_DEFS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
              {counts[t.key] ? (
                <span className="ms-1.5 text-[10px] bg-background rounded px-1.5 py-0.5 font-semibold">
                  {counts[t.key]}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        {TAB_DEFS.map((t) => (
          <TabsContent key={t.key} value={t.key} className="space-y-2.5 mt-0">
            {filtered.length === 0 ? (
              <Card className="p-12 text-center space-y-2 border-dashed">
                <PhoneCall className="h-8 w-8 mx-auto text-muted-foreground/60" />
                <p className="text-sm text-muted-foreground">No {t.label.toLowerCase()} callbacks.</p>
              </Card>
            ) : (
              filtered.map((c) => <CallbackRow key={c.id} c={c} onAction={act} />)
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
