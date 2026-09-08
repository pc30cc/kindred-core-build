import { useEffect, useState, useCallback } from 'react';
import { Radar, Link2, CheckCircle2, XCircle, Loader2, Globe2, TrendingUp, Search, LineChart, Gauge, AlertTriangle, KeyRound } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { AdminBacklinksProviderCard } from '@/features/providers/AdminBacklinksProviderCard';
import { AdminKeywordsProviderCard } from '@/features/providers/AdminKeywordsProviderCard';
import { AdminRankTrackingProviderCard } from '@/features/providers/AdminRankTrackingProviderCard';
import { AdminPerformanceProviderCard } from '@/features/providers/AdminPerformanceProviderCard';
import {
  adminGetBacklinksStats, adminListRecentBacklinkScans,
  adminGetKeywordsStats, adminListRecentKeywordRuns,
  adminGetRankTrackingStats, adminListRecentRankChecks,
  adminGetPerformanceStats, adminListRecentPerformanceAudits,
  adminGetGscPlatformConfig, adminGetGscStats, adminListRecentGscConnections,
  adminGetExplorerStats, adminListRecentExplorerLookups,
  type AdminBacklinksPlatformStats, type AdminRecentBacklinkScan,
  type AdminKeywordsPlatformStats, type AdminRecentKeywordRun,
  type AdminRankTrackingPlatformStats, type AdminRecentRankCheck,
  type AdminPerformancePlatformStats, type AdminRecentPerformanceAudit,
  type AdminGscPlatformConfig, type AdminGscPlatformStats, type AdminRecentGscConnection,
  type AdminExplorerPlatformStats, type AdminRecentExplorerLookup,
} from '@/lib/api';

const STATUS_CLASS: Record<string, string> = {
  completed: 'border-emerald-500/40 text-emerald-500',
  running: 'border-sky-500/40 text-sky-500',
  processing: 'border-sky-500/40 text-sky-500',
  queued: 'border-amber-500/40 text-amber-500',
  failed: 'border-destructive/40 text-destructive',
  cancelled: 'border-border text-muted-foreground',
};

function StatTile({ icon: Icon, tone, value, label }: { icon: React.ComponentType<{ className?: string }>; tone: string; value: React.ReactNode; label: string }) {
  return (
    <Card className="border-border/60">
      <CardContent className="py-3 flex items-center gap-3">
        <div className={cn('p-2 rounded-lg', tone.split(' ')[1])}>
          <Icon className={cn('h-4 w-4', tone.split(' ')[0])} />
        </div>
        <div className="min-w-0">
          <p className="text-xl font-bold text-foreground leading-tight">{value}</p>
          <p className="text-[11px] text-muted-foreground truncate">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function SectionHeading({ icon: Icon, title }: { icon: React.ComponentType<{ className?: string }>; title: string }) {
  return (
    <div className="flex items-center gap-2 pt-2">
      <Icon className="h-4 w-4 text-primary" />
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
    </div>
  );
}

export default function AdminSeoIntegrationsPage() {
  const { t } = useTranslation();
  const [backlinksStats, setBacklinksStats] = useState<AdminBacklinksPlatformStats | null>(null);
  const [scans, setScans] = useState<AdminRecentBacklinkScan[]>([]);
  const [keywordsStats, setKeywordsStats] = useState<AdminKeywordsPlatformStats | null>(null);
  const [keywordRuns, setKeywordRuns] = useState<AdminRecentKeywordRun[]>([]);
  const [rankStats, setRankStats] = useState<AdminRankTrackingPlatformStats | null>(null);
  const [rankChecks, setRankChecks] = useState<AdminRecentRankCheck[]>([]);
  const [perfStats, setPerfStats] = useState<AdminPerformancePlatformStats | null>(null);
  const [perfAudits, setPerfAudits] = useState<AdminRecentPerformanceAudit[]>([]);
  const [gscConfig, setGscConfig] = useState<AdminGscPlatformConfig | null>(null);
  const [gscStats, setGscStats] = useState<AdminGscPlatformStats | null>(null);
  const [gscConnections, setGscConnections] = useState<AdminRecentGscConnection[]>([]);
  const [explorerStats, setExplorerStats] = useState<AdminExplorerPlatformStats | null>(null);
  const [explorerLookups, setExplorerLookups] = useState<AdminRecentExplorerLookup[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [
        statsRes, scansRes, kwStatsRes, kwRunsRes, rankStatsRes, rankChecksRes, perfStatsRes, perfAuditsRes,
        gscConfigRes, gscStatsRes, gscConnectionsRes, explorerStatsRes, explorerLookupsRes,
      ] = await Promise.all([
        adminGetBacklinksStats(),
        adminListRecentBacklinkScans(20),
        adminGetKeywordsStats(),
        adminListRecentKeywordRuns(20),
        adminGetRankTrackingStats(),
        adminListRecentRankChecks(20),
        adminGetPerformanceStats(),
        adminListRecentPerformanceAudits(20),
        adminGetGscPlatformConfig(),
        adminGetGscStats(),
        adminListRecentGscConnections(20),
        adminGetExplorerStats(),
        adminListRecentExplorerLookups(20),
      ]);
      setBacklinksStats(statsRes);
      setScans(scansRes.scans);
      setKeywordsStats(kwStatsRes);
      setKeywordRuns(kwRunsRes.runs);
      setRankStats(rankStatsRes);
      setRankChecks(rankChecksRes.checks);
      setPerfStats(perfStatsRes);
      setPerfAudits(perfAuditsRes.audits);
      setGscConfig(gscConfigRes);
      setGscStats(gscStatsRes);
      setGscConnections(gscConnectionsRes.connections);
      setExplorerStats(explorerStatsRes);
      setExplorerLookups(explorerLookupsRes.lookups);
    } catch {
      setBacklinksStats(null);
      setScans([]);
      setKeywordsStats(null);
      setKeywordRuns([]);
      setRankStats(null);
      setRankChecks([]);
      setPerfStats(null);
      setPerfAudits([]);
      setGscConfig(null);
      setGscStats(null);
      setGscConnections([]);
      setExplorerStats(null);
      setExplorerLookups([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-primary/10 text-primary">
          <Radar className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('admin.seoIntegrations.title' as any)}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('admin.seoIntegrations.subtitle' as any)}</p>
        </div>
      </div>

      {/* ─── Backlinks ─────────────────────────────────────────────── */}
      <SectionHeading icon={Link2} title={t('admin.seoIntegrations.backlinksSection' as any)} />

      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <StatTile icon={Link2} tone="text-primary bg-primary/10" value={backlinksStats?.totalScans ?? '—'} label={t('admin.seoIntegrations.stats.totalScans' as any)} />
        <StatTile icon={CheckCircle2} tone="text-emerald-500 bg-emerald-500/10" value={backlinksStats?.completedScans ?? '—'} label={t('admin.seoIntegrations.stats.completedScans' as any)} />
        <StatTile icon={Loader2} tone="text-sky-500 bg-sky-500/10" value={backlinksStats?.runningScans ?? '—'} label={t('admin.seoIntegrations.stats.runningScans' as any)} />
        <StatTile icon={Globe2} tone="text-violet-500 bg-violet-500/10" value={backlinksStats?.workspacesUsed ?? '—'} label={t('admin.seoIntegrations.stats.workspacesUsed' as any)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <AdminBacklinksProviderCard />
      </div>

      <Card className="border-border/60">
        <CardContent className="p-0">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
            <TrendingUp className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">{t('admin.seoIntegrations.recentScans' as any)}</h2>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 p-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('admin.seoIntegrations.loading' as any)}
            </div>
          ) : scans.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted-foreground">{t('admin.seoIntegrations.noScans' as any)}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/60 text-start text-muted-foreground">
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnWorkspace' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnTarget' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnStatus' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnBacklinks' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnDate' as any)}</th>
                  </tr>
                </thead>
                <tbody>
                  {scans.map((s) => (
                    <tr key={s.id} className="border-b border-border/40 last:border-0">
                      <td className="px-4 py-2 text-foreground">{s.workspace_name ?? s.workspace_id.slice(0, 8)}</td>
                      <td className="max-w-[220px] truncate px-4 py-2 text-muted-foreground">{s.target_url}</td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className={cn('text-[10px]', STATUS_CLASS[s.status] || 'border-border text-muted-foreground')}>
                          {s.status === 'failed' && <XCircle className="me-1 h-3 w-3" />}
                          {s.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-foreground">{s.total_backlinks ?? '—'}</td>
                      <td className="px-4 py-2 text-muted-foreground">{new Date(s.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Keyword Research ──────────────────────────────────────── */}
      <SectionHeading icon={Search} title={t('admin.seoIntegrations.keywordsSection' as any)} />

      <div className="grid gap-3 grid-cols-2 md:grid-cols-5">
        <StatTile icon={Search} tone="text-primary bg-primary/10" value={keywordsStats?.totalRuns ?? '—'} label={t('admin.seoIntegrations.keywordsStats.totalRuns' as any)} />
        <StatTile icon={CheckCircle2} tone="text-emerald-500 bg-emerald-500/10" value={keywordsStats?.completedRuns ?? '—'} label={t('admin.seoIntegrations.keywordsStats.completedRuns' as any)} />
        <StatTile icon={Loader2} tone="text-sky-500 bg-sky-500/10" value={keywordsStats?.runningRuns ?? '—'} label={t('admin.seoIntegrations.keywordsStats.runningRuns' as any)} />
        <StatTile icon={Globe2} tone="text-violet-500 bg-violet-500/10" value={keywordsStats?.workspacesUsed ?? '—'} label={t('admin.seoIntegrations.keywordsStats.workspacesUsed' as any)} />
        <StatTile icon={TrendingUp} tone="text-amber-500 bg-amber-500/10" value={keywordsStats?.totalKeywordsLookedUp ?? '—'} label={t('admin.seoIntegrations.keywordsStats.totalKeywordsLookedUp' as any)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <AdminKeywordsProviderCard />
      </div>

      <Card className="border-border/60">
        <CardContent className="p-0">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
            <TrendingUp className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">{t('admin.seoIntegrations.recentKeywordRuns' as any)}</h2>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 p-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('admin.seoIntegrations.loading' as any)}
            </div>
          ) : keywordRuns.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted-foreground">{t('admin.seoIntegrations.noKeywordRuns' as any)}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/60 text-start text-muted-foreground">
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnWorkspace' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnSeeds' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnStatus' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnKeywordsFound' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnDate' as any)}</th>
                  </tr>
                </thead>
                <tbody>
                  {keywordRuns.map((r) => (
                    <tr key={r.id} className="border-b border-border/40 last:border-0">
                      <td className="px-4 py-2 text-foreground">{r.workspace_name ?? r.workspace_id.slice(0, 8)}</td>
                      <td className="max-w-[220px] truncate px-4 py-2 text-muted-foreground">{r.seed_keywords.join(', ')}</td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className={cn('text-[10px]', STATUS_CLASS[r.status] || 'border-border text-muted-foreground')}>
                          {r.status === 'failed' && <XCircle className="me-1 h-3 w-3" />}
                          {r.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-foreground">{r.total_keywords ?? '—'}</td>
                      <td className="px-4 py-2 text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Rank Tracking ─────────────────────────────────────────── */}
      <SectionHeading icon={LineChart} title={t('admin.seoIntegrations.rankTrackingSection' as any)} />

      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <StatTile icon={LineChart} tone="text-primary bg-primary/10" value={rankStats?.totalTrackedKeywords ?? '—'} label={t('admin.seoIntegrations.rankTrackingStats.totalTracked' as any)} />
        <StatTile icon={CheckCircle2} tone="text-emerald-500 bg-emerald-500/10" value={rankStats?.activeTrackedKeywords ?? '—'} label={t('admin.seoIntegrations.rankTrackingStats.activeTracked' as any)} />
        <StatTile icon={Globe2} tone="text-violet-500 bg-violet-500/10" value={rankStats?.workspacesUsed ?? '—'} label={t('admin.seoIntegrations.rankTrackingStats.workspacesUsed' as any)} />
        <StatTile icon={TrendingUp} tone="text-amber-500 bg-amber-500/10" value={rankStats?.checksLast24h ?? '—'} label={t('admin.seoIntegrations.rankTrackingStats.checksLast24h' as any)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <AdminRankTrackingProviderCard />
      </div>

      <Card className="border-border/60">
        <CardContent className="p-0">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
            <TrendingUp className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">{t('admin.seoIntegrations.recentRankChecks' as any)}</h2>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 p-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('admin.seoIntegrations.loading' as any)}
            </div>
          ) : rankChecks.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted-foreground">{t('admin.seoIntegrations.noRankChecks' as any)}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/60 text-start text-muted-foreground">
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnWorkspace' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnKeyword' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnPosition' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnChecked' as any)}</th>
                  </tr>
                </thead>
                <tbody>
                  {rankChecks.map((c) => (
                    <tr key={c.id} className="border-b border-border/40 last:border-0">
                      <td className="px-4 py-2 text-foreground">{c.workspace_name ?? c.workspace_id.slice(0, 8)}</td>
                      <td className="px-4 py-2 text-muted-foreground">{c.keyword}</td>
                      <td className="px-4 py-2 text-foreground">{c.position ?? '—'}</td>
                      <td className="px-4 py-2 text-muted-foreground">{new Date(c.checked_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Performance ────────────────────────────────────────────── */}
      <SectionHeading icon={Gauge} title={t('admin.seoIntegrations.performanceSection' as any)} />

      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <StatTile icon={Gauge} tone="text-primary bg-primary/10" value={perfStats?.totalAudits ?? '—'} label={t('admin.seoIntegrations.performanceStats.totalAudits' as any)} />
        <StatTile icon={CheckCircle2} tone="text-emerald-500 bg-emerald-500/10" value={perfStats?.completedAudits ?? '—'} label={t('admin.seoIntegrations.performanceStats.completedAudits' as any)} />
        <StatTile icon={Globe2} tone="text-violet-500 bg-violet-500/10" value={perfStats?.workspacesUsed ?? '—'} label={t('admin.seoIntegrations.performanceStats.workspacesUsed' as any)} />
        <StatTile icon={TrendingUp} tone="text-amber-500 bg-amber-500/10" value={perfStats?.totalPagesAudited ?? '—'} label={t('admin.seoIntegrations.performanceStats.totalPagesAudited' as any)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <AdminPerformanceProviderCard />
      </div>

      <Card className="border-border/60">
        <CardContent className="p-0">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
            <TrendingUp className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">{t('admin.seoIntegrations.recentPerformanceAudits' as any)}</h2>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 p-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('admin.seoIntegrations.loading' as any)}
            </div>
          ) : perfAudits.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted-foreground">{t('admin.seoIntegrations.noPerformanceAudits' as any)}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/60 text-start text-muted-foreground">
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnWorkspace' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnStatus' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnPagesAudited' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnDate' as any)}</th>
                  </tr>
                </thead>
                <tbody>
                  {perfAudits.map((a) => (
                    <tr key={a.id} className="border-b border-border/40 last:border-0">
                      <td className="px-4 py-2 text-foreground">{a.workspace_name ?? a.workspace_id.slice(0, 8)}</td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className={cn('text-[10px]', STATUS_CLASS[a.status] || 'border-border text-muted-foreground')}>
                          {a.status === 'failed' && <XCircle className="me-1 h-3 w-3" />}
                          {a.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-foreground">{a.pages_audited ?? '—'}</td>
                      <td className="px-4 py-2 text-muted-foreground">{new Date(a.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── GSC Insights ──────────────────────────────────────────── */}
      <SectionHeading icon={Search} title={t('admin.seoIntegrations.gscSection' as any)} />

      <Card className={cn('border', gscConfig?.configured ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5')}>
        <CardContent className="flex items-start gap-3 py-4">
          <div className={cn('mt-0.5 rounded-lg p-2', gscConfig?.configured ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500')}>
            {gscConfig?.configured ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-foreground">
              {gscConfig?.configured ? t('admin.seoIntegrations.gsc.configuredTitle' as any) : t('admin.seoIntegrations.gsc.notConfiguredTitle' as any)}
            </p>
            <p className="text-xs text-muted-foreground">{t('admin.seoIntegrations.gsc.description' as any)}</p>
            {!gscConfig?.configured && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI'].map((name) => (
                  <Badge key={name} variant="outline" className="gap-1 font-mono text-[10px]">
                    <KeyRound className="h-2.5 w-2.5" />{name}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <StatTile icon={Link2} tone="text-primary bg-primary/10" value={gscStats?.activeConnections ?? '—'} label={t('admin.seoIntegrations.gscStats.activeConnections' as any)} />
        <StatTile icon={Globe2} tone="text-violet-500 bg-violet-500/10" value={gscStats?.totalPropertiesLinked ?? '—'} label={t('admin.seoIntegrations.gscStats.propertiesLinked' as any)} />
        <StatTile icon={XCircle} tone="text-destructive bg-destructive/10" value={gscStats?.revokedConnections ?? '—'} label={t('admin.seoIntegrations.gscStats.revokedConnections' as any)} />
        <StatTile icon={AlertTriangle} tone="text-amber-500 bg-amber-500/10" value={gscStats?.errorConnections ?? '—'} label={t('admin.seoIntegrations.gscStats.errorConnections' as any)} />
      </div>

      <Card className="border-border/60">
        <CardContent className="p-0">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
            <TrendingUp className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">{t('admin.seoIntegrations.recentGscConnections' as any)}</h2>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 p-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('admin.seoIntegrations.loading' as any)}
            </div>
          ) : gscConnections.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted-foreground">{t('admin.seoIntegrations.noGscConnections' as any)}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/60 text-start text-muted-foreground">
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnWorkspace' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnGoogleAccount' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnStatus' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnProperties' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnDate' as any)}</th>
                  </tr>
                </thead>
                <tbody>
                  {gscConnections.map((c) => (
                    <tr key={`${c.workspace_id}-${c.created_at}`} className="border-b border-border/40 last:border-0">
                      <td className="px-4 py-2 text-foreground">{c.workspace_name ?? c.workspace_id.slice(0, 8)}</td>
                      <td className="max-w-[220px] truncate px-4 py-2 text-muted-foreground">{c.google_account_email ?? '—'}</td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className={cn('text-[10px]', STATUS_CLASS[c.status] || 'border-border text-muted-foreground')}>
                          {c.status === 'revoked' && <XCircle className="me-1 h-3 w-3" />}
                          {c.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-foreground">{c.properties_linked}</td>
                      <td className="px-4 py-2 text-muted-foreground">{new Date(c.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Site Explorer ─────────────────────────────────────────── */}
      <SectionHeading icon={Globe2} title={t('admin.seoIntegrations.explorerSection' as any)} />

      <Card className="border-border/60 bg-muted/20">
        <CardContent className="flex items-start gap-3 py-3">
          <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
            <KeyRound className="h-4 w-4" />
          </div>
          <p className="text-xs text-muted-foreground">{t('admin.seoIntegrations.explorer.reusesCredentials' as any)}</p>
        </CardContent>
      </Card>

      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <StatTile icon={Globe2} tone="text-primary bg-primary/10" value={explorerStats?.totalLookups ?? '—'} label={t('admin.seoIntegrations.explorerStats.totalLookups' as any)} />
        <StatTile icon={Link2} tone="text-sky-500 bg-sky-500/10" value={explorerStats?.backlinkLookups ?? '—'} label={t('admin.seoIntegrations.explorerStats.backlinkLookups' as any)} />
        <StatTile icon={Search} tone="text-emerald-500 bg-emerald-500/10" value={explorerStats?.keywordLookups ?? '—'} label={t('admin.seoIntegrations.explorerStats.keywordLookups' as any)} />
        <StatTile icon={TrendingUp} tone="text-violet-500 bg-violet-500/10" value={explorerStats?.workspacesUsed ?? '—'} label={t('admin.seoIntegrations.explorerStats.workspacesUsed' as any)} />
      </div>

      <Card className="border-border/60">
        <CardContent className="p-0">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
            <TrendingUp className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">{t('admin.seoIntegrations.recentExplorerLookups' as any)}</h2>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 p-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('admin.seoIntegrations.loading' as any)}
            </div>
          ) : explorerLookups.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted-foreground">{t('admin.seoIntegrations.noExplorerLookups' as any)}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/60 text-start text-muted-foreground">
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnWorkspace' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnTarget' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnKind' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnStatus' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnResults' as any)}</th>
                    <th className="px-4 py-2 text-start font-medium">{t('admin.seoIntegrations.columnDate' as any)}</th>
                  </tr>
                </thead>
                <tbody>
                  {explorerLookups.map((l) => (
                    <tr key={l.id} className="border-b border-border/40 last:border-0">
                      <td className="px-4 py-2 text-foreground">{l.workspace_name ?? l.workspace_id.slice(0, 8)}</td>
                      <td className="max-w-[200px] truncate px-4 py-2 text-muted-foreground">{l.target_domain}</td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="text-[10px]">
                          {l.kind === 'backlinks' ? t('admin.seoIntegrations.kindBacklinks' as any) : t('admin.seoIntegrations.kindKeywords' as any)}
                        </Badge>
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className={cn('text-[10px]', STATUS_CLASS[l.status] || 'border-border text-muted-foreground')}>
                          {l.status === 'failed' && <XCircle className="me-1 h-3 w-3" />}
                          {l.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-foreground">{l.result_count ?? '—'}</td>
                      <td className="px-4 py-2 text-muted-foreground">{new Date(l.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
