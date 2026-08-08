import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useCallCenterCallbacks } from '@/hooks/useCallCenter';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { callCenterApi, type CallbackRequest } from '@/lib/call-center-api';
import { useQueryClient } from '@tanstack/react-query';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  PhoneCall, Mail, Globe, Clock, Search, Video, Phone, User2,
  CheckCircle2, XCircle, UserPlus, Flame, CalendarClock, RefreshCw, Copy, MessageSquare,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { useTranslation } from '@/i18n';
import { useVisitorNetworkBatchBySession, type VisitorNetworkProfile } from '@/hooks/useVisitorNetwork';
import { useGeoEnrichmentRealtime } from '@/hooks/useGeoEnrichmentRealtime';
import { VisitorNetworkInline } from '@/features/visitors/VisitorNetworkCard';

type StatusKey = 'requested' | 'in_progress' | 'scheduled' | 'completed' | 'cancelled';

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

function CallbackRow({
  c,
  onAction,
  onComplete,
  highlight,
  rowRef,
  profile,
}: {
  c: CallbackRequest;
  onAction: (id: string, fn: 'assignCallback' | 'cancelCallback') => void;
  onComplete: (c: CallbackRequest) => void;
  highlight?: boolean;
  rowRef?: (el: HTMLDivElement | null) => void;
  /** Pre-fetched by the page in ONE batched request — never fetched per row. */
  profile?: VisitorNetworkProfile | null;
}) {
  const { t } = useTranslation();
  const meta = (c.metadata || {}) as Record<string, any>;
  const name: string = meta.name || c.contact_email || c.contact_phone || t('callCenter.common.anonymousVisitor');
  const subject: string = meta.subject || '—';
  const message: string = meta.message || c.notes || '';
  const pageUrl: string | undefined = meta.page_url;
  const urgency: string = meta.urgency || 'normal';
  const isUrgent = urgency === 'urgent';
  const isVideo = c.channel === 'video';
  const requested = c.requested_at || c.created_at;
  const ref = c.id.slice(0, 8).toUpperCase();
  const isOpen = c.status === 'requested' || c.status === 'in_progress' || c.status === 'scheduled';
  const resolutionNote: string | undefined = meta.resolution_note;

  function copyRef() {
    navigator.clipboard.writeText(ref);
    toast({ title: t('callCenter.callbacks.referenceCopied'), description: ref });
  }
  function copyText(value: string, label: 'phone' | 'email') {
    navigator.clipboard.writeText(value);
    toast({
      title: label === 'phone' ? t('callCenter.callbacks.phoneCopied') : t('callCenter.callbacks.emailCopied'),
      description: value,
    });
  }

  return (
    <div ref={rowRef as any} className="scroll-mt-24">
    <Card className={cn(
      'p-0 overflow-hidden transition hover:shadow-md',
      isUrgent && isOpen && 'ring-1 ring-red-500/40',
      highlight && 'ring-2 ring-primary shadow-lg animate-pulse-once',
    )}>
      {isUrgent && isOpen && (
        <div className="bg-red-500/10 text-red-700 dark:text-red-300 px-4 py-1.5 text-xs font-semibold flex items-center gap-1.5 border-b border-red-500/20">
          <Flame className="h-3.5 w-3.5" /> {t('callCenter.callbacks.urgentHandle')}
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
            {/* Highly legible contact strip */}
            <div className="flex flex-wrap gap-2 mt-3">
              {c.contact_phone && (
                <div className="inline-flex items-center gap-1.5 bg-muted/60 hover:bg-muted rounded-md px-2.5 py-1.5 border">
                  <PhoneCall className="h-3.5 w-3.5 text-primary shrink-0" />
                  <a href={`tel:${c.contact_phone}`} dir="ltr" className="text-sm font-semibold tracking-wide text-foreground tabular-nums hover:text-primary">
                    {c.contact_phone}
                  </a>
                  <button
                    type="button"
                    onClick={() => copyText(c.contact_phone!, 'phone')}
                    className="text-muted-foreground hover:text-foreground transition"
                    title={t('callCenter.callbacks.copyPhone')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {c.contact_email && (
                <div className="inline-flex items-center gap-1.5 bg-muted/60 hover:bg-muted rounded-md px-2.5 py-1.5 border">
                  <Mail className="h-3.5 w-3.5 text-primary shrink-0" />
                  <a href={`mailto:${c.contact_email}`} dir="ltr" className="text-sm font-semibold text-foreground hover:text-primary break-all">
                    {c.contact_email}
                  </a>
                  <button
                    type="button"
                    onClick={() => copyText(c.contact_email!, 'email')}
                    className="text-muted-foreground hover:text-foreground transition"
                    title={t('callCenter.callbacks.copyEmail')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground mt-2">
              {pageUrl && (
                <a href={pageUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-primary truncate max-w-[220px]">
                  <Globe className="h-3 w-3" /><span className="truncate">{new URL(pageUrl).hostname}</span>
                </a>
              )}
              <span className="inline-flex items-center gap-1" title={new Date(requested).toLocaleString()}>
                <Clock className="h-3 w-3" />{relativeTime(requested)}
              </span>
              <VisitorNetworkInline profile={profile} t={(k: string) => t(k as Parameters<typeof t>[0])} />
              {c.scheduled_for && (
                <span className="inline-flex items-center gap-1 text-violet-600 dark:text-violet-400">
                  <CalendarClock className="h-3 w-3" />{new Date(c.scheduled_for).toLocaleString()}
                </span>
              )}
            </div>
            {c.status === 'completed' && resolutionNote && (
              <div className="mt-3 rounded-md border bg-emerald-500/5 border-emerald-500/20 p-2.5 text-xs">
                <div className="text-[10px] uppercase tracking-wide font-semibold text-emerald-700 dark:text-emerald-400 mb-1 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> {t('callCenter.callbacks.resolutionNote')}
                </div>
                <div className="text-foreground/90 whitespace-pre-wrap">{resolutionNote}</div>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mt-3 justify-end">
          {c.contact_phone && isOpen && (
            <Button size="sm" variant="outline" asChild>
              <a href={`tel:${c.contact_phone}`}><PhoneCall className="h-3.5 w-3.5 me-1" />{t('callCenter.callbacks.dial')}</a>
            </Button>
          )}
          {c.contact_email && isOpen && (
            <Button size="sm" variant="outline" asChild>
              <a href={`mailto:${c.contact_email}`}><Mail className="h-3.5 w-3.5 me-1" />{t('callCenter.callbacks.emailBtn')}</a>
            </Button>
          )}
          {c.status === 'requested' && (
            <Button size="sm" variant="secondary" onClick={() => onAction(c.id, 'assignCallback')}>
              <UserPlus className="h-3.5 w-3.5 me-1" />{t('callCenter.callbacks.assignMe')}
            </Button>
          )}
          {isOpen && (
            <Button size="sm" onClick={() => onComplete(c)}>
              <CheckCircle2 className="h-3.5 w-3.5 me-1" />{t('callCenter.callbacks.complete')}
            </Button>
          )}
          {isOpen && (
            <Button size="sm" variant="ghost" onClick={() => onAction(c.id, 'cancelCallback')}>
              <XCircle className="h-3.5 w-3.5 me-1" />{t('callCenter.callbacks.cancel')}
            </Button>
          )}
        </div>
      </div>
    </Card>
    </div>
  );
}

export default function CallbacksPage() {
  const { t } = useTranslation();
  const TAB_DEFS: Array<{ key: StatusKey | 'all'; label: string }> = [
    { key: 'all', label: t('callCenter.callbacks.tabs.all') },
    { key: 'requested', label: t('callCenter.callbacks.tabs.pending') },
    { key: 'in_progress', label: t('callCenter.callbacks.tabs.inProgress') },
    { key: 'scheduled', label: t('callCenter.callbacks.tabs.scheduled') },
    { key: 'completed', label: t('callCenter.callbacks.tabs.completed') },
    { key: 'cancelled', label: t('callCenter.callbacks.tabs.cancelled') },
  ];
  const { workspace } = useActiveWorkspace();
  const { data, isFetching, refetch, dataUpdatedAt } = useCallCenterCallbacks(workspace?.id);
  const qc = useQueryClient();
  const [tab, setTab] = useState<string>('requested');
  const [q, setQ] = useState('');
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get('focus');
  const [completeTarget, setCompleteTarget] = useState<CallbackRequest | null>(null);
  const [completeNote, setCompleteNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  async function act(id: string, fn: 'assignCallback' | 'cancelCallback') {
    if (!workspace) return;
    try {
      await callCenterApi[fn](workspace.id, id);
      qc.invalidateQueries({ queryKey: ['call-center', 'callbacks'] });
      toast({ title: fn === 'assignCallback' ? t('callCenter.callbacks.callbackAssigned') : t('callCenter.callbacks.callbackCancelled') });
    } catch (e: any) {
      toast({ title: t('callCenter.callbacks.actionFailed'), description: e?.message || t('callCenter.callbacks.tryAgain'), variant: 'destructive' });
    }
  }

  async function submitComplete() {
    if (!workspace || !completeTarget) return;
    setSubmitting(true);
    try {
      await callCenterApi.completeCallback(workspace.id, completeTarget.id, completeNote.trim() || undefined);
      qc.invalidateQueries({ queryKey: ['call-center', 'callbacks'] });
      toast({ title: t('callCenter.callbacks.callbackCompleted') });
      setCompleteTarget(null);
      setCompleteNote('');
    } catch (e: any) {
      toast({ title: t('callCenter.callbacks.actionFailed'), description: e?.message || t('callCenter.callbacks.tryAgain'), variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  }

  const items: CallbackRequest[] = data?.callbacks || [];

  // Canonical Geo/IP for the whole page in ONE request (phase-2 batch
  // endpoint, reused as-is). Callbacks carry the visitor session that
  // produced them, so they resolve the exact same profile the Inbox and the
  // Call Center show for that visitor.
  const callbackSessionIds = useMemo(
    () => items.map((c) => c.visitor_session_id ?? null),
    [items],
  );
  const { data: networkBySession } = useVisitorNetworkBatchBySession(workspace?.id, callbackSessionIds);
  // Refresh IP/geo once async enrichment lands (reuses the visitors channel).
  useGeoEnrichmentRealtime(workspace?.id);

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

  // When a focus id is set (from Overview deep link), switch to "All" tab
  // and scroll to the target row.
  useEffect(() => {
    if (!focusId || items.length === 0) return;
    const target = items.find((c) => c.id === focusId);
    if (!target) return;
    if (tab !== 'all' && target.status !== tab) setTab('all');
    const t = setTimeout(() => {
      const el = rowRefs.current[focusId];
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, items.length]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('callCenter.callbacks.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('callCenter.callbacks.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t('callCenter.callbacks.updatedPrefix')} {relativeTime(new Date(dataUpdatedAt).toISOString())}
          </span>
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('h-3.5 w-3.5 me-1', isFetching && 'animate-spin')} />
            {t('callCenter.common.refresh')}
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <KpiCard label={t('callCenter.callbacks.kpi.pending')} value={counts.requested || 0} icon={PhoneCall} accent="bg-amber-500/15 text-amber-600" />
        <KpiCard label={t('callCenter.callbacks.kpi.inProgress')} value={counts.in_progress || 0} icon={User2} accent="bg-blue-500/15 text-blue-600" />
        <KpiCard label={t('callCenter.callbacks.kpi.scheduled')} value={counts.scheduled || 0} icon={CalendarClock} accent="bg-violet-500/15 text-violet-600" />
        <KpiCard label={t('callCenter.callbacks.kpi.urgentOpen')} value={urgent} icon={Flame} accent="bg-red-500/15 text-red-600" />
        <KpiCard label={t('callCenter.callbacks.kpi.today')} value={today} icon={Clock} accent="bg-primary/15 text-primary" />
        <KpiCard label={t('callCenter.callbacks.kpi.completed')} value={counts.completed || 0} icon={CheckCircle2} accent="bg-emerald-500/15 text-emerald-600" />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('callCenter.callbacks.searchPlaceholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList className="bg-muted/50 flex-wrap h-auto">
          {TAB_DEFS.map((tab2) => (
            <TabsTrigger key={tab2.key} value={tab2.key}>
              {tab2.label}
              {counts[tab2.key] ? (
                <span className="ms-1.5 text-[10px] bg-background rounded px-1.5 py-0.5 font-semibold">
                  {counts[tab2.key]}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        {TAB_DEFS.map((tab2) => (
          <TabsContent key={tab2.key} value={tab2.key} className="space-y-2.5 mt-0">
            {filtered.length === 0 ? (
              <Card className="p-12 text-center space-y-2 border-dashed">
                <PhoneCall className="h-8 w-8 mx-auto text-muted-foreground/60" />
                <p className="text-sm text-muted-foreground">{t('callCenter.callbacks.noTabResults', { tab: (TAB_DEFS.find(x => x.key === tab)?.label || '').toLowerCase() })}</p>
              </Card>
            ) : (
              filtered.map((c) => (
                <CallbackRow
                  key={c.id}
                  c={c}
                  onAction={act}
                  onComplete={(cb) => { setCompleteTarget(cb); setCompleteNote(''); }}
                  highlight={focusId === c.id}
                  rowRef={(el) => { rowRefs.current[c.id] = el; }}
                  profile={networkBySession?.[c.visitor_session_id ?? ''] ?? null}
                />
              ))
            )}
          </TabsContent>
        ))}
      </Tabs>

      <Dialog
        open={!!completeTarget}
        onOpenChange={(open) => {
          if (!open) { setCompleteTarget(null); setCompleteNote(''); }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              {t('callCenter.callbacks.completeTitle')}
            </DialogTitle>
            <DialogDescription>
              {completeTarget ? (
                <>{t('callCenter.callbacks.completeDescPrefix')} <span className="font-medium text-foreground">
                  {(completeTarget.metadata as any)?.name || completeTarget.contact_phone || completeTarget.contact_email || t('callCenter.callbacks.thisVisitor')}
                </span> {t('callCenter.callbacks.completeDescSuffix')}</>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('callCenter.callbacks.resolutionOptional')}
            </label>
            <Textarea
              value={completeNote}
              onChange={(e) => setCompleteNote(e.target.value)}
              placeholder={t('callCenter.callbacks.resolutionPlaceholder')}
              rows={5}
              maxLength={2000}
            />
            <div className="text-[11px] text-muted-foreground text-end">{completeNote.length}/2000</div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => { setCompleteTarget(null); setCompleteNote(''); }}
              disabled={submitting}
            >
              {t('callCenter.common.cancel')}
            </Button>
            <Button onClick={submitComplete} disabled={submitting}>
              <CheckCircle2 className="h-4 w-4 me-1" />
              {submitting ? t('callCenter.common.saving') : t('callCenter.callbacks.markCompleted')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
