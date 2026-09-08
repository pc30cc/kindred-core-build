import { useEffect, useState, useCallback } from 'react';
import { Radar, Link2, CheckCircle2, XCircle, Loader2, Globe2, TrendingUp } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { AdminBacklinksProviderCard } from '@/features/providers/AdminBacklinksProviderCard';
import {
  adminGetBacklinksStats, adminListRecentBacklinkScans,
  type AdminBacklinksPlatformStats, type AdminRecentBacklinkScan,
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

export default function AdminSeoIntegrationsPage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<AdminBacklinksPlatformStats | null>(null);
  const [scans, setScans] = useState<AdminRecentBacklinkScan[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, scansRes] = await Promise.all([
        adminGetBacklinksStats(),
        adminListRecentBacklinkScans(20),
      ]);
      setStats(statsRes);
      setScans(scansRes.scans);
    } catch {
      setStats(null);
      setScans([]);
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

      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <StatTile icon={Link2} tone="text-primary bg-primary/10" value={stats?.totalScans ?? '—'} label={t('admin.seoIntegrations.stats.totalScans' as any)} />
        <StatTile icon={CheckCircle2} tone="text-emerald-500 bg-emerald-500/10" value={stats?.completedScans ?? '—'} label={t('admin.seoIntegrations.stats.completedScans' as any)} />
        <StatTile icon={Loader2} tone="text-sky-500 bg-sky-500/10" value={stats?.runningScans ?? '—'} label={t('admin.seoIntegrations.stats.runningScans' as any)} />
        <StatTile icon={Globe2} tone="text-violet-500 bg-violet-500/10" value={stats?.workspacesUsed ?? '—'} label={t('admin.seoIntegrations.stats.workspacesUsed' as any)} />
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
    </div>
  );
}
