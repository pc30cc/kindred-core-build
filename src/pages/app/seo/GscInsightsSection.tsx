/**
 * SEO — GSC Insights. Unlike the other four SEO modules (which run a
 * crawl/scan/lookup against a registered site), this one has no "run": a
 * workspace connects its own Google account via OAuth, links a Search
 * Console property, and every view here just reads that property's Search
 * Analytics data live (short-TTL cached server-side — see
 * server/services/seo/gsc/index.ts).
 *
 * State machine: not connected -> connected, no property linked -> property
 * linked, browsing data. Each state gets its own screen; the six sub-nav
 * leaves (overview/performance/queries/pages/devices/opportunities) only
 * render once a property is linked.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Link2, Unlink, Search as SearchIcon, MousePointerClick, Eye, Percent, TrendingUp,
  Smartphone, Monitor, Tablet, Globe2, Sparkles, ArrowUpRight, Plus,
} from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { SkeletonStats, SkeletonTable } from '@/components/common/Skeletons';
import { PlanLockedOverlay } from '@/components/plan/PlanLockedOverlay';
import { toast } from '@/lib/toast';
import {
  useGscConnection, useGscProperties, useGscAvailableSites, useStartGscOAuth,
  useDisconnectGsc, useLinkGscProperty, useUnlinkGscProperty, useSetPrimaryGscProperty,
  useGscSearchAnalytics, useGscLimits,
} from '@/hooks/useSeo';
import { SeoApiError, type SeoGscDimension, type SeoGscSearchAnalyticsRow } from '@/lib/seo-api';
import { GradientStatCard } from './SeoPage';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip,
} from 'recharts';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** GSC data is typically 2-3 days behind real time; window ends 3 days ago. */
function last28DaysRange(): { startDate: string; endDate: string } {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 3);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

function gscErrorMessage(err: unknown, t: (k: any) => string): string {
  if (err instanceof SeoApiError) {
    const key = `seo.gsc.errors.${err.code}`;
    const translated = t(key as any);
    if (translated !== key) return translated;
  }
  return t('seo.gsc.errors.generic' as any);
}

function formatCtr(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function formatPosition(v: number): string {
  return v.toFixed(1);
}

function formatCompact(v: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

// ─── Entry point ──────────────────────────────────────────────────────────

export function GscInsightsSection({ workspaceId, subsectionKey }: { workspaceId: string; subsectionKey: string }) {
  return (
    <PlanLockedOverlay moduleKey="seo_gsc_insights">
      <GscInsightsInner workspaceId={workspaceId} subsectionKey={subsectionKey} />
    </PlanLockedOverlay>
  );
}

function GscInsightsInner({ workspaceId, subsectionKey }: { workspaceId: string; subsectionKey: string }) {
  const { data: connectionData, isLoading: connectionLoading } = useGscConnection(workspaceId);
  const { data: propertiesData, isLoading: propertiesLoading } = useGscProperties(workspaceId);
  const properties = propertiesData?.properties || [];
  const [propertyId, setPropertyId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (propertyId && properties.some((p) => p.id === propertyId)) return;
    const primary = properties.find((p) => p.isPrimary) || properties[0];
    setPropertyId(primary?.id);
  }, [properties, propertyId]);

  if (connectionLoading || propertiesLoading) return <SkeletonStats count={4} />;

  const connection = connectionData?.connection;

  if (!connection?.connected) {
    return (
      <GscConnectCard
        workspaceId={workspaceId}
        status={connection?.status ?? null}
        lastError={connection?.lastError ?? null}
        platformConfigured={connectionData?.platformConfigured ?? true}
      />
    );
  }

  if (properties.length === 0) {
    return <GscPropertyPicker workspaceId={workspaceId} connectionEmail={connection.googleAccountEmail} />;
  }

  const activeProperty = properties.find((p) => p.id === propertyId) || properties[0];
  if (!activeProperty) return <SkeletonStats count={4} />;

  return (
    <div className="flex flex-col gap-4">
      <GscPropertyBar
        workspaceId={workspaceId}
        properties={properties}
        activePropertyId={activeProperty.id}
        onChange={setPropertyId}
        connectionEmail={connection.googleAccountEmail}
      />
      <GscDataView workspaceId={workspaceId} propertyId={activeProperty.id} subsectionKey={subsectionKey} />
    </div>
  );
}

// ─── Connect ────────────────────────────────────────────────────────────

function GscConnectCard({
  workspaceId, status, lastError, platformConfigured,
}: { workspaceId: string; status: string | null; lastError: string | null; platformConfigured: boolean }) {
  const { t } = useTranslation();
  const startOAuth = useStartGscOAuth(workspaceId);

  const handleConnect = async () => {
    try {
      const { url } = await startOAuth.mutateAsync();
      window.location.href = url;
    } catch (err) {
      toast.error(gscErrorMessage(err, t));
    }
  };

  return (
    <Card className="overflow-hidden">
      <CardContent className="relative flex flex-col items-center justify-center gap-4 py-16 text-center">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-primary/5 to-transparent" />
        <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-lg">
          <SearchIcon className="h-6 w-6" />
        </span>
        <div className="relative max-w-md space-y-1">
          <h3 className="text-lg font-semibold">{t('seo.gsc.connect.title' as any)}</h3>
          <p className="text-sm text-muted-foreground">{t('seo.gsc.connect.description' as any)}</p>
        </div>
        {status === 'revoked' && (
          <Badge variant="destructive" className="relative">{t('seo.gsc.connect.revoked' as any)}</Badge>
        )}
        {status === 'error' && lastError && (
          <p className="relative max-w-md text-xs text-destructive">{lastError}</p>
        )}
        {!platformConfigured ? (
          <p className="relative max-w-md text-xs text-muted-foreground">{t('seo.gsc.connect.notConfigured' as any)}</p>
        ) : (
          <Button onClick={handleConnect} disabled={startOAuth.isPending} className="relative gap-2">
            <Link2 className="h-4 w-4" />
            {startOAuth.isPending ? t('seo.gsc.connect.connecting' as any) : t('seo.gsc.connect.cta' as any)}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Pick a property (first-time linking) ─────────────────────────────────

function GscPropertyPicker({ workspaceId, connectionEmail }: { workspaceId: string; connectionEmail: string | null }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useGscAvailableSites(workspaceId);
  const linkProperty = useLinkGscProperty(workspaceId);
  const disconnect = useDisconnectGsc(workspaceId);
  const sites = data?.sites || [];

  const handleLink = async (siteUrl: string) => {
    try {
      await linkProperty.mutateAsync({ siteUrl });
      toast.success(t('seo.gsc.property.linked' as any));
    } catch (err) {
      toast.error(gscErrorMessage(err, t));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('seo.gsc.pickProperty.title' as any)}</CardTitle>
        <CardDescription>
          {t('seo.gsc.pickProperty.description' as any)}
          {connectionEmail ? ` — ${connectionEmail}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <SkeletonTable rows={4} columns={2} />
        ) : error ? (
          <p className="text-sm text-destructive">{gscErrorMessage(error, t)}</p>
        ) : sites.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('seo.gsc.pickProperty.empty' as any)}</p>
        ) : (
          <div className="space-y-2">
            {sites.map((s) => (
              <div key={s.siteUrl} className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{s.siteUrl}</p>
                  {s.permissionLevel && <p className="text-xs text-muted-foreground">{s.permissionLevel}</p>}
                </div>
                <Button size="sm" variant="outline" onClick={() => handleLink(s.siteUrl)} disabled={linkProperty.isPending}>
                  {t('seo.gsc.pickProperty.link' as any)}
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 border-t border-border/60 pt-4">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
            <Unlink className="me-1.5 h-3.5 w-3.5" />{t('seo.gsc.disconnect' as any)}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Property switcher / manage bar ────────────────────────────────────────

function GscPropertyBar({
  workspaceId, properties, activePropertyId, onChange, connectionEmail,
}: {
  workspaceId: string;
  properties: Array<{ id: string; siteUrl: string; isPrimary: boolean }>;
  activePropertyId: string;
  onChange: (id: string) => void;
  connectionEmail: string | null;
}) {
  const { t } = useTranslation();
  const disconnect = useDisconnectGsc(workspaceId);
  const linkProperty = useLinkGscProperty(workspaceId);
  const { data: limitsData } = useGscLimits(workspaceId);
  const { data: availableData } = useGscAvailableSites(workspaceId);
  const maxProps = limitsData?.limits.seo_gsc_max_properties ?? properties.length;
  const linkedUrls = useMemo(() => new Set(properties.map((p) => p.siteUrl)), [properties]);
  const linkable = (availableData?.sites || []).filter((s) => !linkedUrls.has(s.siteUrl));

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-card px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <Globe2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <Select value={activePropertyId} onValueChange={onChange}>
          <SelectTrigger className="h-8 w-[240px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {properties.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.siteUrl}{p.isPrimary ? ` (${t('seo.gsc.property.primary' as any)})` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {connectionEmail && <span className="hidden truncate text-xs text-muted-foreground sm:inline">{connectionEmail}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {properties.length < maxProps && linkable.length > 0 && (
          <Select onValueChange={(v) => linkProperty.mutate({ siteUrl: v })}>
            <SelectTrigger className="h-8 w-[170px] text-xs">
              <Plus className="me-1 h-3 w-3" />
              <SelectValue placeholder={t('seo.gsc.property.addAnother' as any)} />
            </SelectTrigger>
            <SelectContent>
              {linkable.map((s) => <SelectItem key={s.siteUrl} value={s.siteUrl}>{s.siteUrl}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 text-muted-foreground hover:text-destructive">
              <Unlink className="h-3.5 w-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('seo.gsc.disconnectConfirm.title' as any)}</AlertDialogTitle>
              <AlertDialogDescription>{t('seo.gsc.disconnectConfirm.description' as any)}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('seo.gsc.disconnectConfirm.cancel' as any)}</AlertDialogCancel>
              <AlertDialogAction onClick={() => disconnect.mutate()}>{t('seo.gsc.disconnect' as any)}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

// ─── Data views ────────────────────────────────────────────────────────────

function GscDataView({ workspaceId, propertyId, subsectionKey }: { workspaceId: string; propertyId: string; subsectionKey: string }) {
  switch (subsectionKey) {
    case 'overview':
      return <GscOverview workspaceId={workspaceId} propertyId={propertyId} />;
    case 'performance':
      return <GscPerformance workspaceId={workspaceId} propertyId={propertyId} />;
    case 'queries':
      return <GscDimensionPage workspaceId={workspaceId} propertyId={propertyId} dimension="query" keyLabelKey="seo.gsc.column.query" />;
    case 'pages':
      return <GscDimensionPage workspaceId={workspaceId} propertyId={propertyId} dimension="page" keyLabelKey="seo.gsc.column.page" />;
    case 'devices':
      return <GscDevices workspaceId={workspaceId} propertyId={propertyId} />;
    case 'opportunities':
      return <GscOpportunities workspaceId={workspaceId} propertyId={propertyId} />;
    default:
      return null;
  }
}

function summarize(rows: SeoGscSearchAnalyticsRow[]) {
  const totalClicks = rows.reduce((s, r) => s + r.clicks, 0);
  const totalImpressions = rows.reduce((s, r) => s + r.impressions, 0);
  const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
  const weightedPosition = totalImpressions > 0
    ? rows.reduce((s, r) => s + r.position * r.impressions, 0) / totalImpressions
    : 0;
  return { totalClicks, totalImpressions, avgCtr, avgPosition: weightedPosition };
}

function GscTrendChart({ rows }: { rows: SeoGscSearchAnalyticsRow[] }) {
  const data = useMemo(
    () => [...rows]
      .sort((a, b) => (a.keys[0] < b.keys[0] ? -1 : 1))
      .map((r) => ({ date: r.keys[0]?.slice(5), clicks: r.clicks, impressions: r.impressions })),
    [rows],
  );
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis yAxisId="clicks" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
          <YAxis yAxisId="impressions" orientation="right" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={50} />
          <ReTooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
          <Line yAxisId="clicks" type="monotone" dataKey="clicks" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
          <Line yAxisId="impressions" type="monotone" dataKey="impressions" stroke="#94a3b8" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function GscOverview({ workspaceId, propertyId }: { workspaceId: string; propertyId: string }) {
  const { t } = useTranslation();
  const wsPath = useWorkspacePath();
  const range = useMemo(() => last28DaysRange(), []);
  const trend = useGscSearchAnalytics(workspaceId, propertyId, { ...range, dimensions: ['date'] });
  const topQueries = useGscSearchAnalytics(workspaceId, propertyId, { ...range, dimensions: ['query'], rowLimit: 5 });
  const topPages = useGscSearchAnalytics(workspaceId, propertyId, { ...range, dimensions: ['page'], rowLimit: 5 });

  if (trend.isLoading) return <SkeletonStats count={4} />;
  if (trend.error) return <p className="text-sm text-destructive">{gscErrorMessage(trend.error, t)}</p>;

  const rows = trend.data?.rows || [];
  const stats = summarize(rows);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <GradientStatCard icon={MousePointerClick} iconGradient="from-indigo-500 to-violet-500" blobColor="bg-indigo-500/15" value={formatCompact(stats.totalClicks)} label={t('seo.gsc.stat.clicks' as any)} />
        <GradientStatCard icon={Eye} iconGradient="from-sky-500 to-cyan-500" blobColor="bg-sky-500/15" value={formatCompact(stats.totalImpressions)} label={t('seo.gsc.stat.impressions' as any)} />
        <GradientStatCard icon={Percent} iconGradient="from-emerald-500 to-teal-500" blobColor="bg-emerald-500/15" value={formatCtr(stats.avgCtr)} label={t('seo.gsc.stat.avgCtr' as any)} />
        <GradientStatCard icon={TrendingUp} iconGradient="from-amber-500 to-orange-500" blobColor="bg-amber-500/15" value={formatPosition(stats.avgPosition)} label={t('seo.gsc.stat.avgPosition' as any)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('seo.gsc.overview.trendTitle' as any)}</CardTitle>
          <CardDescription>{t('seo.gsc.overview.last28days' as any)}</CardDescription>
        </CardHeader>
        <CardContent>
          <GscTrendChart rows={rows} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <MiniRankedList
          title={t('seo.gsc.overview.topQueries' as any)}
          rows={topQueries.data?.rows || []}
          loading={topQueries.isLoading}
          viewAllHref={wsPath('/seo/gsc-insights/queries')}
        />
        <MiniRankedList
          title={t('seo.gsc.overview.topPages' as any)}
          rows={topPages.data?.rows || []}
          loading={topPages.isLoading}
          viewAllHref={wsPath('/seo/gsc-insights/pages')}
        />
      </div>
    </div>
  );
}

function MiniRankedList({
  title, rows, loading, viewAllHref,
}: { title: string; rows: SeoGscSearchAnalyticsRow[]; loading: boolean; viewAllHref: string }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground">
          <Link to={viewAllHref}>{t('seo.gsc.overview.viewAll' as any)}<ArrowUpRight className="h-3 w-3" /></Link>
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <SkeletonTable rows={5} columns={2} withHeader={false} />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('seo.gsc.empty.noData' as any)}</p>
        ) : (
          <div className="space-y-1.5">
            {rows.map((r) => (
              <div key={r.keys[0]} className="flex items-center justify-between gap-3 py-1 text-sm">
                <span className="truncate text-foreground">{r.keys[0]}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{formatCompact(r.clicks)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GscPerformance({ workspaceId, propertyId }: { workspaceId: string; propertyId: string }) {
  const { t } = useTranslation();
  const range = useMemo(() => last28DaysRange(), []);
  const trend = useGscSearchAnalytics(workspaceId, propertyId, { ...range, dimensions: ['date'] });

  if (trend.isLoading) return <SkeletonStats count={4} />;
  if (trend.error) return <p className="text-sm text-destructive">{gscErrorMessage(trend.error, t)}</p>;

  const rows = [...(trend.data?.rows || [])].sort((a, b) => (a.keys[0] < b.keys[0] ? 1 : -1));
  const stats = summarize(rows);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <GradientStatCard icon={MousePointerClick} iconGradient="from-indigo-500 to-violet-500" blobColor="bg-indigo-500/15" value={formatCompact(stats.totalClicks)} label={t('seo.gsc.stat.clicks' as any)} />
        <GradientStatCard icon={Eye} iconGradient="from-sky-500 to-cyan-500" blobColor="bg-sky-500/15" value={formatCompact(stats.totalImpressions)} label={t('seo.gsc.stat.impressions' as any)} />
        <GradientStatCard icon={Percent} iconGradient="from-emerald-500 to-teal-500" blobColor="bg-emerald-500/15" value={formatCtr(stats.avgCtr)} label={t('seo.gsc.stat.avgCtr' as any)} />
        <GradientStatCard icon={TrendingUp} iconGradient="from-amber-500 to-orange-500" blobColor="bg-amber-500/15" value={formatPosition(stats.avgPosition)} label={t('seo.gsc.stat.avgPosition' as any)} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('seo.gsc.overview.trendTitle' as any)}</CardTitle>
          <CardDescription>{t('seo.gsc.overview.last28days' as any)}</CardDescription>
        </CardHeader>
        <CardContent><GscTrendChart rows={rows} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">{t('seo.gsc.performance.byDay' as any)}</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('seo.gsc.column.date' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.gsc.stat.clicks' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.gsc.stat.impressions' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.gsc.stat.avgCtr' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.gsc.stat.avgPosition' as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.keys[0]}>
                  <TableCell className="font-medium">{r.keys[0]}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCompact(r.clicks)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCompact(r.impressions)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCtr(r.ctr)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatPosition(r.position)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function GscDimensionPage({
  workspaceId, propertyId, dimension, keyLabelKey,
}: { workspaceId: string; propertyId: string; dimension: SeoGscDimension; keyLabelKey: string }) {
  const { t } = useTranslation();
  const range = useMemo(() => last28DaysRange(), []);
  const query = useGscSearchAnalytics(workspaceId, propertyId, { ...range, dimensions: [dimension], rowLimit: 100 });

  if (query.isLoading) return <SkeletonTable rows={8} columns={5} />;
  if (query.error) return <p className="text-sm text-destructive">{gscErrorMessage(query.error, t)}</p>;

  const rows = query.data?.rows || [];
  const stats = summarize(rows);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <GradientStatCard icon={MousePointerClick} iconGradient="from-indigo-500 to-violet-500" blobColor="bg-indigo-500/15" value={formatCompact(stats.totalClicks)} label={t('seo.gsc.stat.clicks' as any)} />
        <GradientStatCard icon={Eye} iconGradient="from-sky-500 to-cyan-500" blobColor="bg-sky-500/15" value={formatCompact(stats.totalImpressions)} label={t('seo.gsc.stat.impressions' as any)} />
        <GradientStatCard icon={Percent} iconGradient="from-emerald-500 to-teal-500" blobColor="bg-emerald-500/15" value={formatCtr(stats.avgCtr)} label={t('seo.gsc.stat.avgCtr' as any)} />
        <GradientStatCard icon={TrendingUp} iconGradient="from-amber-500 to-orange-500" blobColor="bg-amber-500/15" value={formatPosition(stats.avgPosition)} label={t('seo.gsc.stat.avgPosition' as any)} />
      </div>
      <Card>
        <CardContent className="pt-6">
          {rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.gsc.empty.noData' as any)}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t(keyLabelKey as any)}</TableHead>
                  <TableHead className="text-end">{t('seo.gsc.stat.clicks' as any)}</TableHead>
                  <TableHead className="text-end">{t('seo.gsc.stat.impressions' as any)}</TableHead>
                  <TableHead className="text-end">{t('seo.gsc.stat.avgCtr' as any)}</TableHead>
                  <TableHead className="text-end">{t('seo.gsc.stat.avgPosition' as any)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.keys[0]}>
                    <TableCell className="max-w-[420px] truncate font-medium" title={r.keys[0]}>{r.keys[0]}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCompact(r.clicks)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCompact(r.impressions)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatCtr(r.ctr)}</TableCell>
                    <TableCell className="text-end tabular-nums">{formatPosition(r.position)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const DEVICE_ICON: Record<string, typeof Monitor> = { DESKTOP: Monitor, MOBILE: Smartphone, TABLET: Tablet };

function GscDevices({ workspaceId, propertyId }: { workspaceId: string; propertyId: string }) {
  const { t } = useTranslation();
  const range = useMemo(() => last28DaysRange(), []);
  const query = useGscSearchAnalytics(workspaceId, propertyId, { ...range, dimensions: ['device'] });

  if (query.isLoading) return <SkeletonStats count={3} />;
  if (query.error) return <p className="text-sm text-destructive">{gscErrorMessage(query.error, t)}</p>;

  const rows = [...(query.data?.rows || [])].sort((a, b) => b.clicks - a.clicks);
  const totalClicks = rows.reduce((s, r) => s + r.clicks, 0);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((r) => {
        const Icon = DEVICE_ICON[r.keys[0]] || Globe2;
        const share = totalClicks > 0 ? (r.clicks / totalClicks) * 100 : 0;
        return (
          <Card key={r.keys[0]}>
            <CardContent className="flex flex-col gap-3 p-5">
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-md">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="text-sm font-semibold capitalize">{r.keys[0].toLowerCase()}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">{t('seo.gsc.stat.clicks' as any)}</p>
                  <p className="font-semibold tabular-nums">{formatCompact(r.clicks)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('seo.gsc.stat.impressions' as any)}</p>
                  <p className="font-semibold tabular-nums">{formatCompact(r.impressions)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('seo.gsc.stat.avgCtr' as any)}</p>
                  <p className="font-semibold tabular-nums">{formatCtr(r.ctr)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('seo.gsc.stat.avgPosition' as any)}</p>
                  <p className="font-semibold tabular-nums">{formatPosition(r.position)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
      {rows.length === 0 && (
        <p className="col-span-full py-10 text-center text-sm text-muted-foreground">{t('seo.gsc.empty.noData' as any)}</p>
      )}
    </div>
  );
}

/**
 * "Striking distance" queries — real Search Console signal, never
 * fabricated: ranking positions 4-20 with meaningful impression volume are
 * the ones most likely to move up a page of results with focused effort.
 */
function GscOpportunities({ workspaceId, propertyId }: { workspaceId: string; propertyId: string }) {
  const { t } = useTranslation();
  const range = useMemo(() => last28DaysRange(), []);
  const query = useGscSearchAnalytics(workspaceId, propertyId, { ...range, dimensions: ['query'], rowLimit: 1000 });

  if (query.isLoading) return <SkeletonTable rows={8} columns={5} />;
  if (query.error) return <p className="text-sm text-destructive">{gscErrorMessage(query.error, t)}</p>;

  const opportunities = (query.data?.rows || [])
    .filter((r) => r.position >= 4 && r.position <= 20 && r.impressions >= 10)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 50);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          <CardTitle className="text-base">{t('seo.gsc.opportunities.title' as any)}</CardTitle>
        </div>
        <CardDescription>{t('seo.gsc.opportunities.description' as any)}</CardDescription>
      </CardHeader>
      <CardContent>
        {opportunities.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.gsc.opportunities.empty' as any)}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('seo.gsc.column.query' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.gsc.stat.impressions' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.gsc.stat.clicks' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.gsc.stat.avgCtr' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.gsc.stat.avgPosition' as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {opportunities.map((r) => (
                <TableRow key={r.keys[0]}>
                  <TableCell className="max-w-[420px] truncate font-medium" title={r.keys[0]}>{r.keys[0]}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCompact(r.impressions)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCompact(r.clicks)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCtr(r.ctr)}</TableCell>
                  <TableCell className="text-end tabular-nums">
                    <Badge variant="outline" className="tabular-nums">{formatPosition(r.position)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
