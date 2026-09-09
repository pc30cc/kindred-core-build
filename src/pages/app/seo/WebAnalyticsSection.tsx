/**
 * SEO — Web Analytics. Unlike the other SEO tools, this reads data that was
 * ALREADY being collected: the chat widget's tracking snippet
 * (public/widget/loader.js) writes a session + page view on every page load
 * regardless of whether the visitor opens chat (server/routes/widget.ts's
 * POST /track). This section is purely a new reporting layer over that data
 * — see database/migrations/145_web_analytics.sql's header comment. Custom
 * events (window.gsAnalytics.track(...)) are the one genuinely new signal.
 *
 * All 21 leaves across the six report groups (Overview, Traffic Sources,
 * Pages, Geography, Browsers & systems, Events) render here, sharing one
 * workspace-wide date-range control and two generic table components
 * (BreakdownTable for every "group by X, count sessions" report,
 * PagesTable for every URL-keyed report).
 */
import { useMemo, useState } from 'react';
import {
  Users, Eye, Layers, TrendingUp, Globe2, Link2, Megaphone, FileText, LogIn, LogOut,
  Copy, AlertTriangle, Network, Sparkles, Flag, Building2, Languages, Chrome, Monitor,
  Smartphone, Zap, Filter, Plus, Trash2, ChevronRight, ChevronDown,
} from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { SkeletonStats, SkeletonTable } from '@/components/common/Skeletons';
import { PlanLockedOverlay } from '@/components/plan/PlanLockedOverlay';
import { toast } from '@/lib/toast';
import {
  useWebAnalyticsOverview, useWebAnalyticsTrafficSources, useWebAnalyticsGeography,
  useWebAnalyticsBrowsersSystems, useWebAnalyticsPages, useWebAnalyticsClonedPages,
  useWebAnalyticsSiteStructure, useWebAnalyticsPossible404s, useWebAnalyticsTrackedEvents,
  useWebAnalyticsEventPropertyKeys, useWebAnalyticsEventPropertyBreakdown,
  useFunnels, useCreateFunnel, useDeleteFunnel, useFunnelResults, useWebAnalyticsLimits,
} from '@/hooks/useWebAnalytics';
import {
  WebAnalyticsApiError, type BreakdownRow, type SiteStructureNode, type FunnelStep,
  type TrafficSourceDimension, type GeographyDimension, type BrowsersSystemsDimension,
} from '@/lib/webAnalytics-api';
import { GradientStatCard } from './SeoPage';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip,
} from 'recharts';

// ─── Date range ─────────────────────────────────────────────────────────

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

function webAnalyticsErrorMessage(err: unknown, t: (k: any) => string): string {
  if (err instanceof WebAnalyticsApiError) {
    if (err.upgradeRequired) return t('seo.webAnalytics.errors.limit_reached' as any);
    const key = `seo.webAnalytics.errors.${err.code}`;
    const translated = t(key as any);
    if (translated !== key) return translated;
  }
  return t('seo.webAnalytics.errors.generic' as any);
}

// ─── Entry point ──────────────────────────────────────────────────────────

export function WebAnalyticsSection({ workspaceId, subsectionKey }: { workspaceId: string; subsectionKey: string }) {
  return (
    <PlanLockedOverlay moduleKey="web_analytics">
      <WebAnalyticsInner workspaceId={workspaceId} subsectionKey={subsectionKey} />
    </PlanLockedOverlay>
  );
}

function WebAnalyticsInner({ workspaceId, subsectionKey }: { workspaceId: string; subsectionKey: string }) {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<RangePreset>('28d');
  const range = useMemo(() => rangeForPreset(preset), [preset]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">{t('nav.webAnalytics' as any)}</h1>
          <p className="mt-1 text-xs text-muted-foreground">{t('seo.webAnalytics.dataSourceNote' as any)}</p>
        </div>
        <Select value={preset} onValueChange={(v) => setPreset(v as RangePreset)}>
          <SelectTrigger className="h-8 w-[160px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">{t('seo.webAnalytics.range.last7' as any)}</SelectItem>
            <SelectItem value="28d">{t('seo.webAnalytics.range.last28' as any)}</SelectItem>
            <SelectItem value="90d">{t('seo.webAnalytics.range.last90' as any)}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <WebAnalyticsDataView workspaceId={workspaceId} subsectionKey={subsectionKey} range={range} />
    </div>
  );
}

function WebAnalyticsDataView({ workspaceId, subsectionKey, range }: { workspaceId: string; subsectionKey: string; range: { startDate: string; endDate: string } }) {
  switch (subsectionKey) {
    case 'overview': return <OverviewView workspaceId={workspaceId} range={range} />;
    case 'channels': return <TrafficSourceView workspaceId={workspaceId} range={range} dimension="channel" />;
    case 'sources': return <TrafficSourceView workspaceId={workspaceId} range={range} dimension="source" />;
    case 'campaigns': return <TrafficSourceView workspaceId={workspaceId} range={range} dimension="campaign" />;
    case 'topPages': return <PagesView workspaceId={workspaceId} range={range} kind="top" />;
    case 'entryPages': return <PagesView workspaceId={workspaceId} range={range} kind="entry" />;
    case 'exitPages': return <PagesView workspaceId={workspaceId} range={range} kind="exit" />;
    case 'new': return <PagesView workspaceId={workspaceId} range={range} kind="new" />;
    case 'clonedPages': return <ClonedPagesView workspaceId={workspaceId} range={range} />;
    case 'possible404': return <Possible404View workspaceId={workspaceId} range={range} />;
    case 'siteStructure': return <SiteStructureView workspaceId={workspaceId} range={range} />;
    case 'continents': return <GeographyView workspaceId={workspaceId} range={range} dimension="continent" />;
    case 'countries': return <GeographyView workspaceId={workspaceId} range={range} dimension="country" />;
    case 'cities': return <GeographyView workspaceId={workspaceId} range={range} dimension="city" />;
    case 'languages': return <GeographyView workspaceId={workspaceId} range={range} dimension="language" />;
    case 'browsers': return <BrowsersSystemsView workspaceId={workspaceId} range={range} dimension="browser" />;
    case 'operatingSystems': return <BrowsersSystemsView workspaceId={workspaceId} range={range} dimension="os" />;
    case 'devices': return <BrowsersSystemsView workspaceId={workspaceId} range={range} dimension="device" />;
    case 'trackedEvents': return <TrackedEventsView workspaceId={workspaceId} range={range} />;
    case 'funnels': return <FunnelsView workspaceId={workspaceId} range={range} />;
    case 'eventProperties': return <EventPropertiesView workspaceId={workspaceId} range={range} />;
    default: return null;
  }
}

// ─── Shared: breakdown table (key/label + sessions + pageviews, bar chart) ─

function BreakdownTable({ rows, isLoading, keyLabel, icon: Icon }: { rows: BreakdownRow[]; isLoading: boolean; keyLabel: string; icon: React.ComponentType<{ className?: string }> }) {
  const { t } = useTranslation();
  if (isLoading) return <SkeletonTable rows={8} columns={3} />;
  if (rows.length === 0) return <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.webAnalytics.empty.noData' as any)}</p>;
  const max = Math.max(...rows.map((r) => r.sessions), 1);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{keyLabel}</TableHead>
          <TableHead className="text-end">{t('seo.webAnalytics.column.sessions' as any)}</TableHead>
          <TableHead className="text-end">{t('seo.webAnalytics.column.pageviews' as any)}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            <TableCell className="max-w-[280px]">
              <div className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium" title={r.label}>{r.label}</span>
              </div>
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${(r.sessions / max) * 100}%` }} />
              </div>
            </TableCell>
            <TableCell className="text-end tabular-nums">{formatCompact(r.sessions)}</TableCell>
            <TableCell className="text-end tabular-nums text-muted-foreground">{formatCompact(r.pageviews)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ReportCard({ title, description, truncated, children }: { title: string; description?: string; truncated?: boolean; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {truncated && <Badge variant="outline" className="mt-1 w-fit gap-1 text-[10px] text-amber-600"><AlertTriangle className="h-3 w-3" />{t('seo.webAnalytics.truncatedNotice' as any)}</Badge>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// ─── Overview ──────────────────────────────────────────────────────────

function OverviewChartTooltip({ active, payload, label }: any) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border/60 bg-popover px-3 py-2 shadow-lg">
      <p className="mb-1 text-xs font-medium text-foreground">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-xs">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-muted-foreground">{p.dataKey === 'sessions' ? t('seo.webAnalytics.column.sessions' as any) : t('seo.webAnalytics.column.pageviews' as any)}</span>
          <span className="ms-auto font-semibold tabular-nums text-foreground">{formatCompact(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function OverviewView({ workspaceId, range }: { workspaceId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const { data, isLoading } = useWebAnalyticsOverview(workspaceId, range);

  if (isLoading) return <SkeletonStats count={4} />;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <GradientStatCard icon={Users} iconGradient="from-indigo-500 to-violet-500" blobColor="bg-indigo-500/15" value={formatCompact(data.sessions)} label={t('seo.webAnalytics.stat.sessions' as any)} />
        <GradientStatCard icon={Eye} iconGradient="from-sky-500 to-cyan-500" blobColor="bg-sky-500/15" value={formatCompact(data.pageviews)} label={t('seo.webAnalytics.stat.pageviews' as any)} />
        <GradientStatCard icon={Layers} iconGradient="from-emerald-500 to-teal-500" blobColor="bg-emerald-500/15" value={data.avgPagesPerSession} label={t('seo.webAnalytics.stat.avgPagesPerSession' as any)} />
        <GradientStatCard icon={TrendingUp} iconGradient="from-amber-500 to-orange-500" blobColor="bg-amber-500/15" value={formatCompact(data.uniqueVisitors)} label={t('seo.webAnalytics.stat.uniqueVisitors' as any)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('seo.webAnalytics.overview.trendTitle' as any)}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="waSessionsFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.32} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="waPageviewsFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/40" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} tickFormatter={(d: string) => d.slice(5)} />
                <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={40} />
                <ReTooltip content={<OverviewChartTooltip />} />
                <Area type="monotone" dataKey="pageviews" stroke="#38bdf8" strokeWidth={2} fill="url(#waPageviewsFill)" />
                <Area type="monotone" dataKey="sessions" stroke="hsl(var(--primary))" strokeWidth={2.5} fill="url(#waSessionsFill)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 flex items-center justify-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-primary" />{t('seo.webAnalytics.column.sessions' as any)}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky-400" />{t('seo.webAnalytics.column.pageviews' as any)}</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">{t('seo.nav.item.trafficSources' as any)}</CardTitle></CardHeader>
          <CardContent>
            {data.topChannels.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('seo.webAnalytics.empty.noData' as any)}</p>
            ) : (
              <div className="space-y-1.5">
                {data.topChannels.map((c) => (
                  <div key={c.key} dir="ltr" className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate text-left text-foreground">{c.label}</span>
                    <span className="tabular-nums text-muted-foreground">{formatCompact(c.sessions)}</span>
                  </div>

                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t('seo.nav.item.topPages' as any)}</CardTitle></CardHeader>
          <CardContent>
            {data.topPages.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('seo.webAnalytics.empty.noData' as any)}</p>
            ) : (
              <div className="space-y-1.5">
                {data.topPages.map((p) => (
                  <div key={p.path} dir="ltr" className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate text-left text-foreground" title={p.path}>{p.path}</span>
                    <span className="tabular-nums text-muted-foreground">{formatCompact(p.views)}</span>
                  </div>

                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Traffic sources / Geography / Browsers & systems ───────────────────

const DIMENSION_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  channel: Filter, source: Link2, campaign: Megaphone,
  continent: Globe2, country: Flag, city: Building2, language: Languages,
  browser: Chrome, os: Monitor, device: Smartphone,
};

const TRAFFIC_SOURCE_TITLE_KEY: Record<TrafficSourceDimension, string> = {
  channel: 'seo.nav.item.channels',
  source: 'seo.nav.item.sources',
  campaign: 'seo.nav.item.campaigns',
};
const TRAFFIC_SOURCE_COLUMN_KEY: Record<TrafficSourceDimension, string> = {
  channel: 'seo.nav.item.channels',
  source: 'seo.webAnalytics.column.source',
  campaign: 'seo.webAnalytics.column.campaign',
};

function TrafficSourceView({ workspaceId, range, dimension }: { workspaceId: string; range: { startDate: string; endDate: string }; dimension: TrafficSourceDimension }) {
  const { t } = useTranslation();
  const { data, isLoading } = useWebAnalyticsTrafficSources(workspaceId, dimension, range);
  return (
    <ReportCard title={t(TRAFFIC_SOURCE_TITLE_KEY[dimension] as any)} truncated={data?.truncated}>
      <BreakdownTable rows={data?.rows || []} isLoading={isLoading} keyLabel={t(TRAFFIC_SOURCE_COLUMN_KEY[dimension] as any)} icon={DIMENSION_ICON[dimension]} />
    </ReportCard>
  );
}

function GeographyView({ workspaceId, range, dimension }: { workspaceId: string; range: { startDate: string; endDate: string }; dimension: GeographyDimension }) {
  const { t } = useTranslation();
  const { data, isLoading } = useWebAnalyticsGeography(workspaceId, dimension, range);
  const labelKey = `seo.webAnalytics.column.${dimension}`;
  return (
    <ReportCard title={t(labelKey as any)} truncated={data?.truncated}>
      <BreakdownTable rows={data?.rows || []} isLoading={isLoading} keyLabel={t(labelKey as any)} icon={DIMENSION_ICON[dimension]} />
    </ReportCard>
  );
}

function BrowsersSystemsView({ workspaceId, range, dimension }: { workspaceId: string; range: { startDate: string; endDate: string }; dimension: BrowsersSystemsDimension }) {
  const { t } = useTranslation();
  const { data, isLoading } = useWebAnalyticsBrowsersSystems(workspaceId, dimension, range);
  const labelKey = dimension === 'browser' ? 'seo.webAnalytics.column.browser' : dimension === 'os' ? 'seo.webAnalytics.column.os' : 'seo.webAnalytics.column.device';
  return (
    <ReportCard title={t(labelKey as any)} truncated={data?.truncated}>
      <BreakdownTable rows={data?.rows || []} isLoading={isLoading} keyLabel={t(labelKey as any)} icon={DIMENSION_ICON[dimension]} />
    </ReportCard>
  );
}

// ─── Pages ────────────────────────────────────────────────────────────

function PagesView({ workspaceId, range, kind }: { workspaceId: string; range: { startDate: string; endDate: string }; kind: 'top' | 'entry' | 'exit' | 'new' }) {
  const { t } = useTranslation();
  const { data, isLoading } = useWebAnalyticsPages(workspaceId, kind, range);
  const icon = kind === 'entry' ? LogIn : kind === 'exit' ? LogOut : kind === 'new' ? Sparkles : FileText;
  const Icon = icon;

  return (
    <ReportCard title={t(`seo.nav.item.${kind === 'top' ? 'topPages' : kind === 'entry' ? 'entryPages' : kind === 'exit' ? 'exitPages' : 'new'}` as any)} truncated={data?.truncated}>
      {isLoading ? (
        <SkeletonTable rows={8} columns={2} />
      ) : (data?.rows.length || 0) === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.webAnalytics.empty.noData' as any)}</p>
      ) : (
        <Table dir="ltr">
          <TableHeader>
            <TableRow>
              <TableHead className="text-left">{t('seo.webAnalytics.column.page' as any)}</TableHead>
              <TableHead className="text-right">{t('seo.webAnalytics.column.views' as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.rows || []).map((r) => (
              <TableRow key={r.path}>
                <TableCell className="max-w-[420px] text-left">
                  <div className="flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium" title={r.path}>{r.path}</span>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCompact(r.views)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

      )}
    </ReportCard>
  );
}

function ClonedPagesView({ workspaceId, range }: { workspaceId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const { data, isLoading } = useWebAnalyticsClonedPages(workspaceId, range);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('seo.nav.item.clonedPages' as any)}</CardTitle>
        <CardDescription>{t('seo.webAnalytics.clonedPages.description' as any)}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <SkeletonTable rows={4} columns={2} />
        ) : (data?.rows.length || 0) === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.webAnalytics.clonedPages.empty' as any)}</p>
        ) : (
          <div className="space-y-4">
            {(data?.rows || []).map((group) => (
              <div key={group.normalizedPath} className="rounded-lg border border-border/60 p-3">
                <div dir="ltr" className="mb-2 flex items-center gap-2 text-left">
                  <Copy className="h-3.5 w-3.5 text-amber-500" />
                  <span className="font-medium">{group.normalizedPath}</span>
                  <Badge variant="outline" className="ms-auto text-[10px]">{formatCompact(group.totalViews)} {t('seo.webAnalytics.column.views' as any)}</Badge>
                </div>
                <div className="space-y-1">
                  {group.variants.map((v) => (
                    <div key={v.url} dir="ltr" className="flex items-center justify-between gap-3 ps-5 text-left text-xs text-muted-foreground">
                      <span className="truncate font-mono">{v.url}</span>
                      <span className="tabular-nums">{formatCompact(v.views)}</span>
                    </div>
                  ))}
                </div>
              </div>

            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Possible404View({ workspaceId, range }: { workspaceId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const { data, isLoading } = useWebAnalyticsPossible404s(workspaceId, range);

  if (isLoading) return <SkeletonTable rows={4} columns={2} />;

  if (!data?.available) {
    return (
      <Card className="overflow-hidden">
        <CardContent className="flex flex-col items-center justify-center gap-3 py-14 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <h3 className="text-base font-semibold">{t('seo.webAnalytics.possible404.needsCrawlTitle' as any)}</h3>
          <p className="max-w-md text-sm text-muted-foreground">{t('seo.webAnalytics.possible404.needsCrawlDescription' as any)}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('seo.nav.item.possible404' as any)}</CardTitle>
        <CardDescription>{t('seo.webAnalytics.possible404.description' as any)}</CardDescription>
      </CardHeader>
      <CardContent>
        {data.rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.webAnalytics.possible404.empty' as any)}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('seo.webAnalytics.column.page' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.webAnalytics.column.status' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.webAnalytics.column.views' as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((r) => (
                <TableRow key={r.path}>
                  <TableCell className="max-w-[360px] truncate font-medium" title={r.path}>{r.path}</TableCell>
                  <TableCell className="text-end"><Badge variant="destructive" className="text-[10px]">{r.httpStatus}</Badge></TableCell>
                  <TableCell className="text-end tabular-nums">{formatCompact(r.views)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SiteStructureNodeRow({ node, depth }: { node: SiteStructureNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  return (
    <div>
      <button
        type="button"
        onClick={() => hasChildren && setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md py-1.5 text-sm transition-colors hover:bg-muted"
        style={{ paddingInlineStart: `${depth * 18 + 4}px` }}
      >
        {hasChildren ? (open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />) : <span className="w-3.5" />}
        <Network className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs">{node.segment}</span>
        <span className="ms-auto shrink-0 tabular-nums text-xs text-muted-foreground">{formatCompact(node.views)}</span>
      </button>
      {hasChildren && open && (
        <div>
          {node.children.map((child) => <SiteStructureNodeRow key={child.path} node={child} depth={depth + 1} />)}
        </div>
      )}
    </div>
  );
}

function SiteStructureView({ workspaceId, range }: { workspaceId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const { data, isLoading } = useWebAnalyticsSiteStructure(workspaceId, range);

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{t('seo.nav.item.siteStructure' as any)}</CardTitle></CardHeader>
      <CardContent>
        {isLoading ? (
          <SkeletonTable rows={6} columns={1} />
        ) : !data?.root || data.root.views === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.webAnalytics.empty.noData' as any)}</p>
        ) : (
          <div>
            {data.root.children.map((child) => <SiteStructureNodeRow key={child.path} node={child} depth={0} />)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Events ───────────────────────────────────────────────────────────

function TrackedEventsView({ workspaceId, range }: { workspaceId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const { data, isLoading } = useWebAnalyticsTrackedEvents(workspaceId, range);

  return (
    <ReportCard title={t('seo.nav.item.trackedEvents' as any)} description={t('seo.webAnalytics.trackedEvents.description' as any)} truncated={data?.truncated}>
      {isLoading ? (
        <SkeletonTable rows={6} columns={3} />
      ) : (data?.rows.length || 0) === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.webAnalytics.trackedEvents.empty' as any)}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('seo.webAnalytics.column.event' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.webAnalytics.column.count' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.webAnalytics.column.uniqueSessions' as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.rows || []).map((r) => (
              <TableRow key={r.eventName}>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-2"><Zap className="h-3.5 w-3.5 text-amber-500" />{r.eventName}</span>
                </TableCell>
                <TableCell className="text-end tabular-nums">{formatCompact(r.count)}</TableCell>
                <TableCell className="text-end tabular-nums text-muted-foreground">{formatCompact(r.uniqueSessions)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </ReportCard>
  );
}

function EventPropertiesView({ workspaceId, range }: { workspaceId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const { data: eventsData } = useWebAnalyticsTrackedEvents(workspaceId, range);
  const [eventName, setEventName] = useState<string | undefined>(undefined);
  const activeEvent = eventName || eventsData?.rows[0]?.eventName;
  const { data: keysData } = useWebAnalyticsEventPropertyKeys(workspaceId, activeEvent, range);
  const [propertyKey, setPropertyKey] = useState<string | undefined>(undefined);
  const activeKey = propertyKey || keysData?.keys[0];
  const { data: breakdownData, isLoading } = useWebAnalyticsEventPropertyBreakdown(workspaceId, activeEvent, activeKey, range);

  const events = eventsData?.rows || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('seo.nav.item.eventProperties' as any)}</CardTitle>
        <CardDescription>{t('seo.webAnalytics.eventProperties.description' as any)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {events.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.webAnalytics.trackedEvents.empty' as any)}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={activeEvent} onValueChange={(v) => { setEventName(v); setPropertyKey(undefined); }}>
                <SelectTrigger className="h-8 w-[220px] text-xs"><SelectValue placeholder={t('seo.webAnalytics.column.event' as any)} /></SelectTrigger>
                <SelectContent>
                  {events.map((e) => <SelectItem key={e.eventName} value={e.eventName}>{e.eventName}</SelectItem>)}
                </SelectContent>
              </Select>
              {(keysData?.keys.length || 0) > 0 && (
                <Select value={activeKey} onValueChange={setPropertyKey}>
                  <SelectTrigger className="h-8 w-[180px] text-xs"><SelectValue placeholder={t('seo.webAnalytics.eventProperties.property' as any)} /></SelectTrigger>
                  <SelectContent>
                    {(keysData?.keys || []).map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </div>
            {activeEvent && (keysData?.keys.length || 0) === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('seo.webAnalytics.eventProperties.noProperties' as any)}</p>
            ) : isLoading ? (
              <SkeletonTable rows={5} columns={2} />
            ) : (breakdownData?.rows.length || 0) === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('seo.webAnalytics.empty.noData' as any)}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('seo.webAnalytics.eventProperties.value' as any)}</TableHead>
                    <TableHead className="text-end">{t('seo.webAnalytics.column.count' as any)}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(breakdownData?.rows || []).map((r) => (
                    <TableRow key={r.value}>
                      <TableCell className="font-medium">{r.value}</TableCell>
                      <TableCell className="text-end tabular-nums">{formatCompact(r.count)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Funnels ──────────────────────────────────────────────────────────

function FunnelsView({ workspaceId, range }: { workspaceId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const { data: limitsData } = useWebAnalyticsLimits(workspaceId);
  const { data: funnelsData, isLoading } = useFunnels(workspaceId);
  const [selectedFunnelId, setSelectedFunnelId] = useState<string | undefined>(undefined);
  const funnels = funnelsData?.funnels || [];
  const activeFunnelId = selectedFunnelId || funnels[0]?.id;
  const maxFunnels = limitsData?.limits.web_analytics_max_funnels ?? 0;

  if (isLoading) return <SkeletonTable rows={4} columns={2} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('seo.nav.item.funnels' as any)}</h3>
        <CreateFunnelDialog workspaceId={workspaceId} disabled={funnels.length >= maxFunnels} />
      </div>

      {funnels.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-14 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Filter className="h-5 w-5" />
            </span>
            <h3 className="text-base font-semibold">{t('seo.webAnalytics.funnels.emptyTitle' as any)}</h3>
            <p className="max-w-md text-sm text-muted-foreground">{t('seo.webAnalytics.funnels.emptyDescription' as any)}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
          <div className="flex flex-col gap-1">
            {funnels.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setSelectedFunnelId(f.id)}
                className={`rounded-lg px-3 py-2 text-start text-sm transition-colors ${f.id === activeFunnelId ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted'}`}
              >
                {f.name}
              </button>
            ))}
          </div>
          {activeFunnelId && <FunnelResultsPanel workspaceId={workspaceId} funnelId={activeFunnelId} range={range} />}
        </div>
      )}
    </div>
  );
}

function FunnelResultsPanel({ workspaceId, funnelId, range }: { workspaceId: string; funnelId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const { data, isLoading } = useFunnelResults(workspaceId, funnelId, range);
  const deleteFunnel = useDeleteFunnel(workspaceId);

  if (isLoading) return <SkeletonTable rows={4} columns={1} />;
  if (!data) return null;
  const max = Math.max(...data.results.map((r) => r.sessions), 1);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{data.funnel.name}</CardTitle>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 text-muted-foreground hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('seo.webAnalytics.funnels.deleteConfirmTitle' as any)}</AlertDialogTitle>
              <AlertDialogDescription>{t('seo.webAnalytics.funnels.deleteConfirmDescription' as any)}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('seo.gsc.disconnectConfirm.cancel' as any)}</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteFunnel.mutate(funnelId)}>{t('seo.webAnalytics.funnels.delete' as any)}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.results.map((r, i) => (
          <div key={i} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{i + 1}. {r.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {formatCompact(r.sessions)} · {r.conversionFromStart}%
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(r.sessions / max) * 100}%` }} />
            </div>
            {i > 0 && <p className="text-[11px] text-muted-foreground">{t('seo.webAnalytics.funnels.conversionFromPrevious' as any, { percent: r.conversionFromPrevious } as any)}</p>}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CreateFunnelDialog({ workspaceId, disabled }: { workspaceId: string; disabled: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<FunnelStep[]>([
    { type: 'pageview', matcher: 'contains', value: '' },
    { type: 'pageview', matcher: 'contains', value: '' },
  ]);
  const createFunnel = useCreateFunnel(workspaceId);

  const updateStep = (i: number, patch: Partial<FunnelStep>) => {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } as FunnelStep : s)));
  };
  const addStep = () => setSteps((prev) => [...prev, { type: 'pageview', matcher: 'contains', value: '' }]);
  const removeStep = (i: number) => setSteps((prev) => prev.filter((_, idx) => idx !== i));

  const handleCreate = async () => {
    try {
      await createFunnel.mutateAsync({ name, steps });
      toast.success(t('seo.webAnalytics.funnels.created' as any));
      setOpen(false);
      setName('');
      setSteps([{ type: 'pageview', matcher: 'contains', value: '' }, { type: 'pageview', matcher: 'contains', value: '' }]);
    } catch (err) {
      toast.error(webAnalyticsErrorMessage(err, t));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5" disabled={disabled}>
          <Plus className="h-3.5 w-3.5" />{t('seo.webAnalytics.funnels.create' as any)}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t('seo.webAnalytics.funnels.create' as any)}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('seo.webAnalytics.funnels.namePlaceholder' as any)} />
          <div className="flex flex-col gap-3">
            {steps.map((step, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg border border-border/60 p-2">
                <span className="w-5 shrink-0 text-center text-xs font-semibold text-muted-foreground">{i + 1}</span>
                <Tabs value={step.type} onValueChange={(v) => updateStep(i, v === 'event' ? { type: 'event', eventName: '' } : { type: 'pageview', matcher: 'contains', value: '' })}>
                  <TabsList className="h-8">
                    <TabsTrigger value="pageview" className="text-xs">{t('seo.webAnalytics.funnels.pageview' as any)}</TabsTrigger>
                    <TabsTrigger value="event" className="text-xs">{t('seo.webAnalytics.funnels.event' as any)}</TabsTrigger>
                  </TabsList>
                </Tabs>
                {step.type === 'pageview' ? (
                  <Input className="h-8 flex-1 text-xs" value={step.value} onChange={(e) => updateStep(i, { value: e.target.value } as Partial<FunnelStep>)} placeholder="/checkout" />
                ) : (
                  <Input className="h-8 flex-1 text-xs" value={step.eventName} onChange={(e) => updateStep(i, { eventName: e.target.value } as Partial<FunnelStep>)} placeholder="signup_completed" />
                )}
                {steps.length > 2 && (
                  <Button variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0 text-muted-foreground" onClick={() => removeStep(i)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
            {steps.length < 10 && (
              <Button variant="outline" size="sm" className="gap-1.5 self-start" onClick={addStep}>
                <Plus className="h-3.5 w-3.5" />{t('seo.webAnalytics.funnels.addStep' as any)}
              </Button>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleCreate} disabled={createFunnel.isPending || !name.trim()}>
            {t('seo.webAnalytics.funnels.save' as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
