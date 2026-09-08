import { Fragment, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { SEO_SECTIONS, findSection, firstLeafKey, findLeaf } from './seoNavTree';
import { SeoSectionNav } from './SeoSectionNav';
import { SeoRoadmapPlaceholder } from './SeoRoadmapPlaceholder';
import { GscInsightsSection } from './GscInsightsSection';
import { SiteExplorerSection } from './SiteExplorerSection';
import { WebAnalyticsSection } from './WebAnalyticsSection';
import { BotAnalyticsSection } from './BotAnalyticsSection';
import {
  useSeoSites, useSeoLimits, useLatestCrawl, useCrawlHistory, useStartCrawl, useCancelCrawl,
  useCrawl, useCrawlPages, useCrawlIssues, useIssueAffectedUrls, useCrawlLinks, useCrawlSitemaps,
  useCrawlComparison,
  useRankTrackingLimits, useTrackedKeywords, useAddTrackedKeyword, useRemoveTrackedKeyword, useRankChecks,
  usePerformanceLimits, useLatestPerformanceAudit, useStartPerformanceAudit, usePerformanceResults,
} from '@/hooks/useSeo';
import { SeoApiError, TERMINAL_SEO_STATUSES, type SeoCrawl, type SeoIssue } from '@/lib/seo-api';
import { toast } from '@/lib/toast';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { SkeletonStats, SkeletonTable } from '@/components/common/Skeletons';
import { PlanLockedOverlay } from '@/components/plan/PlanLockedOverlay';
import {
  Radar, RefreshCw, AlertTriangle, CheckCircle2, XCircle, ArrowLeft, ExternalLink, Lock,
  TrendingUp, Sparkles, ShieldCheck,
  Search, LineChart, Gauge, Plus, Trash2, Target,
} from 'lucide-react';
import {
  PieChart, Pie, Cell, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as ReTooltip, ResponsiveContainer, LineChart as ReLineChart, Line,
} from 'recharts';

const SEVERITY_CLASS: Record<string, string> = {
  critical: 'bg-destructive/15 text-destructive border-destructive/30',
  high: 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30',
  medium: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  low: 'bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30',
  info: 'bg-muted text-muted-foreground border-border',
};

// Numeric thresholds the rules engine (server/services/seo/rules/{policy,checks}.ts)
// bakes into the English title/description/recommendation it persists on
// seo_issues — mirrored here so the localized string can be re-interpolated
// in the active locale instead of showing the raw English number sentence.
const ISSUE_TEXT_PARAMS: Record<string, Record<string, number>> = {
  title_length: { min: 30, max: 60 },
  meta_description_length: { min: 70, max: 160 },
  low_content: { count: 100 },
  slow_response: { ms: 3000 },
};

/**
 * `seo_issues.{title,description,recommendation}` are persisted in English
 * by the rules engine (issue_type is the stable, language-neutral key).
 * These look up the matching `seo.issues.types.<issue_type>.*` translation
 * and fall back to the raw persisted English text for any issue_type that
 * doesn't have one yet (e.g. a rule added without its i18n keys).
 */
function localizedIssueTypeTitle(t: (key: string, opts?: Record<string, unknown>) => string, issueType: string, fallback: string): string {
  const key = `seo.issues.types.${issueType}.title`;
  const translated = t(key as any);
  return translated === key ? fallback : translated;
}

function localizedIssueTitle(t: (key: string, opts?: Record<string, unknown>) => string, issue: SeoIssue): string {
  return localizedIssueTypeTitle(t, issue.issue_type, issue.title);
}

function localizedIssueDescription(t: (key: string, opts?: Record<string, unknown>) => string, issue: SeoIssue): string {
  const key = `seo.issues.types.${issue.issue_type}.description`;
  const params: Record<string, number> = { ...(ISSUE_TEXT_PARAMS[issue.issue_type] || {}) };
  if (issue.issue_type === 'sitemap_coverage_gap') {
    const match = /(\d+)/.exec(issue.description || '');
    params.count = match ? parseInt(match[1], 10) : issue.affected_count;
  }
  const translated = t(key as any, params);
  return translated === key ? issue.description : translated;
}

function localizedIssueRecommendation(t: (key: string, opts?: Record<string, unknown>) => string, issue: SeoIssue): string {
  const key = `seo.issues.types.${issue.issue_type}.recommendation`;
  const translated = t(key as any, ISSUE_TEXT_PARAMS[issue.issue_type] || {});
  return translated === key ? issue.recommendation : translated;
}

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
  const wsPath = useWorkspacePath();
  const navigate = useNavigate();
  const { section: sectionParam, subsection: subsectionParam } = useParams<{ section?: string; subsection?: string }>();

  const activeSection = findSection(sectionParam);

  // Canonicalize the URL: bare /seo, or a section with no subsection, redirect
  // to that section's first report so the nav's active state is always well-defined.
  useEffect(() => {
    if (!sectionParam) {
      navigate(wsPath(`/seo/${activeSection.key}/${firstLeafKey(activeSection)}`), { replace: true });
    } else if (!subsectionParam) {
      navigate(wsPath(`/seo/${activeSection.key}/${firstLeafKey(activeSection)}`), { replace: true });
    }
  }, [sectionParam, subsectionParam, activeSection, navigate, wsPath]);

  const { data: sitesData, isLoading: sitesLoading } = useSeoSites(workspaceId);
  const sites = sitesData?.sites || [];
  const [siteId, setSiteId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!siteId && sites.length === 1) setSiteId(sites[0].id);
  }, [sites, siteId]);

  if (!workspaceId || sitesLoading) {
    return <div className="p-6"><SkeletonStats count={4} /></div>;
  }

  if (activeSection.needsSite && sites.length === 0) {
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

  const subsectionKey = subsectionParam || firstLeafKey(activeSection);

  return (
    <div className="flex h-full min-h-0 items-stretch">
      <SeoSectionNav activeSectionKey={activeSection.key} activeSubsectionKey={subsectionKey} />
      <div className="flex-1 overflow-y-auto bg-background p-6">
        {activeSection.needsSite ? (
          <SiteScopedSection
            workspaceId={workspaceId}
            sites={sites}
            siteId={siteId}
            onSiteChange={setSiteId}
            section={activeSection}
            subsectionKey={subsectionKey}
          />
        ) : activeSection.key === 'gsc-insights' ? (
          <GscInsightsSection workspaceId={workspaceId} subsectionKey={subsectionKey} />
        ) : activeSection.key === 'site-explorer' ? (
          <SiteExplorerSection workspaceId={workspaceId} subsectionKey={subsectionKey} />
        ) : activeSection.key === 'web-analytics' ? (
          <WebAnalyticsSection workspaceId={workspaceId} subsectionKey={subsectionKey} />
        ) : activeSection.key === 'bot-analytics' ? (
          <BotAnalyticsSection workspaceId={workspaceId} subsectionKey={subsectionKey} />
        ) : (
          <SeoRoadmapPlaceholder label={t(findLeaf(activeSection, subsectionKey)?.labelKey as any || activeSection.labelKey as any)} />
        )}
      </div>
    </div>
  );
}


/** Handles the three site-scoped tools (Site Audit, Rank Tracker, Site Explorer): site picker + per-tool content. */
function SiteScopedSection({
  workspaceId, sites, siteId, onSiteChange, section, subsectionKey,
}: {
  workspaceId: string;
  sites: { id: string; domain: string }[];
  siteId: string | undefined;
  onSiteChange: (id: string) => void;
  section: ReturnType<typeof findSection>;
  subsectionKey: string;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      {sites.length > 1 && (
        <div className="max-w-xs">
          <Select value={siteId} onValueChange={onSiteChange}>
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

      {!siteId ? (
        <p className="text-sm text-muted-foreground">{t('seo.sitePlaceholder')}</p>
      ) : section.key === 'site-audit' ? (
        <SiteAuditSection key={siteId} workspaceId={workspaceId} siteId={siteId} subsectionKey={subsectionKey} />
      ) : section.key === 'rank-tracker' ? (
        <RankTrackerSection key={siteId} workspaceId={workspaceId} siteId={siteId} subsectionKey={subsectionKey} />
      ) : null}
    </div>
  );
}

function RankTrackerSection({ workspaceId, siteId, subsectionKey }: { workspaceId: string; siteId: string; subsectionKey: string }) {
  const { t } = useTranslation();
  if (subsectionKey === 'trackedKeywords') {
    return <PlanLockedOverlay moduleKey="seo_rank_tracking"><RankTrackingTab workspaceId={workspaceId} siteId={siteId} /></PlanLockedOverlay>;
  }
  const leaf = findLeaf(findSection('rank-tracker'), subsectionKey);
  return <SeoRoadmapPlaceholder label={t((leaf?.labelKey || 'seo.nav.section.rankTracker') as any)} />;
}


/** The original crawl-status-gated flow (never crawled / running / failed / cancelled / completed), scoped to the Site Audit tool. */
function SiteAuditSection({ workspaceId, siteId, subsectionKey }: { workspaceId: string; siteId: string; subsectionKey: string }) {
  const { t } = useTranslation();
  const { data: limitsData } = useSeoLimits(workspaceId);
  const { data: latestData, isLoading: latestLoading } = useLatestCrawl(workspaceId, siteId);
  const { data: historyData } = useCrawlHistory(workspaceId, siteId, 20, 0);
  const startCrawl = useStartCrawl(workspaceId);
  const cancelCrawl = useCancelCrawl(workspaceId);

  const [activeCrawlId, setActiveCrawlId] = useState<string | undefined>(undefined);
  const latestCrawl = latestData?.crawl || null;
  const crawlId = activeCrawlId || latestCrawl?.id;
  const { data: crawlData } = useCrawl(workspaceId, crawlId);
  const crawl = crawlData?.crawl || latestCrawl;

  const handleStart = () => {
    startCrawl.mutate(siteId, {
      onSuccess: (res) => setActiveCrawlId(res.crawl.id),
      onError: (err) => toast.error(startCrawlErrorMessage(t, err)),
    });
  };

  if (latestLoading) return <SkeletonStats count={4} />;

  if (!crawl) {
    return (
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
    );
  }

  if (crawl.status === 'queued' || crawl.status === 'running' || crawl.status === 'processing') {
    return (
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
    );
  }

  if (crawl.status === 'failed') {
    return (
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
    );
  }

  if (crawl.status === 'cancelled') {
    return (
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
    );
  }

  return (
    <SeoDashboard
      workspaceId={workspaceId}
      crawl={crawl}
      onRunAgain={handleStart}
      runPending={startCrawl.isPending}
      history={historyData?.crawls || []}
      subsectionKey={subsectionKey}
    />
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
  workspaceId, crawl, onRunAgain, runPending, history, subsectionKey,
}: {
  workspaceId: string;
  crawl: SeoCrawl;
  onRunAgain: () => void;
  runPending: boolean;
  history: SeoCrawl[];
  subsectionKey: string;
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

      {subsectionKey === 'overview' && <OverviewTab crawl={crawl} issues={issues} />}
      {subsectionKey === 'issues' && <IssuesTab workspaceId={workspaceId} crawlId={crawl.id} />}
      {subsectionKey === 'pages' && <PagesTab workspaceId={workspaceId} crawlId={crawl.id} />}
      {subsectionKey === 'links' && <LinksTab workspaceId={workspaceId} crawlId={crawl.id} />}
      {subsectionKey === 'sitemap' && <SitemapTab workspaceId={workspaceId} crawlId={crawl.id} crawl={crawl} />}
      {subsectionKey === 'performance' && (
        <PlanLockedOverlay moduleKey="seo_performance"><PerformanceTab workspaceId={workspaceId} crawlId={crawl.id} /></PlanLockedOverlay>
      )}
      {subsectionKey === 'history' && <HistoryTab workspaceId={workspaceId} crawl={crawl} history={history} />}
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
            <p className="text-xs text-muted-foreground">{t('seo.overview.scoreVersionLabel')}: {crawl.score_version}</p>
          )}
          {breakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('seo.overview.noIssues')}</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {breakdown.slice(0, 8).map((e) => (
                <li key={e.issueType} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge className={`shrink-0 ${SEVERITY_CLASS[e.severity]}`}>{t(`seo.severity.${e.severity}` as any)}</Badge>
                    <span className="truncate">{localizedIssueTypeTitle(t, e.issueType, e.label)}</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground">{t('seo.overview.pointsDeducted' as any, { points: e.penalty, count: e.affectedCount })}</span>
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
                    {localizedIssueTitle(t, i)}
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
            {localizedIssueTitle(t, selected)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div><div className="font-medium">{t('seo.issues.whyItMatters')}</div><p className="text-muted-foreground">{localizedIssueDescription(t, selected)}</p></div>
          <div><div className="font-medium">{t('seo.issues.recommendedFix')}</div><p className="text-muted-foreground">{localizedIssueRecommendation(t, selected)}</p></div>
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
            {['crawlability', 'indexability', 'http', 'metadata', 'content', 'links', 'images', 'canonical', 'sitemap', 'robots', 'security', 'performance', 'structured_data', 'social'].map((c) => (
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
                <TableCell className="font-medium">{localizedIssueTitle(t, i)}</TableCell>
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

function startPerformanceAuditErrorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof SeoApiError) {
    if (err.upgradeRequired) return t('seo.performance.limits.module_not_available' as any);
    switch (err.code) {
      case 'module_not_available':
        return t('seo.performance.limits.module_not_available' as any);
      case 'frequency_limit': {
        const hours = Math.max(1, Math.round((err.retryAfterSeconds ?? 0) / 3600));
        return `${t('seo.performance.limits.frequency_limit' as any)} ${t('seo.performance.limits.retryAfter' as any, { hours })}`;
      }
      case 'crawl_not_found':
        return t('seo.performance.errors.crawlNotFound' as any);
      default:
        return t('seo.performance.errors.startFailed' as any);
    }
  }
  return t('seo.performance.errors.startFailed' as any);
}

function scoreBadgeClass(score: number | null): string {
  if (score === null) return 'border-border text-muted-foreground';
  if (score >= 90) return 'border-emerald-500/40 text-emerald-500 bg-emerald-500/10';
  if (score >= 50) return 'border-amber-500/40 text-amber-500 bg-amber-500/10';
  return 'border-destructive/40 text-destructive bg-destructive/10';
}

function PerformanceTab({ workspaceId, crawlId }: { workspaceId: string; crawlId: string }) {
  const { t } = useTranslation();
  const { data: limitsData } = usePerformanceLimits(workspaceId);
  const { data: latestData, isLoading } = useLatestPerformanceAudit(workspaceId, crawlId);
  const startAudit = useStartPerformanceAudit(workspaceId);
  const audit = latestData?.audit || null;
  const isRunning = !!audit && !TERMINAL_SEO_STATUSES.has(audit.status);
  const { data: resultsData } = usePerformanceResults(workspaceId, audit?.status === 'completed' ? audit.id : undefined);
  const results = (resultsData?.results || []).filter((r) => r.status === 'completed');

  const maxPages = limitsData?.limits.seo_performance_max_pages_per_audit ?? 0;
  const moduleAvailable = maxPages > 0;

  const stats = useMemo(() => {
    const avg = (key: 'performance_score' | 'accessibility_score' | 'best_practices_score' | 'seo_score') => {
      const withScore = results.filter((r) => r[key] !== null);
      return withScore.length ? Math.round(withScore.reduce((s, r) => s + (r[key] || 0), 0) / withScore.length) : null;
    };
    return {
      performance: avg('performance_score'),
      accessibility: avg('accessibility_score'),
      bestPractices: avg('best_practices_score'),
      seo: avg('seo_score'),
    };
  }, [results]);

  const pageScores = useMemo(
    () => [...results]
      .filter((r) => r.performance_score !== null)
      .sort((a, b) => (a.performance_score || 0) - (b.performance_score || 0))
      .slice(0, 8)
      .map((r) => ({ url: (() => { try { return new URL(r.url).pathname || '/'; } catch { return r.url; } })(), score: r.performance_score || 0 })),
    [results],
  );

  const handleStart = () => {
    startAudit.mutate(crawlId, {
      onError: (err) => toast.error(startPerformanceAuditErrorMessage(t, err)),
    });
  };

  const tooltipStyle = {
    contentStyle: { background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 12, fontSize: 12, color: 'hsl(var(--popover-foreground))' },
    labelStyle: { color: 'hsl(var(--muted-foreground))' },
  };

  if (isLoading) return <div className="mt-4"><SkeletonStats count={4} /></div>;

  if (!moduleAvailable) {
    return (
      <BacklinksEmptyState
        icon={Lock} iconGradient="from-slate-500 to-slate-700"
        title={t('seo.performance.empty.notAvailableTitle')}
        description={t('seo.performance.empty.notAvailableDescription')}
      />
    );
  }

  if (!audit) {
    return (
      <BacklinksEmptyState
        icon={Gauge} iconGradient="from-indigo-500 to-violet-500"
        title={t('seo.performance.empty.neverRunTitle')}
        description={t('seo.performance.empty.neverRunDescription')}
        action={(
          <Button onClick={handleStart} disabled={startAudit.isPending} className="gap-2">
            <Gauge className="h-4 w-4" /> {t('seo.performance.runAudit')}
          </Button>
        )}
      />
    );
  }

  if (isRunning) {
    return (
      <Card className="mt-4 overflow-hidden">
        <CardContent className="relative flex flex-col items-center justify-center gap-4 py-16 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-lg">
            <RefreshCw className="h-6 w-6 animate-spin" />
          </span>
          <h3 className="text-lg font-semibold">{t('seo.performance.empty.runningTitle')}</h3>
          <Progress value={audit.progress} className="w-full max-w-xs" />
        </CardContent>
      </Card>
    );
  }

  if (audit.status === 'failed') {
    return (
      <BacklinksEmptyState
        icon={XCircle} iconGradient="from-rose-500 to-red-600"
        title={t('seo.performance.empty.failedTitle')}
        action={(
          <Button onClick={handleStart} disabled={startAudit.isPending} className="gap-2">
            <RefreshCw className="h-4 w-4" /> {t('seo.performance.runAudit')}
          </Button>
        )}
      />
    );
  }

  return (
    <div className="mt-4 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-md shadow-indigo-500/25">
            <Gauge className="h-4.5 w-4.5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-foreground">{t('seo.performance.resultsTitle')}</h3>
            {audit.finished_at && (
              <p className="text-xs text-muted-foreground">
                {t('seo.performance.lastAudited')}: {new Date(audit.finished_at).toLocaleString()}
              </p>
            )}
          </div>
        </div>
        <Button onClick={handleStart} disabled={startAudit.isPending} variant="outline" className="gap-2">
          <RefreshCw className={`h-4 w-4 ${startAudit.isPending ? 'animate-spin' : ''}`} /> {t('seo.performance.newAudit')}
        </Button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <GradientStatCard icon={Gauge} iconGradient="from-indigo-500 to-violet-500" blobColor="bg-indigo-500/15" value={stats.performance ?? '—'} label={t('seo.performance.avgPerformance')} />
        <GradientStatCard icon={CheckCircle2} iconGradient="from-sky-500 to-cyan-500" blobColor="bg-sky-500/15" value={stats.accessibility ?? '—'} label={t('seo.performance.avgAccessibility')} />
        <GradientStatCard icon={ShieldCheck} iconGradient="from-emerald-500 to-teal-500" blobColor="bg-emerald-500/15" value={stats.bestPractices ?? '—'} label={t('seo.performance.avgBestPractices')} />
        <GradientStatCard icon={Search} iconGradient="from-amber-500 to-orange-500" blobColor="bg-amber-500/15" value={stats.seo ?? '—'} label={t('seo.performance.avgSeoScore')} />
      </div>

      {/* Chart */}
      <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
        <h4 className="mb-2 text-sm font-semibold text-foreground">{t('seo.performance.chartTitle')}</h4>
        {pageScores.length === 0 ? (
          <p className="flex h-[200px] items-center justify-center text-xs text-muted-foreground">{t('seo.performance.empty.noResults')}</p>
        ) : (
          <div className="h-[240px] w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pageScores} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="perfScoreGrad" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#ef4444" />
                    <stop offset="100%" stopColor="#f59e0b" />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                <YAxis type="category" dataKey="url" tickLine={false} axisLine={false} width={140} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                <ReTooltip {...tooltipStyle} cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }} />
                <Bar dataKey="score" name={t('seo.performance.avgPerformance')} fill="url(#perfScoreGrad)" radius={[0, 4, 4, 0]} maxBarSize={18} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Table */}
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>URL</TableHead>
              <TableHead>{t('seo.performance.columnPerformance')}</TableHead>
              <TableHead>{t('seo.performance.columnAccessibility')}</TableHead>
              <TableHead>{t('seo.performance.columnBestPractices')}</TableHead>
              <TableHead>{t('seo.performance.columnSeo')}</TableHead>
              <TableHead>{t('seo.performance.columnLcp')}</TableHead>
              <TableHead>{t('seo.performance.columnCls')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">{t('seo.performance.empty.noResults')}</TableCell></TableRow>
            )}
            {results.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="max-w-xs truncate">
                  <a href={r.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary hover:underline">
                    {r.url} <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </TableCell>
                <TableCell><Badge variant="outline" className={`text-[10px] ${scoreBadgeClass(r.performance_score)}`}>{r.performance_score ?? '—'}</Badge></TableCell>
                <TableCell><Badge variant="outline" className={`text-[10px] ${scoreBadgeClass(r.accessibility_score)}`}>{r.accessibility_score ?? '—'}</Badge></TableCell>
                <TableCell><Badge variant="outline" className={`text-[10px] ${scoreBadgeClass(r.best_practices_score)}`}>{r.best_practices_score ?? '—'}</Badge></TableCell>
                <TableCell><Badge variant="outline" className={`text-[10px] ${scoreBadgeClass(r.seo_score)}`}>{r.seo_score ?? '—'}</Badge></TableCell>
                <TableCell className="text-muted-foreground">{r.lcp_ms !== null ? `${(r.lcp_ms / 1000).toFixed(1)}s` : '—'}</TableCell>
                <TableCell className="text-muted-foreground">{r.cls ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

export function GradientStatCard({
  icon: Icon, iconGradient, blobColor, value, label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconGradient: string;
  blobColor: string;
  value: React.ReactNode;
  label: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
      <div className={`pointer-events-none absolute -top-10 -end-8 h-24 w-24 rounded-full ${blobColor} blur-2xl`} />
      <div className="relative flex items-center gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${iconGradient} text-white shadow-md`}>
          <Icon className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0">
          <div className="text-2xl font-bold leading-tight text-foreground">{value}</div>
          <p className="truncate text-xs text-muted-foreground">{label}</p>
        </div>
      </div>
    </div>
  );
}

function BacklinksEmptyState({
  icon: Icon, iconGradient, title, description, action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconGradient: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <Card className="mt-4 overflow-hidden">
      <CardContent className="relative flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-primary/5 to-transparent" />
        <span className={`relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br ${iconGradient} text-white shadow-lg`}>
          <Icon className="h-6 w-6" />
        </span>
        <h3 className="relative text-lg font-semibold">{title}</h3>
        {description && <p className="relative max-w-md text-sm text-muted-foreground">{description}</p>}
        {action && <div className="relative">{action}</div>}
      </CardContent>
    </Card>
  );
}

function addTrackedKeywordErrorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof SeoApiError) {
    if (err.upgradeRequired) return t('seo.rankTracking.limits.module_not_available' as any);
    switch (err.code) {
      case 'module_not_available': return t('seo.rankTracking.limits.module_not_available' as any);
      case 'max_keywords_reached': return t('seo.rankTracking.limits.max_keywords_reached' as any);
      case 'duplicate_keyword': return t('seo.rankTracking.limits.duplicate_keyword' as any);
      case 'site_not_found': return t('seo.errors.siteNotFound' as any);
      default: return t('seo.rankTracking.errors.addFailed' as any);
    }
  }
  return t('seo.rankTracking.errors.addFailed' as any);
}

function positionBadgeClass(position: number | null): string {
  if (position === null) return 'border-border text-muted-foreground';
  if (position <= 3) return 'border-emerald-500/40 text-emerald-500 bg-emerald-500/10';
  if (position <= 10) return 'border-sky-500/40 text-sky-500 bg-sky-500/10';
  if (position <= 30) return 'border-amber-500/40 text-amber-500 bg-amber-500/10';
  return 'border-border text-muted-foreground';
}

function RankHistoryChart({ workspaceId, keywordId }: { workspaceId: string; keywordId: string }) {
  const { t } = useTranslation();
  const { data } = useRankChecks(workspaceId, keywordId);
  const checks = data?.checks || [];
  const points = checks.map((c) => ({ date: new Date(c.checked_at).toLocaleDateString(), position: c.position }));

  if (points.length === 0) {
    return <p className="p-6 text-center text-xs text-muted-foreground">{t('seo.rankTracking.empty.noHistory')}</p>;
  }

  return (
    <div className="h-[180px] w-full p-4" dir="ltr">
      <ResponsiveContainer width="100%" height="100%">
        <ReLineChart data={points} margin={{ top: 6, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
          <YAxis reversed allowDecimals={false} tickLine={false} axisLine={false} width={28} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
          <ReTooltip
            contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 12, fontSize: 12, color: 'hsl(var(--popover-foreground))' }}
            labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
          />
          <Line type="monotone" dataKey="position" stroke="#6366f1" strokeWidth={2.5} dot={{ r: 3 }} connectNulls />
        </ReLineChart>
      </ResponsiveContainer>
    </div>
  );
}

function RankTrackingTab({ workspaceId, siteId }: { workspaceId: string; siteId: string }) {
  const { t } = useTranslation();
  const { data: limitsData } = useRankTrackingLimits(workspaceId);
  const { data: keywordsData, isLoading } = useTrackedKeywords(workspaceId, siteId);
  const addKeyword = useAddTrackedKeyword(workspaceId);
  const removeKeyword = useRemoveTrackedKeyword(workspaceId);
  const keywords = keywordsData?.keywords || [];

  const [newKeyword, setNewKeyword] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const maxKeywords = limitsData?.limits.seo_rank_tracking_max_keywords ?? 0;
  const moduleAvailable = maxKeywords > 0;

  const stats = useMemo(() => {
    const withPosition = keywords.filter((k) => k.last_position !== null);
    const avgPosition = withPosition.length ? Math.round(withPosition.reduce((s, k) => s + (k.last_position || 0), 0) / withPosition.length) : null;
    const inTop10 = keywords.filter((k) => k.last_position !== null && k.last_position <= 10).length;
    return { avgPosition, inTop10 };
  }, [keywords]);

  const handleAdd = () => {
    const keyword = newKeyword.trim();
    if (!keyword) return;
    addKeyword.mutate({ siteId, keyword }, {
      onSuccess: () => setNewKeyword(''),
      onError: (err) => toast.error(addTrackedKeywordErrorMessage(t, err)),
    });
  };

  if (isLoading) return <div className="mt-4"><SkeletonStats count={4} /></div>;

  if (!moduleAvailable) {
    return (
      <BacklinksEmptyState
        icon={Lock} iconGradient="from-slate-500 to-slate-700"
        title={t('seo.rankTracking.empty.notAvailableTitle')}
        description={t('seo.rankTracking.empty.notAvailableDescription')}
      />
    );
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-md shadow-indigo-500/25">
          <Target className="h-4.5 w-4.5" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('seo.rankTracking.watchlistTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('seo.rankTracking.watchlistCount', { count: keywords.length, max: maxKeywords })}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <GradientStatCard icon={Target} iconGradient="from-indigo-500 to-violet-500" blobColor="bg-indigo-500/15" value={keywords.length} label={t('seo.rankTracking.trackedKeywords')} />
        <GradientStatCard icon={TrendingUp} iconGradient="from-emerald-500 to-teal-500" blobColor="bg-emerald-500/15" value={stats.avgPosition ?? '—'} label={t('seo.rankTracking.avgPosition')} />
        <GradientStatCard icon={Sparkles} iconGradient="from-sky-500 to-cyan-500" blobColor="bg-sky-500/15" value={stats.inTop10} label={t('seo.rankTracking.inTop10')} />
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 py-4">
          <Input
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
            placeholder={t('seo.rankTracking.addKeywordPlaceholder')}
            className="max-w-xs"
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          />
          <Button onClick={handleAdd} disabled={addKeyword.isPending || !newKeyword.trim()} className="gap-2">
            <Plus className="h-4 w-4" /> {t('seo.rankTracking.addKeyword')}
          </Button>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('seo.rankTracking.columnKeyword')}</TableHead>
              <TableHead>{t('seo.rankTracking.columnPosition')}</TableHead>
              <TableHead>{t('seo.rankTracking.columnLastChecked')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keywords.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">{t('seo.rankTracking.empty.noKeywords')}</TableCell></TableRow>
            )}
            {keywords.map((k) => (
              <Fragment key={k.id}>
                <TableRow className="cursor-pointer" onClick={() => setExpandedId(expandedId === k.id ? null : k.id)}>
                  <TableCell className="font-medium">{k.keyword}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-[10px] ${positionBadgeClass(k.last_position)}`}>
                      {k.last_position ?? t('seo.rankTracking.notRanked')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{k.last_checked_at ? new Date(k.last_checked_at).toLocaleDateString() : t('seo.rankTracking.pendingFirstCheck')}</TableCell>
                  <TableCell>
                    <Button
                      size="sm" variant="ghost" className="text-destructive"
                      onClick={(e) => { e.stopPropagation(); removeKeyword.mutate(k.id); }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
                {expandedId === k.id && (
                  <TableRow>
                    <TableCell colSpan={4} className="p-0">
                      <RankHistoryChart workspaceId={workspaceId} keywordId={k.id} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
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
