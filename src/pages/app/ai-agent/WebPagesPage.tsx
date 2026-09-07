import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi, type DataSource, type SourceSyncLog } from '@/lib/ai-agent-api';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { Globe, Plus, RefreshCw, Trash2, Loader2, AlertCircle, Info, ChevronDown, ChevronRight } from 'lucide-react';

export default function WebPagesPage() {
  const { t, dir } = useTranslation();
  const ws = useCurrentWorkspace() as any;
  const wsId = ws?.id as string | undefined;
  const [items, setItems] = useState<DataSource[]>([]);
  const [domains, setDomains] = useState<Array<{ domain: string; is_primary: boolean; verified: boolean }>>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, SourceSyncLog[]>>({});
  const [limits, setLimits] = useState<{ planName: string | null; planSlug: string | null; limits: { ai_kb_max_pages: number; ai_kb_max_depth: number; ai_kb_jobs_per_month: number }; jobs_used_this_month: number; bypass?: boolean; bypassReason?: string | null; worker?: { inProcess: boolean; started: boolean } } | null>(null);
  const [latestJobs, setLatestJobs] = useState<Record<string, { status: string; last_error: string | null } | null>>({});

  async function refresh() {
    if (!wsId) return;
    setLoading(true);
    try {
      const [srcs, dom, lim] = await Promise.all([
        aiAgentApi.listDataSources(wsId, 'website'),
        aiAgentApi.getWorkspaceDomains(wsId),
        aiAgentApi.getDataSourceLimits(wsId).catch(() => null),
      ]);
      setItems(srcs.items || []);
      setDomains(dom.domains || []);
      setLimits(lim as any);
      // Fetch latest job per source (for retry affordance).
      const sources = srcs.items || [];
      const jobs = await Promise.all(sources.map(async (s) => {
        try {
          const r = await aiAgentApi.getDataSourceJobs(s.id);
          return [s.id, r.items?.[0] ? { status: r.items[0].status, last_error: r.items[0].last_error } : null] as const;
        } catch { return [s.id, null] as const; }
      }));
      setLatestJobs(Object.fromEntries(jobs));
    } catch (e: any) {
      toast({ title: t('aiAgent.webPages.loadFailed'), description: e?.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [wsId]);

  async function expand(id: string) {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (!logs[id]) {
      try {
        const r = await aiAgentApi.getDataSourceLogs(id);
        setLogs((l) => ({ ...l, [id]: r.items || [] }));
      } catch { /* swallow */ }
    }
  }

  async function sync(s: DataSource) {
    try {
      const r = await aiAgentApi.syncDataSource(s.id);
      toast({ title: r.bypass ? t('aiAgent.webPages.syncQueuedBypass') : t('aiAgent.webPages.syncQueued') });
      refresh();
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (msg.includes('plan_limit_reached')) {
        toast({ title: t('aiAgent.webPages.planLimitReached'), description: t('aiAgent.webPages.planLimitReachedDesc'), variant: 'destructive' });
      } else {
        toast({ title: t('aiAgent.webPages.syncFailed'), description: msg, variant: 'destructive' });
      }
    }
  }
  async function retry(s: DataSource) {
    try {
      const r = await aiAgentApi.retryFailedSourceJob(s.id);
      toast({ title: r.reused ? t('aiAgent.webPages.existingJobQueued') : t('aiAgent.webPages.retryQueued') });
      refresh();
    } catch (e: any) {
      toast({ title: t('aiAgent.webPages.retryFailed'), description: e?.message, variant: 'destructive' });
    }
  }
  async function remove(s: DataSource) {
    if (!confirm(t('aiAgent.webPages.deleteConfirm', { name: s.name }))) return;
    try { await aiAgentApi.deleteDataSource(s.id); refresh(); }
    catch (e: any) { toast({ title: t('aiAgent.webPages.deleteFailed'), description: e?.message, variant: 'destructive' }); }
  }

  if (!wsId) return null;

  const primaryDomain = domains[0]?.domain || null;

  return (
    <div className="space-y-6" dir={dir}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Globe className="h-5 w-5 text-primary" /> {t('aiAgent.webPages.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            {t('aiAgent.webPages.subtitle')}
          </p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={!primaryDomain}>
          <Plus className="h-4 w-4 me-1.5" /> {t('aiAgent.webPages.addSource')}
        </Button>
      </div>

      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 flex items-start gap-3 text-sm">
          <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
          <p className="text-muted-foreground">{t('aiAgent.webPages.explainer')}</p>
        </CardContent>
      </Card>

      {!primaryDomain && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-4 flex items-start gap-3 text-sm">
            <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{t('aiAgent.webPages.noDomainTitle')}</p>
              <p className="text-muted-foreground mt-1">
                {t('aiAgent.webPages.noDomainBody')}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {primaryDomain && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{t('aiAgent.webPages.registeredDomain')} <span className="font-mono text-foreground" dir="ltr">{primaryDomain}</span></span>
          {limits && (
            <>
              <span>{t('aiAgent.webPages.plan')} <span className="text-foreground">{limits.planName || limits.planSlug || t('aiAgent.webPages.planFree')}</span></span>
              <span>{t('aiAgent.webPages.maxPagesPerSource')} <span className="text-foreground">{limits.limits.ai_kb_max_pages}</span></span>
              <span>{t('aiAgent.webPages.maxDepth')} <span className="text-foreground">{limits.limits.ai_kb_max_depth}</span></span>
              <span>{t('aiAgent.webPages.syncJobsThisMonth')} <span className="text-foreground">{limits.jobs_used_this_month}/{limits.limits.ai_kb_jobs_per_month}</span></span>
              {limits.bypass && (
                <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">{t('aiAgent.webPages.adminBypassActive')}</Badge>
              )}
              {limits.worker && (
                <span>{t('aiAgent.webPages.worker')} <span className="text-foreground">{limits.worker.inProcess ? t('aiAgent.webPages.workerInProcess') : t('aiAgent.webPages.workerExternal')}{limits.worker.started ? ` · ${t('aiAgent.webPages.workerRunning')}` : ''}</span></span>
              )}
            </>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 text-primary flex items-center justify-center">
              <Globe className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-medium">{t('aiAgent.webPages.emptyTitle')}</h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {t('aiAgent.webPages.emptyBody')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((s) => (
            <Card key={s.id}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <button onClick={() => expand(s.id)} className="text-muted-foreground hover:text-foreground mt-1">
                    {expanded === s.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{s.name}</span>
                      <StatusBadge status={s.status} t={t} />
                      <Badge variant="outline" className="text-[10px]">{t(`aiAgent.webPages.dialog.refresh${capitalize(s.refresh_interval)}` as any)}</Badge>
                    </div>
                    {s.base_url && (
                      <a href={s.base_url} target="_blank" rel="noreferrer" dir="ltr"
                         className="text-xs text-muted-foreground hover:text-foreground font-mono break-all">
                        {s.base_url}
                      </a>
                    )}
                    <div className="text-[11px] text-muted-foreground mt-1.5 flex gap-3 flex-wrap">
                      <span>{t('aiAgent.webPages.depthLabel', { n: s.crawl_depth })}</span>
                      <span>{t('aiAgent.webPages.maxPagesLabel', { n: s.max_pages })}</span>
                      <span>{s.last_synced_at ? t('aiAgent.webPages.lastSynced', { date: new Date(s.last_synced_at).toLocaleString() }) : t('aiAgent.webPages.neverSynced')}</span>
                    </div>
                    {s.last_error && (
                      <p className="text-xs text-destructive mt-1">⚠ {s.last_error}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {latestJobs[s.id]?.status === 'failed' && (
                      <Button variant="outline" size="sm" onClick={() => retry(s)}>
                        {t('aiAgent.webPages.retrySync')}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => sync(s)} disabled={s.status === 'syncing'}>
                      <RefreshCw className={`h-4 w-4 ${s.status === 'syncing' ? 'animate-spin' : ''}`} />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => remove(s)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>

                {expanded === s.id && (
                  <div className="mt-4 ms-7 border-t pt-3">
                    <p className="text-xs font-medium text-muted-foreground mb-2">{t('aiAgent.webPages.recentSyncLogs')}</p>
                    {(logs[s.id] || []).length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t('aiAgent.webPages.noLogsYet')}</p>
                    ) : (
                      <div className="space-y-1.5">
                        {(logs[s.id] || []).map((l) => (
                          <div key={l.id} className="text-xs flex gap-3 items-start">
                            <Badge variant="outline" className="text-[10px]">{l.status}</Badge>
                            <span className="text-muted-foreground tabular-nums">
                              {new Date(l.created_at).toLocaleString()}
                            </span>
                            <span className="flex-1">{l.message || ''}</span>
                            {l.pages_found > 0 && <span className="text-muted-foreground">{t('aiAgent.webPages.pagesFound', { n: l.pages_found })}</span>}
                            {l.chunks_created > 0 && <span className="text-muted-foreground">{t('aiAgent.webPages.chunksCreated', { n: l.chunks_created })}</span>}
                            {l.errors > 0 && <span className="text-destructive">{t('aiAgent.webPages.errorsCount', { n: l.errors })}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <NewWebsiteDialog open={open} onOpenChange={setOpen} workspaceId={wsId}
        registeredDomain={primaryDomain} onCreated={() => { setOpen(false); refresh(); }} />
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function StatusBadge({ status, t }: { status: DataSource['status']; t: (key: any, params?: Record<string, string | number>) => string }) {
  const cls = status === 'active' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20'
    : status === 'syncing' ? 'bg-primary/10 text-primary border-primary/20'
    : status === 'failed' ? 'bg-destructive/10 text-destructive border-destructive/20'
    : status === 'paused' ? 'bg-muted text-muted-foreground' : 'bg-muted text-muted-foreground';
  const label = t(`aiAgent.webPages.status.${status}` as any);
  return <Badge variant="outline" className={`text-[10px] ${cls}`}>{label}</Badge>;
}

function NewWebsiteDialog({
  open, onOpenChange, workspaceId, registeredDomain, onCreated,
}: {
  open: boolean; onOpenChange: (b: boolean) => void; workspaceId: string;
  registeredDomain: string | null; onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    base_url: '', crawl_depth: 2, max_pages: 50,
    refresh_interval: 'manual' as 'manual' | 'daily' | 'weekly' | 'monthly',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (registeredDomain) {
      const clean = registeredDomain.replace(/^https?:\/\//, '');
      setForm((f) => ({ ...f, base_url: `https://${clean}` }));
    }
  }, [registeredDomain, open]);

  async function save() {
    setSaving(true);
    try {
      await aiAgentApi.createWebsiteSource({ workspaceId, ...form });
      onCreated();
    } catch (e: any) {
      toast({ title: t('aiAgent.webPages.addFailed'), description: e?.message, variant: 'destructive' });
    } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('aiAgent.webPages.dialog.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t('aiAgent.webPages.dialog.baseUrlLabel')}</Label>
            <Input value={form.base_url} onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
              placeholder="https://yourdomain.com" dir="ltr" />
            <p className="text-[11px] text-muted-foreground">
              {registeredDomain
                ? t('aiAgent.webPages.dialog.baseUrlHintWithDomain', { domain: registeredDomain })
                : t('aiAgent.webPages.dialog.baseUrlHintNoDomain')}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>{t('aiAgent.webPages.dialog.crawlDepth')}</Label>
              <Input type="number" min={1} max={5} value={form.crawl_depth}
                onChange={(e) => setForm((f) => ({ ...f, crawl_depth: parseInt(e.target.value || '2', 10) }))} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('aiAgent.webPages.dialog.maxPages')}</Label>
              <Input type="number" min={1} max={500} value={form.max_pages}
                onChange={(e) => setForm((f) => ({ ...f, max_pages: parseInt(e.target.value || '50', 10) }))} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('aiAgent.webPages.dialog.refresh')}</Label>
              <Select value={form.refresh_interval} onValueChange={(v) => setForm((f) => ({ ...f, refresh_interval: v as any }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">{t('aiAgent.webPages.dialog.refreshManual')}</SelectItem>
                  <SelectItem value="daily">{t('aiAgent.webPages.dialog.refreshDaily')}</SelectItem>
                  <SelectItem value="weekly">{t('aiAgent.webPages.dialog.refreshWeekly')}</SelectItem>
                  <SelectItem value="monthly">{t('aiAgent.webPages.dialog.refreshMonthly')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('aiAgent.webPages.dialog.cancel')}</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />} {t('aiAgent.webPages.dialog.addSource')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
