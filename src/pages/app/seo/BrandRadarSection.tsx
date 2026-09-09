/**
 * SEO — Brand Radar. Three real, reused data sources, never fabricated:
 *  - AI Visibility asks the workspace's own configured AI provider (the
 *    same billed path AI Assistant uses) a neutral question per tracked
 *    topic and checks the real response text for brand/competitor mentions.
 *  - Web Visibility calls the same rank-tracking provider adapter Rank
 *    Tracker uses, directly (not through the user's Rank Tracker keyword
 *    list/quota).
 *  - Search Demand reads the workspace's already-connected GSC property.
 * See database/migrations/147_brand_radar.sql's header comment.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Sparkles, Search, Globe2, Users, Settings as SettingsIcon, Plus, Trash2, Play,
  CheckCircle2, XCircle, ChevronDown, ChevronRight, AlertTriangle, Bot,
} from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { SkeletonStats, SkeletonTable } from '@/components/common/Skeletons';
import { PlanLockedOverlay } from '@/components/plan/PlanLockedOverlay';
import { toast } from '@/lib/toast';
import { useSeoSites } from '@/hooks/useSeo';
import {
  useBrandRadarLimits, useBrandRadarSettings, useSaveBrandRadarSettings,
  useBrandRadarTopics, useCreateTopic, useDeleteTopic,
  useAiVisibility, useRunAiVisibility,
  useWebVisibility, useRunWebVisibility,
  useSearchDemand, useBrandRadarOverview, useBrandRadarCompetitors,
} from '@/hooks/useBrandRadar';
import { BrandRadarApiError } from '@/lib/brandRadar-api';
import { GradientStatCard } from './SeoPage';

// ─── Date range (mirrors WebAnalyticsSection.tsx) ──────────────────────

type RangePreset = '7d' | '28d' | '90d';
function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function rangeForPreset(preset: RangePreset): { startDate: string; endDate: string } {
  const end = new Date();
  const days = preset === '7d' ? 7 : preset === '28d' ? 28 : 90;
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { startDate: isoDate(start), endDate: isoDate(end) };
}
function formatCompact(v: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}
function formatDateTime(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function brandRadarErrorMessage(err: unknown, t: (k: any, opts?: Record<string, unknown>) => string): string {
  if (err instanceof BrandRadarApiError) {
    if (err.code === 'frequency_limit') return t('seo.brandRadar.errors.frequency_limit' as any, { hours: err.retryAfterHours ?? 0 } as any);
    if (err.upgradeRequired) return t('seo.brandRadar.errors.limit_reached' as any);
    const key = `seo.brandRadar.errors.${err.code}`;
    const translated = t(key as any);
    if (translated !== key) return translated;
  }
  return t('seo.brandRadar.errors.generic' as any);
}

// ─── Entry point ──────────────────────────────────────────────────────

export function BrandRadarSection({ workspaceId, subsectionKey }: { workspaceId: string; subsectionKey: string }) {
  return (
    <PlanLockedOverlay moduleKey="brand_radar">
      <BrandRadarInner workspaceId={workspaceId} subsectionKey={subsectionKey} />
    </PlanLockedOverlay>
  );
}

function BrandRadarInner({ workspaceId, subsectionKey }: { workspaceId: string; subsectionKey: string }) {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<RangePreset>('28d');
  const range = useMemo(() => rangeForPreset(preset), [preset]);
  const { data: settingsData } = useBrandRadarSettings(workspaceId);
  const hasSettings = !!settingsData?.settings;

  const needsRange = subsectionKey === 'overview' || subsectionKey === 'searchDemand' || subsectionKey === 'competitors';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t('seo.brandRadar.dataSourceNote' as any)}</p>
        {needsRange && (
          <Select value={preset} onValueChange={(v) => setPreset(v as RangePreset)}>
            <SelectTrigger className="h-8 w-[160px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">{t('seo.webAnalytics.range.last7' as any)}</SelectItem>
              <SelectItem value="28d">{t('seo.webAnalytics.range.last28' as any)}</SelectItem>
              <SelectItem value="90d">{t('seo.webAnalytics.range.last90' as any)}</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {!hasSettings && subsectionKey !== 'settings' ? (
        <SetupRequiredEmptyState />
      ) : (
        <BrandRadarDataView workspaceId={workspaceId} subsectionKey={subsectionKey} range={range} />
      )}
    </div>
  );
}

function BrandRadarDataView({ workspaceId, subsectionKey, range }: { workspaceId: string; subsectionKey: string; range: { startDate: string; endDate: string } }) {
  switch (subsectionKey) {
    case 'overview': return <OverviewView workspaceId={workspaceId} range={range} />;
    case 'aiVisibility': return <AiVisibilityView workspaceId={workspaceId} />;
    case 'searchDemand': return <SearchDemandView workspaceId={workspaceId} range={range} />;
    case 'webVisibility': return <WebVisibilityView workspaceId={workspaceId} />;
    case 'competitors': return <CompetitorsView workspaceId={workspaceId} range={range} />;
    case 'settings': return <SettingsView key={workspaceId} workspaceId={workspaceId} />;
    default: return null;
  }
}

// ─── Shared ─────────────────────────────────────────────────────────────

function SetupRequiredEmptyState() {
  const { t } = useTranslation();
  const wsPath = useWorkspacePath();
  return (
    <Card className="overflow-hidden">
      <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Sparkles className="h-5 w-5" />
        </span>
        <h3 className="text-base font-semibold">{t('seo.brandRadar.empty.setupTitle' as any)}</h3>
        <p className="max-w-md text-sm text-muted-foreground">{t('seo.brandRadar.empty.setupDescription' as any)}</p>
        <Button asChild size="sm" className="gap-1.5">
          <Link to={wsPath('/seo/brand-radar/settings')}><SettingsIcon className="h-3.5 w-3.5" />{t('seo.nav.item.brandSettings' as any)}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function ReportCard({ title, description, children, action }: { title: string; description?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// ─── Overview ───────────────────────────────────────────────────────────

function OverviewView({ workspaceId, range }: { workspaceId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const wsPath = useWorkspacePath();
  const { data, isLoading } = useBrandRadarOverview(workspaceId, range);

  if (isLoading) return <SkeletonStats count={4} />;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <GradientStatCard icon={Sparkles} iconGradient="from-fuchsia-500 to-purple-500" blobColor="bg-fuchsia-500/15" value={data.aiVisibility.mentionRate !== null ? `${data.aiVisibility.mentionRate}%` : '—'} label={t('seo.brandRadar.stat.aiMentionRate' as any)} />
        <GradientStatCard icon={Globe2} iconGradient="from-indigo-500 to-violet-500" blobColor="bg-indigo-500/15" value={data.webVisibility.ownPosition ?? '—'} label={t('seo.brandRadar.stat.webPosition' as any)} />
        <GradientStatCard icon={Search} iconGradient="from-sky-500 to-cyan-500" blobColor="bg-sky-500/15" value={formatCompact(data.searchDemand.clicks)} label={t('seo.brandRadar.stat.searchClicks' as any)} />
        <GradientStatCard icon={Users} iconGradient="from-amber-500 to-orange-500" blobColor="bg-amber-500/15" value={data.competitorCount} label={t('seo.brandRadar.stat.competitorsTracked' as any)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-base">{t('seo.nav.item.aiVisibility' as any)}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">{t('seo.brandRadar.overview.aiSummary' as any, { count: data.aiVisibility.totalChecks, topics: data.topicCount } as any)}</p>
            <Button asChild variant="outline" size="sm" className="self-start gap-1.5"><Link to={wsPath('/seo/brand-radar/aiVisibility')}>{t('seo.brandRadar.overview.viewDetails' as any)}<ChevronRight className="h-3.5 w-3.5" /></Link></Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t('seo.nav.item.webVisibility' as any)}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">{data.webVisibility.available ? t('seo.brandRadar.overview.webSummary' as any, { position: data.webVisibility.ownPosition ?? '—' } as any) : t('seo.brandRadar.webVisibility.notConfigured' as any)}</p>
            <Button asChild variant="outline" size="sm" className="self-start gap-1.5"><Link to={wsPath('/seo/brand-radar/webVisibility')}>{t('seo.brandRadar.overview.viewDetails' as any)}<ChevronRight className="h-3.5 w-3.5" /></Link></Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t('seo.nav.item.searchDemand' as any)}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">{data.searchDemand.available ? t('seo.brandRadar.overview.demandSummary' as any, { clicks: formatCompact(data.searchDemand.clicks), impressions: formatCompact(data.searchDemand.impressions) } as any) : t('seo.brandRadar.searchDemand.notConnected' as any)}</p>
            <Button asChild variant="outline" size="sm" className="self-start gap-1.5"><Link to={wsPath('/seo/brand-radar/searchDemand')}>{t('seo.brandRadar.overview.viewDetails' as any)}<ChevronRight className="h-3.5 w-3.5" /></Link></Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── AI Visibility ──────────────────────────────────────────────────────

function AiVisibilityCard({ row }: { row: import('@/lib/brandRadar-api').AiVisibilityCheckResult }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-3 text-start">
        {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{row.topicLabel}</span>
            {row.brandMentioned ? (
              <Badge className="gap-1 bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400"><CheckCircle2 className="h-3 w-3" />{t('seo.brandRadar.aiVisibility.mentioned' as any)}{row.brandMentionPosition ? ` #${row.brandMentionPosition}` : ''}</Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-muted-foreground"><XCircle className="h-3 w-3" />{t('seo.brandRadar.aiVisibility.notMentioned' as any)}</Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{row.prompt}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>{row.provider} · {row.model}</span>
            <span>·</span>
            <span>{formatDateTime(row.createdAt)}</span>
            {row.competitorsMentioned.length > 0 && (
              <>
                <span>·</span>
                <span className="flex flex-wrap gap-1">
                  {row.competitorsMentioned.map((c) => <Badge key={c} variant="outline" className="text-[10px]">{c}</Badge>)}
                </span>
              </>
            )}
          </div>
        </div>
      </button>
      {open && (
        <div className="mt-3 whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs leading-relaxed text-foreground">{row.responseText}</div>
      )}
    </div>
  );
}

function AiVisibilityView({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const wsPath = useWorkspacePath();
  const { data: topicsData } = useBrandRadarTopics(workspaceId);
  const { data, isLoading } = useAiVisibility(workspaceId);
  const runNow = useRunAiVisibility(workspaceId);
  const topics = topicsData?.topics || [];
  const rows = data?.rows || [];

  const handleRun = async () => {
    try {
      const result = await runNow.mutateAsync();
      toast.success(t('seo.brandRadar.aiVisibility.runComplete' as any, { count: result.results.length } as any));
      if (result.errors.length > 0) toast.error(t('seo.brandRadar.aiVisibility.runPartialErrors' as any, { count: result.errors.length } as any));
    } catch (err) {
      toast.error(brandRadarErrorMessage(err, t));
    }
  };

  const runButton = (
    <Button size="sm" onClick={handleRun} disabled={runNow.isPending || topics.length === 0} className="gap-1.5">
      <Play className="h-3.5 w-3.5" />{runNow.isPending ? t('seo.brandRadar.running' as any) : t('seo.brandRadar.runChecksNow' as any)}
    </Button>
  );

  if (topics.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Bot className="h-5 w-5" /></span>
          <h3 className="text-base font-semibold">{t('seo.brandRadar.aiVisibility.noTopicsTitle' as any)}</h3>
          <p className="max-w-md text-sm text-muted-foreground">{t('seo.brandRadar.aiVisibility.noTopicsDescription' as any)}</p>
          <Button asChild size="sm" className="gap-1.5"><Link to={wsPath('/seo/brand-radar/settings')}><Plus className="h-3.5 w-3.5" />{t('seo.brandRadar.aiVisibility.addTopics' as any)}</Link></Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <ReportCard title={t('seo.nav.item.aiVisibility' as any)} description={t('seo.brandRadar.aiVisibility.description' as any)} action={runButton}>
      {isLoading ? (
        <SkeletonTable rows={4} columns={1} />
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.brandRadar.aiVisibility.empty' as any)}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => <AiVisibilityCard key={r.id} row={r} />)}
        </div>
      )}
    </ReportCard>
  );
}

// ─── Web Visibility ─────────────────────────────────────────────────────

function WebVisibilityView({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useWebVisibility(workspaceId);
  const runNow = useRunWebVisibility(workspaceId);
  const rows = data?.rows || [];

  const handleRun = async () => {
    try {
      const result = await runNow.mutateAsync();
      toast.success(t('seo.brandRadar.webVisibility.runComplete' as any, { count: result.results.length } as any));
      if (result.errors.length > 0) toast.error(t('seo.brandRadar.webVisibility.runPartialErrors' as any, { count: result.errors.length } as any));
    } catch (err) {
      toast.error(brandRadarErrorMessage(err, t));
    }
  };

  if (!isLoading && data && !data.available) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500"><AlertTriangle className="h-5 w-5" /></span>
          <h3 className="text-base font-semibold">{t('seo.brandRadar.webVisibility.notConfiguredTitle' as any)}</h3>
          <p className="max-w-md text-sm text-muted-foreground">{t('seo.brandRadar.webVisibility.notConfigured' as any)}</p>
        </CardContent>
      </Card>
    );
  }

  const runButton = (
    <Button size="sm" onClick={handleRun} disabled={runNow.isPending} className="gap-1.5">
      <Play className="h-3.5 w-3.5" />{runNow.isPending ? t('seo.brandRadar.running' as any) : t('seo.brandRadar.runChecksNow' as any)}
    </Button>
  );

  return (
    <ReportCard title={t('seo.nav.item.webVisibility' as any)} description={t('seo.brandRadar.webVisibility.description' as any)} action={runButton}>
      {isLoading ? (
        <SkeletonTable rows={4} columns={4} />
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.brandRadar.webVisibility.empty' as any)}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('seo.brandRadar.column.term' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.brandRadar.column.position' as any)}</TableHead>
              <TableHead>{t('seo.brandRadar.column.rankingUrl' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.brandRadar.column.checkedAt' as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-2">
                    {r.term}
                    {r.isOwnBrand && <Badge variant="outline" className="text-[10px]">{t('seo.brandRadar.ownBrand' as any)}</Badge>}
                  </span>
                </TableCell>
                <TableCell className="text-end tabular-nums">{r.position ?? '—'}</TableCell>
                <TableCell className="max-w-[280px] truncate text-xs text-muted-foreground" title={r.rankingUrl || ''}>{r.rankingUrl || '—'}</TableCell>
                <TableCell className="text-end text-xs text-muted-foreground">{formatDateTime(r.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </ReportCard>
  );
}

// ─── Search Demand ──────────────────────────────────────────────────────

function SearchDemandView({ workspaceId, range }: { workspaceId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const wsPath = useWorkspacePath();
  const { data, isLoading } = useSearchDemand(workspaceId, range);

  if (!isLoading && data && !data.available) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500"><Search className="h-5 w-5" /></span>
          <h3 className="text-base font-semibold">{t('seo.brandRadar.searchDemand.notConnectedTitle' as any)}</h3>
          <p className="max-w-md text-sm text-muted-foreground">{t('seo.brandRadar.searchDemand.notConnected' as any)}</p>
          <Button asChild size="sm" className="gap-1.5"><Link to={wsPath('/seo/gsc-insights/overview')}>{t('seo.nav.section.gscInsights' as any)}</Link></Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <ReportCard title={t('seo.nav.item.searchDemand' as any)} description={t('seo.brandRadar.searchDemand.description' as any)}>
      {isLoading ? (
        <SkeletonTable rows={4} columns={5} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('seo.brandRadar.column.term' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.brandRadar.column.clicks' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.brandRadar.column.impressions' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.brandRadar.column.ctr' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.brandRadar.column.avgPosition' as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.rows || []).map((r) => (
              <TableRow key={r.term}>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-2">
                    {r.term}
                    {r.isOwnBrand && <Badge variant="outline" className="text-[10px]">{t('seo.brandRadar.ownBrand' as any)}</Badge>}
                  </span>
                </TableCell>
                <TableCell className="text-end tabular-nums">{formatCompact(r.clicks)}</TableCell>
                <TableCell className="text-end tabular-nums text-muted-foreground">{formatCompact(r.impressions)}</TableCell>
                <TableCell className="text-end tabular-nums text-muted-foreground">{r.ctr}%</TableCell>
                <TableCell className="text-end tabular-nums text-muted-foreground">{r.avgPosition || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </ReportCard>
  );
}

// ─── Competitors ────────────────────────────────────────────────────────

function CompetitorsView({ workspaceId, range }: { workspaceId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const { data, isLoading } = useBrandRadarCompetitors(workspaceId, range);
  const rows = data?.rows || [];

  return (
    <ReportCard title={t('seo.nav.item.competitors' as any)} description={t('seo.brandRadar.competitors.description' as any)}>
      {isLoading ? (
        <SkeletonTable rows={4} columns={4} />
      ) : rows.length <= 1 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.brandRadar.competitors.empty' as any)}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('seo.brandRadar.column.name' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.brandRadar.column.aiMentionRate' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.brandRadar.column.position' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.brandRadar.column.clicks' as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.name}>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-2">
                    {r.name}
                    {r.isOwnBrand && <Badge variant="outline" className="text-[10px]">{t('seo.brandRadar.ownBrand' as any)}</Badge>}
                  </span>
                </TableCell>
                <TableCell className="text-end tabular-nums">{r.aiMentionRate !== null ? `${r.aiMentionRate}%` : '—'}</TableCell>
                <TableCell className="text-end tabular-nums">{r.webPosition ?? '—'}</TableCell>
                <TableCell className="text-end tabular-nums text-muted-foreground">{r.searchClicks !== null ? formatCompact(r.searchClicks) : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </ReportCard>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────

function SettingsView({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const { data: settingsData } = useBrandRadarSettings(workspaceId);
  const { data: limitsData } = useBrandRadarLimits(workspaceId);
  const { data: sitesData } = useSeoSites(workspaceId);
  const saveSettings = useSaveBrandRadarSettings(workspaceId);

  const settings = settingsData?.settings;
  const sites = sitesData?.sites || [];
  const maxCompetitors = limitsData?.limits.brand_radar_max_competitors ?? 0;

  const [brandName, setBrandName] = useState(settings?.brandName || '');
  const [competitorInput, setCompetitorInput] = useState('');
  const [competitorNames, setCompetitorNames] = useState<string[]>(settings?.competitorNames || []);
  const [siteId, setSiteId] = useState<string | undefined>(settings?.siteId || undefined);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (initialized || !settings) return;
    setBrandName(settings.brandName);
    setCompetitorNames(settings.competitorNames);
    setSiteId(settings.siteId || undefined);
    setInitialized(true);
  }, [initialized, settings]);

  const addCompetitor = () => {
    const name = competitorInput.trim();
    if (!name || competitorNames.includes(name) || competitorNames.length >= maxCompetitors) return;
    setCompetitorNames((prev) => [...prev, name]);
    setCompetitorInput('');
  };
  const removeCompetitor = (name: string) => setCompetitorNames((prev) => prev.filter((c) => c !== name));

  const handleSave = async () => {
    try {
      await saveSettings.mutateAsync({ brandName, competitorNames, siteId: siteId || null });
      toast.success(t('seo.brandRadar.settings.saved' as any));
    } catch (err) {
      toast.error(brandRadarErrorMessage(err, t));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('seo.brandRadar.settings.brandTitle' as any)}</CardTitle>
          <CardDescription>{t('seo.brandRadar.settings.brandDescription' as any)}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('seo.brandRadar.settings.brandNameLabel' as any)}</label>
            <Input value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder={t('seo.brandRadar.settings.brandNamePlaceholder' as any)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('seo.brandRadar.settings.competitorsLabel' as any, { current: competitorNames.length, max: maxCompetitors } as any)}</label>
            <div className="flex flex-wrap gap-1.5">
              {competitorNames.map((c) => (
                <Badge key={c} variant="outline" className="gap-1 pe-1">
                  {c}
                  <button type="button" onClick={() => removeCompetitor(c)} className="ms-1 rounded-full p-0.5 hover:bg-muted"><Trash2 className="h-3 w-3" /></button>
                </Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                className="h-8 text-xs"
                value={competitorInput}
                onChange={(e) => setCompetitorInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCompetitor(); } }}
                placeholder={t('seo.brandRadar.settings.competitorPlaceholder' as any)}
                disabled={competitorNames.length >= maxCompetitors}
              />
              <Button size="sm" variant="outline" onClick={addCompetitor} disabled={!competitorInput.trim() || competitorNames.length >= maxCompetitors}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('seo.brandRadar.settings.siteLabel' as any)}</label>
            <Select value={siteId} onValueChange={setSiteId}>
              <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={t('seo.brandRadar.settings.sitePlaceholder' as any)} /></SelectTrigger>
              <SelectContent>
                {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.domain}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t('seo.brandRadar.settings.siteHint' as any)}</p>
          </div>

          <Button onClick={handleSave} disabled={saveSettings.isPending || !brandName.trim()} className="self-start">
            {t('seo.brandRadar.settings.save' as any)}
          </Button>
        </CardContent>
      </Card>

      <TopicsSettingsCard workspaceId={workspaceId} maxTopics={limitsData?.limits.brand_radar_max_topics ?? 0} />
    </div>
  );
}

function TopicsSettingsCard({ workspaceId, maxTopics }: { workspaceId: string; maxTopics: number }) {
  const { t } = useTranslation();
  const { data, isLoading } = useBrandRadarTopics(workspaceId);
  const deleteTopic = useDeleteTopic(workspaceId);
  const topics = data?.topics || [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">{t('seo.brandRadar.settings.topicsTitle' as any)}</CardTitle>
          <CardDescription>{t('seo.brandRadar.settings.topicsDescription' as any, { current: topics.length, max: maxTopics } as any)}</CardDescription>
        </div>
        <CreateTopicDialog workspaceId={workspaceId} disabled={topics.length >= maxTopics} />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <SkeletonTable rows={3} columns={2} />
        ) : topics.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('seo.brandRadar.settings.noTopics' as any)}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {topics.map((topic) => (
              <div key={topic.id} className="flex items-start gap-2 rounded-lg border border-border/60 p-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{topic.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{topic.prompt}</p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('seo.brandRadar.settings.deleteTopicConfirmTitle' as any)}</AlertDialogTitle>
                      <AlertDialogDescription>{t('seo.brandRadar.settings.deleteTopicConfirmDescription' as any)}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('seo.gsc.disconnectConfirm.cancel' as any)}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => deleteTopic.mutate(topic.id)}>{t('seo.botAnalytics.import.delete' as any)}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CreateTopicDialog({ workspaceId, disabled }: { workspaceId: string; disabled: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [prompt, setPrompt] = useState('');
  const createTopic = useCreateTopic(workspaceId);

  const handleCreate = async () => {
    try {
      await createTopic.mutateAsync({ label, prompt });
      toast.success(t('seo.brandRadar.settings.topicCreated' as any));
      setOpen(false);
      setLabel('');
      setPrompt('');
    } catch (err) {
      toast.error(brandRadarErrorMessage(err, t));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5" disabled={disabled}><Plus className="h-3.5 w-3.5" />{t('seo.brandRadar.settings.addTopic' as any)}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t('seo.brandRadar.settings.addTopic' as any)}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('seo.brandRadar.settings.topicLabelLabel' as any)}</label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('seo.brandRadar.settings.topicLabelPlaceholder' as any)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('seo.brandRadar.settings.topicPromptLabel' as any)}</label>
            <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('seo.brandRadar.settings.topicPromptPlaceholder' as any)} rows={3} />
            <p className="text-[11px] text-muted-foreground">{t('seo.brandRadar.settings.topicPromptHint' as any)}</p>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleCreate} disabled={createTopic.isPending || !label.trim() || !prompt.trim()}>{t('seo.brandRadar.settings.save' as any)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
