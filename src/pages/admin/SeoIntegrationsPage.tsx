import { useEffect, useState, useCallback } from 'react';
import { Radar, Link2, CheckCircle2, XCircle, Loader2, Globe2, TrendingUp, Search, LineChart } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { AdminBacklinksProviderCard } from '@/features/providers/AdminBacklinksProviderCard';
import { AdminKeywordsProviderCard } from '@/features/providers/AdminKeywordsProviderCard';
import { AdminRankTrackingProviderCard } from '@/features/providers/AdminRankTrackingProviderCard';
import {
  adminGetBacklinksStats, adminListRecentBacklinkScans,
  adminGetKeywordsStats, adminListRecentKeywordRuns,
  adminGetRankTrackingStats, adminListRecentRankChecks,
  type AdminBacklinksPlatformStats, type AdminRecentBacklinkScan,
  type AdminKeywordsPlatformStats, type AdminRecentKeywordRun,
  type AdminRankTrackingPlatformStats, type AdminRecentRankCheck,
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
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, scansRes, kwStatsRes, kwRunsRes, rankStatsRes, rankChecksRes] = await Promise.all([
        adminGetBacklinksStats(),
        adminListRecentBacklinkScans(20),
        adminGetKeywordsStats(),
        adminListRecentKeywordRuns(20),
        adminGetRankTrackingStats(),
        adminListRecentRankChecks(20),
      ]);
      setBacklinksStats(statsRes);
      setScans(scansRes.scans);
      setKeywordsStats(kwStatsRes);
      setKeywordRuns(kwRunsRes.runs);
      setRankStats(rankStatsRes);
      setRankChecks(rankChecksRes.checks);
    } catch {
      setBacklinksStats(null);
      setScans([]);
      setKeywordsStats(null);
      setKeywordRuns([]);
      setRankStats(null);
      setRankChecks([]);
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
    </div>
  );
}
