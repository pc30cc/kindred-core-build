import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import {
  useSeoSites, useSeoLimits, useLatestCrawl, useCrawlHistory, useStartCrawl, useCancelCrawl,
  useCrawl, useCrawlPages, useCrawlIssues, useIssueAffectedUrls, useCrawlLinks, useCrawlSitemaps,
  useCrawlComparison,
} from '@/hooks/useSeo';
import { SeoApiError, type SeoCrawl, type SeoIssue } from '@/lib/seo-api';
import { toast } from '@/lib/toast';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { SkeletonStats, SkeletonTable } from '@/components/common/Skeletons';
import { Radar, RefreshCw, AlertTriangle, CheckCircle2, XCircle, ArrowLeft, ExternalLink } from 'lucide-react';

const SEVERITY_CLASS: Record<string, string> = {
  critical: 'bg-destructive/15 text-destructive border-destructive/30',
  high: 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30',
  medium: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  low: 'bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30',
  info: 'bg-muted text-muted-foreground border-border',
};

/** Maps a failed start/cancel-crawl request to a translated, human-readable message. */
export function startCrawlErrorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof SeoApiError) {
    switch (err.code) {
      case 'workspace_concurrency_limit':
      case 'site_concurrency_limit':
        return t(`seo.limits.${err.code}` as any);
      case 'frequency_limit': {
        const minutes = Math.max(1, Math.round((err.retryAfterSeconds ?? 0) / 60));
        return `${t('seo.limits.frequency_limit' as any)} ${t('seo.limits.retryAfter' as any, { minutes })}`;
      }
      case 'site_not_found': return t('seo.errors.siteNotFound' as any);
      default: return t('seo.errors.startFailed' as any);
    }
  }
  return t('seo.errors.startFailed' as any);
}

function ScoreRing({ score }: { score: number | null }) {
  if (score === null) return <div className="text-3xl font-semibold text-muted-foreground">—</div>;
  const color = score >= 80 ? 'text-emerald-500' : score >= 50 ? 'text-amber-500' : 'text-destructive';
  return <div className={`text-4xl font-bold ${color}`}>{score}</div>;
}

export default function SeoPage() {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const workspaceId = workspace?.id;

  const { data: sitesData, isLoading: sitesLoading } = useSeoSites(workspaceId);
  const sites = sitesData?.sites || [];
  const [siteId, setSiteId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!siteId && sites.length === 1) setSiteId(sites[0].id);
  }, [sites, siteId]);

  const { data: limitsData } = useSeoLimits(workspaceId);
  const { data: latestData, isLoading: latestLoading } = useLatestCrawl(workspaceId, siteId);
  const { data: historyData } = useCrawlHistory(workspaceId, siteId, 20, 0);
  const startCrawl = useStartCrawl(workspaceId || '');
  const cancelCrawl = useCancelCrawl(workspaceId || '');

  const [activeCrawlId, setActiveCrawlId] = useState<string | undefined>(undefined);
  const latestCrawl = latestData?.crawl || null;
  const crawlId = activeCrawlId || latestCrawl?.id;
  const { data: crawlData } = useCrawl(workspaceId, crawlId);
  const crawl = crawlData?.crawl || latestCrawl;

  if (!workspaceId || sitesLoading) {
    return <div className="p-6"><SkeletonStats count={4} /></div>;
  }

  if (sites.length === 0) {
    return (
      <div className="p-6">
        <PageHeader />
        <Card className="mt-6">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Radar className="h-10 w-10 text-muted-foreground" />
            <h3 className="text-lg font-semibold">{t('seo.empty.noSitesTitle')}</h3>
            <p className="max-w-md text-sm text-muted-foreground">{t('seo.empty.noSitesDescription')}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleStart = () => {
    if (!siteId) return;
    startCrawl.mutate(siteId, {
      onSuccess: (res) => setActiveCrawlId(res.crawl.id),
      onError: (err) => toast.error(startCrawlErrorMessage(t, err)),
    });
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader />

      {sites.length > 1 && (
        <div className="max-w-xs">
          <Select value={siteId} onValueChange={(v) => { setSiteId(v); setActiveCrawlId(undefined); }}>
            <SelectTrigger>
              <SelectValue placeholder={t('seo.sitePlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {sites.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.domain}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {siteId && latestLoading && <SkeletonStats count={4} />}

      {siteId && !latestLoading && !crawl && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Radar className="h-10 w-10 text-muted-foreground" />
            <h3 className="text-lg font-semibold">{t('seo.empty.neverCrawledTitle')}</h3>
            <p className="max-w-md text-sm text-muted-foreground">{t('seo.empty.neverCrawledDescription')}</p>
            {limitsData && (
              <p className="text-xs text-muted-foreground">{t('seo.limits.maxPages', { count: limitsData.limits.seo_max_pages_per_crawl })}</p>
            )}
            <Button onClick={handleStart} disabled={startCrawl.isPending} className="gap-2">
              <Radar className="h-4 w-4" /> {t('seo.empty.neverCrawledCta')}
            </Button>
          </CardContent>
        </Card>
      )}

      {siteId && crawl && (crawl.status === 'queued' || crawl.status === 'running' || crawl.status === 'processing') && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
            <Radar className="h-10 w-10 animate-pulse text-primary" />
            <h3 className="text-lg font-semibold">{t('seo.empty.runningTitle')}</h3>
            <p className="max-w-md text-sm text-muted-foreground">{t('seo.empty.runningDescription')}</p>
            <div className="w-full max-w-sm space-y-2">
              <Progress value={crawl.progress} />
              <p className="text-xs text-muted-foreground">
                {crawl.progress_stage ? (t(`seo.stage.${crawl.progress_stage.split(':')[0]}` as any) || crawl.progress_stage) : t('seo.stage.preparing')}
                {crawl.pages_crawled > 0 ? ` · ${crawl.pages_crawled}` : ''}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => cancelCrawl.mutate(crawl.id, { onError: (err) => toast.error(startCrawlErrorMessage(t, err)) })}
              disabled={cancelCrawl.isPending}
            >
              {t('seo.cancelCrawl')}
            </Button>
          </CardContent>
        </Card>
      )}

      {siteId && crawl && crawl.status === 'failed' && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <XCircle className="h-10 w-10 text-destructive" />
            <h3 className="text-lg font-semibold">{t('seo.empty.failedTitle')}</h3>
            {crawl.error_message && <p className="max-w-md text-sm text-muted-foreground">{crawl.error_message}</p>}
            <Button onClick={handleStart} disabled={startCrawl.isPending} className="gap-2">
              <RefreshCw className="h-4 w-4" /> {t('seo.empty.failedCta')}
            </Button>
          </CardContent>
        </Card>
      )}

      {siteId && crawl && crawl.status === 'cancelled' && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <XCircle className="h-10 w-10 text-muted-foreground" />
            <h3 className="text-lg font-semibold">{t('seo.empty.cancelledTitle')}</h3>
            <p className="max-w-md text-sm text-muted-foreground">{t('seo.empty.cancelledDescription')}</p>
            <Button onClick={handleStart} disabled={startCrawl.isPending} className="gap-2">
              <Radar className="h-4 w-4" /> {t('seo.empty.cancelledCta')}
            </Button>
          </CardContent>
        </Card>
      )}

      {siteId && crawl && crawl.status === 'completed' && (
        <SeoDashboard
          workspaceId={workspaceId}
          crawl={crawl}
          onRunAgain={handleStart}
          runPending={startCrawl.isPending}
          history={historyData?.crawls || []}
        />
      )}
    </div>
  );
}

function PageHeader() {
  const { t } = useTranslation();
  return (
    <div>
      <h1 className="flex items-center gap-2 text-2xl font-bold"><Radar className="h-6 w-6" /> {t('seo.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('seo.subtitle')}</p>
    </div>
  );
}

function SeoDashboard({
  workspaceId, crawl, onRunAgain, runPending, history,
}: {
  workspaceId: string;
  crawl: SeoCrawl;
  onRunAgain: () => void;
  runPending: boolean;
  history: SeoCrawl[];
}) {
  const { t } = useTranslation();
  const { data: issuesData } = useCrawlIssues(workspaceId, crawl.id, { limit: 200 });
  const issues = issuesData?.issues || [];
  const critical = issues.filter((i) => i.severity === 'critical' || i.severity === 'high').reduce((n, i) => n + i.affected_count, 0);
  const warnings = issues.filter((i) => i.severity === 'medium' || i.severity === 'low').reduce((n, i) => n + i.affected_count, 0);
  const passed = Math.max(0, crawl.pages_crawled - critical - warnings);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6 flex-1">
          <StatCard label={t('seo.summary.seoScore')} value={<ScoreRing score={crawl.score} />} />
          <StatCard label={t('seo.summary.lastCrawl')} value={crawl.finished_at ? new Date(crawl.finished_at).toLocaleDateString() : t('seo.summary.never')} />
          <StatCard label={t('seo.summary.pagesCrawled')} value={crawl.pages_crawled} />
          <StatCard label={t('seo.summary.criticalIssues')} value={critical} accent="text-destructive" />
          <StatCard label={t('seo.summary.warnings')} value={warnings} accent="text-amber-500" />
          <StatCard label={t('seo.summary.passedChecks')} value={passed} accent="text-emerald-500" />
        </div>
        <Button onClick={onRunAgain} disabled={runPending} className="gap-2">
          <RefreshCw className="h-4 w-4" /> {t('seo.runAgain')}
        </Button>
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="overview">{t('seo.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="issues">{t('seo.tabs.issues')}</TabsTrigger>
          <TabsTrigger value="pages">{t('seo.tabs.pages')}</TabsTrigger>
          <TabsTrigger value="links">{t('seo.tabs.links')}</TabsTrigger>
          <TabsTrigger value="sitemap">{t('seo.tabs.sitemap')}</TabsTrigger>
          <TabsTrigger value="performance">{t('seo.tabs.performance')}</TabsTrigger>
          <TabsTrigger value="history">{t('seo.tabs.history')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview"><OverviewTab crawl={crawl} issues={issues} /></TabsContent>
        <TabsContent value="issues"><IssuesTab workspaceId={workspaceId} crawlId={crawl.id} /></TabsContent>
        <TabsContent value="pages"><PagesTab workspaceId={workspaceId} crawlId={crawl.id} /></TabsContent>
        <TabsContent value="links"><LinksTab workspaceId={workspaceId} crawlId={crawl.id} /></TabsContent>
        <TabsContent value="sitemap"><SitemapTab workspaceId={workspaceId} crawlId={crawl.id} crawl={crawl} /></TabsContent>
        <TabsContent value="performance"><PerformanceTab /></TabsContent>
        <TabsContent value="history"><HistoryTab workspaceId={workspaceId} crawl={crawl} history={history} /></TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className={`mt-1 text-2xl font-semibold ${accent || ''}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function OverviewTab({ crawl, issues }: { crawl: SeoCrawl; issues: SeoIssue[] }) {
  const { t } = useTranslation();
  const bySeverity = useMemo(() => {
    const out: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const i of issues) out[i.severity] = (out[i.severity] || 0) + 1;
    return out;
  }, [issues]);
  const topIssues = useMemo(() => [...issues].sort((a, b) => b.affected_count - a.affected_count).slice(0, 5), [issues]);
  const breakdown = crawl.score_breakdown?.entries || [];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-sm">{t('seo.summary.seoScore')} — {t('seo.overview.scoreTrend')}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {crawl.score !== null && crawl.score_version && (
            <p className="text-xs text-muted-foreground">score_version: {crawl.score_version}</p>
          )}
          {breakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('seo.overview.noIssues')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {breakdown.slice(0, 8).map((e) => (
                <li key={e.issueType} className="flex justify-between gap-2">
                  <span className="text-muted-foreground">{e.label}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">{t('seo.overview.topIssues')}</CardTitle></CardHeader>
        <CardContent>
          {topIssues.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('seo.overview.noIssues')}</p>
          ) : (
            <ul className="space-y-2">
              {topIssues.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2">
                    <Badge className={SEVERITY_CLASS[i.severity]}>{t(`seo.severity.${i.severity}` as any)}</Badge>
                    {i.title}
                  </span>
                  <span className="text-muted-foreground">{i.affected_count}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">{t('seo.overview.httpBreakdown')}</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-2 text-center text-sm">
            <div><div className="text-lg font-semibold">{bySeverity.critical}</div>{t('seo.severity.critical')}</div>
            <div><div className="text-lg font-semibold">{bySeverity.high}</div>{t('seo.severity.high')}</div>
            <div><div className="text-lg font-semibold">{bySeverity.medium}</div>{t('seo.severity.medium')}</div>
            <div><div className="text-lg font-semibold">{bySeverity.low}</div>{t('seo.severity.low')}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">{t('seo.overview.technicalOverview')}</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <TechRow label={t('seo.overview.robotsStatus')} ok={!!crawl.robots_summary?.exists} />
          <TechRow label={t('seo.overview.sitemapStatus')} ok={(crawl.sitemap_summary?.sitemapCount || 0) > 0} />
          <TechRow label={t('seo.overview.brokenLinksSummary')} ok={!issues.some((i) => i.issue_type === 'broken_internal_links')} />
          <TechRow label={t('seo.overview.metadataHealth')} ok={!issues.some((i) => i.issue_type === 'missing_title' || i.issue_type === 'missing_meta_description')} />
        </CardContent>
      </Card>
    </div>
  );
}

function TechRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
    </div>
  );
}

function IssuesTab({ workspaceId, crawlId }: { workspaceId: string; crawlId: string }) {
  const { t } = useTranslation();
  const [severity, setSeverity] = useState<string | undefined>(undefined);
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<SeoIssue | null>(null);
  const { data } = useCrawlIssues(workspaceId, crawlId, { severity, category, limit: 100 });
  const issues = data?.issues || [];
  const { data: affected } = useIssueAffectedUrls(workspaceId, crawlId, selected?.id);

  if (selected) {
    return (
      <Card className="mt-4">
        <CardHeader>
          <Button variant="ghost" size="sm" className="w-fit gap-1 px-0" onClick={() => setSelected(null)}>
            <ArrowLeft className="h-4 w-4" /> {t('seo.issues.backToList')}
          </Button>
          <CardTitle className="flex items-center gap-2">
            <Badge className={SEVERITY_CLASS[selected.severity]}>{t(`seo.severity.${selected.severity}` as any)}</Badge>
            {selected.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div><div className="font-medium">{t('seo.issues.whyItMatters')}</div><p className="text-muted-foreground">{selected.description}</p></div>
          <div><div className="font-medium">{t('seo.issues.recommendedFix')}</div><p className="text-muted-foreground">{selected.recommendation}</p></div>
          <div>
            <div className="font-medium">{t('seo.issues.affectedUrls')} ({selected.affected_count})</div>
            <ul className="mt-2 max-h-96 space-y-1 overflow-auto text-xs">
              {(affected?.urls || []).map((u, idx) => (
                <li key={idx} className="truncate text-muted-foreground">{u.url}</li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap gap-2">
        <Select value={severity} onValueChange={(v) => setSeverity(v === 'all' ? undefined : v)}>
          <SelectTrigger className="w-40"><SelectValue placeholder={t('seo.issues.filterSeverity')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('seo.issues.allSeverities')}</SelectItem>
            {['critical', 'high', 'medium', 'low', 'info'].map((s) => (
              <SelectItem key={s} value={s}>{t(`seo.severity.${s}` as any)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={(v) => setCategory(v === 'all' ? undefined : v)}>
          <SelectTrigger className="w-48"><SelectValue placeholder={t('seo.issues.filterCategory')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('seo.issues.allCategories')}</SelectItem>
            {['crawlability', 'indexability', 'http', 'metadata', 'content', 'links', 'images', 'canonical', 'sitemap', 'robots', 'security', 'performance', 'structured_data'].map((c) => (
              <SelectItem key={c} value={c}>{t(`seo.category.${c}` as any)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('seo.issues.columnSeverity')}</TableHead>
              <TableHead>{t('seo.issues.columnIssue')}</TableHead>
              <TableHead>{t('seo.issues.columnCategory')}</TableHead>
              <TableHead>{t('seo.issues.columnAffected')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {issues.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">{t('seo.issues.empty')}</TableCell></TableRow>
            )}
            {issues.map((i) => (
              <TableRow key={i.id} className="cursor-pointer" onClick={() => setSelected(i)}>
                <TableCell><Badge className={SEVERITY_CLASS[i.severity]}>{t(`seo.severity.${i.severity}` as any)}</Badge></TableCell>
                <TableCell className="font-medium">{i.title}</TableCell>
                <TableCell className="text-muted-foreground">{t(`seo.category.${i.category}` as any)}</TableCell>
                <TableCell>{i.affected_count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function PagesTab({ workspaceId, crawlId }: { workspaceId: string; crawlId: string }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const { data, isLoading } = useCrawlPages(workspaceId, crawlId, { search: search || undefined, limit, offset });
  const pages = data?.pages || [];

  return (
    <div className="mt-4 space-y-3">
      <Input placeholder={t('seo.pages.searchPlaceholder')} value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} className="max-w-sm" />
      {isLoading ? <SkeletonTable rows={6} /> : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('seo.pages.columnUrl')}</TableHead>
                <TableHead>{t('seo.pages.columnStatus')}</TableHead>
                <TableHead>{t('seo.pages.columnIndexability')}</TableHead>
                <TableHead>{t('seo.pages.columnTitle')}</TableHead>
                <TableHead>{t('seo.pages.columnDepth')}</TableHead>
                <TableHead>{t('seo.pages.columnResponseTime')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pages.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">{t('seo.pages.empty')}</TableCell></TableRow>
              )}
              {pages.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="max-w-xs truncate"><a href={p.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:underline">{p.url}<ExternalLink className="h-3 w-3 shrink-0" /></a></TableCell>
                  <TableCell>{p.http_status ?? '—'}</TableCell>
                  <TableCell>{p.is_indexable ? t('seo.pages.indexable') : t('seo.pages.nonIndexable')}</TableCell>
                  <TableCell className="max-w-xs truncate">{p.title || '—'}</TableCell>
                  <TableCell>{p.depth}</TableCell>
                  <TableCell>{p.response_time_ms ? `${p.response_time_ms}ms` : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>←</Button>
        <Button variant="outline" size="sm" disabled={pages.length < limit} onClick={() => setOffset(offset + limit)}>→</Button>
      </div>
    </div>
  );
}

function LinksTab({ workspaceId, crawlId }: { workspaceId: string; crawlId: string }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<'broken' | 'external'>('broken');
  const { data } = useCrawlLinks(workspaceId, crawlId, filter === 'broken' ? { broken: true, limit: 100 } : { external: true, limit: 100 });
  const links = data?.links || [];

  return (
    <div className="mt-4 space-y-3">
      <div className="flex gap-2">
        <Button size="sm" variant={filter === 'broken' ? 'default' : 'outline'} onClick={() => setFilter('broken')}>{t('seo.links.broken')}</Button>
        <Button size="sm" variant={filter === 'external' ? 'default' : 'outline'} onClick={() => setFilter('external')}>{t('seo.links.external')}</Button>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('seo.links.target')}</TableHead>
              <TableHead>{t('seo.links.httpStatus')}</TableHead>
              <TableHead>{t('seo.links.sourcePages')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {links.length === 0 && (
              <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">{t('seo.links.empty')}</TableCell></TableRow>
            )}
            {links.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="max-w-xs truncate">{l.target_url}</TableCell>
                <TableCell>{l.http_status ?? '—'}</TableCell>
                <TableCell className="max-w-xs truncate">{l.source_page?.url || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function SitemapTab({ workspaceId, crawlId, crawl }: { workspaceId: string; crawlId: string; crawl: SeoCrawl }) {
  const { t } = useTranslation();
  const { data } = useCrawlSitemaps(workspaceId, crawlId);
  const sitemaps = data?.sitemaps || [];

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label={t('seo.sitemap.discovered')} value={crawl.sitemap_summary?.sitemapCount ?? 0} />
        <StatCard label={t('seo.sitemap.valid')} value={crawl.sitemap_summary?.validSitemapCount ?? 0} accent="text-emerald-500" />
        <StatCard label={t('seo.sitemap.missingFromSitemap')} value={crawl.sitemap_summary?.crawledButMissingFromSitemap ?? 0} accent="text-amber-500" />
        <StatCard label={t('seo.sitemap.notCrawled')} value={crawl.sitemap_summary?.sitemapUrlsNotCrawled ?? 0} accent="text-amber-500" />
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>URL</TableHead>
              <TableHead>{t('seo.pages.columnStatus')}</TableHead>
              <TableHead>{t('seo.sitemap.urlCount')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sitemaps.length === 0 && (
              <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">{t('seo.sitemap.empty')}</TableCell></TableRow>
            )}
            {sitemaps.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="max-w-xs truncate">{s.url}</TableCell>
                <TableCell>
                  <Badge className={s.status === 'valid' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-destructive/15 text-destructive'}>
                    {s.status === 'valid' ? t('seo.sitemap.valid') : t('seo.sitemap.invalid')}
                  </Badge>
                </TableCell>
                <TableCell>{s.url_count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function PerformanceTab() {
  const { t } = useTranslation();
  return (
    <Card className="mt-4">
      <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <h3 className="text-lg font-semibold">{t('seo.performance.comingSoonTitle')}</h3>
        <p className="max-w-md text-sm text-muted-foreground">{t('seo.performance.comingSoonDescription')}</p>
      </CardContent>
    </Card>
  );
}

function HistoryTab({ workspaceId, crawl, history }: { workspaceId: string; crawl: SeoCrawl; history: SeoCrawl[] }) {
  const { t } = useTranslation();
  const { data: comparison } = useCrawlComparison(workspaceId, crawl.id);

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <StatCard label={t('seo.history.newIssues')} value={comparison?.newIssues.length ?? 0} accent="text-amber-500" />
        <StatCard label={t('seo.history.resolvedIssues')} value={comparison?.resolvedIssues.length ?? 0} accent="text-emerald-500" />
        <StatCard label={t('seo.history.persistentIssues')} value={comparison?.persistentIssues.length ?? 0} />
      </div>
      {comparison && !comparison.hasPrevious && (
        <p className="text-sm text-muted-foreground">{t('seo.history.noPrevious')}</p>
      )}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('seo.history.date')}</TableHead>
              <TableHead>{t('seo.history.score')}</TableHead>
              <TableHead>{t('seo.history.pagesCrawled')}</TableHead>
              <TableHead>{t('seo.history.status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">{t('seo.history.empty')}</TableCell></TableRow>
            )}
            {history.map((h) => (
              <TableRow key={h.id}>
                <TableCell>{new Date(h.created_at).toLocaleString()}</TableCell>
                <TableCell>{h.score ?? '—'}</TableCell>
                <TableCell>{h.pages_crawled}</TableCell>
                <TableCell>{t(`seo.status.${h.status}` as any)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
