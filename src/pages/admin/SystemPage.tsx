import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAdminRuntimeConfig } from '@/hooks/useAdmin';
import { CheckCircle, Activity, AlertTriangle, AlertOctagon, Gauge, Shield } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchMetricsSummary } from '@/lib/admin-metrics-api';
import { fetchActiveAlerts, type ActiveAlert } from '@/lib/admin-alerts-api';
import { fetchPerfSummary, fetchPerfProcess } from '@/lib/admin-perf-api';
import {
  fetchActiveAutoActions,
  type ActiveAutoAction,
} from '@/lib/admin-auto-actions-api';
import SystemDegradedBanner from '@/components/admin/observability/SystemDegradedBanner';
import EffectivePolicyPanel from '@/components/admin/observability/EffectivePolicyPanel';
import { fetchSla, fetchWorkspaceHealth } from '@/lib/admin-reliability-api';
import { useTranslation } from '@/i18n';

export default function AdminSystemPage() {
  const { t } = useTranslation();
  const { data: config } = useAdminRuntimeConfig();
  const summary = useQuery({
    queryKey: ['admin-metrics-summary', '1h'],
    queryFn: () => fetchMetricsSummary('1h'),
    refetchInterval: 60_000,
  });
  const activeAlertsQ = useQuery({
    queryKey: ['admin-alerts-active'],
    queryFn: () => fetchActiveAlerts(),
    refetchInterval: 30_000,
  });
  const activeActionsQ = useQuery({
    queryKey: ['admin-auto-action-active'],
    queryFn: () => fetchActiveAutoActions(),
    refetchInterval: 30_000,
  });
  const perfSummaryQ = useQuery({
    queryKey: ['admin-perf-summary', '1h'],
    queryFn: () => fetchPerfSummary('1h'),
    refetchInterval: 60_000,
  });
  const perfProcessQ = useQuery({
    queryKey: ['admin-perf-process', '1h'],
    queryFn: () => fetchPerfProcess('1h'),
    refetchInterval: 60_000,
  });
  const slaQ = useQuery({
    queryKey: ['admin-sla', '24h'],
    queryFn: () => fetchSla('24h'),
    refetchInterval: 120_000,
  });
  const healthQ = useQuery({
    queryKey: ['admin-workspace-health'],
    queryFn: () => fetchWorkspaceHealth(),
    refetchInterval: 120_000,
  });
  const counts = summary.data?.counts || {};
  const summaryRows = [
    { metric: 'realtime.token_minted', label: t('admin.system.metrics.tokens' as any) },
    { metric: 'realtime.channel_ownership_reject', label: t('admin.system.metrics.rejects' as any) },
    { metric: 'widget.typing_rate_limited', label: t('admin.system.metrics.typing' as any) },
    { metric: 'realtime.fallback_engaged', label: t('admin.system.metrics.polling' as any) },
  ];

  const activeAlerts = (activeAlertsQ.data?.active || []).slice(0, 3);
  const hasCritical = activeAlerts.some((a) => a.severity === 'critical');
  const activeActions = (activeActionsQ.data?.active || []).slice(0, 3);

  const perfRows = (perfSummaryQ.data?.rows || []).slice(0, 4);
  const perfLatest = perfProcessQ.data?.latest;
  const fmtBytes = (n: number) => {
    if (!n) return '0';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(1)} ${u[i]}`;
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">{t('admin.system.title' as any)}</h1>
      <SystemDegradedBanner />
      <EffectivePolicyPanel />

      {activeAlerts.length > 0 && (
        <Card
          className={
            hasCritical
              ? 'bg-destructive/10 border-destructive/40'
              : 'bg-warning/10 border-warning/40'
          }
        >
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle
              className={`text-sm flex items-center gap-2 ${
                hasCritical ? 'text-destructive' : 'text-warning'
              }`}
            >
              {hasCritical ? (
                <AlertOctagon className="h-4 w-4" />
              ) : (
                <AlertTriangle className="h-4 w-4" />
              )}
              {t('admin.system.activeAlerts' as any, { count: activeAlertsQ.data?.active.length ?? 0 })}
            </CardTitle>
            <Link
              to="/admin/observability"
              className="text-xs text-primary hover:underline"
            >
              {t('admin.system.viewAll' as any)} →
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {activeAlerts.map((a: ActiveAlert) => (
              <div
                key={a.id}
                className="flex items-center justify-between rounded-md border border-border bg-background/50 px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Badge
                    className={
                      a.severity === 'critical'
                        ? 'bg-destructive/20 text-destructive'
                        : 'bg-warning/20 text-warning'
                    }
                  >
                    {a.severity}
                  </Badge>
                  <span className="font-mono text-xs text-foreground truncate">
                    {a.rule_slug}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground whitespace-nowrap">
                  {a.metric_value != null && a.threshold_value != null && (
                    <span>
                      {a.metric_value} / {a.threshold_value}
                    </span>
                  )}
                  <span>{new Date(a.fired_at).toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {activeActions.length > 0 && (
        <Card className="bg-warning/10 border-warning/40">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-warning">
              <Shield className="h-4 w-4" />
              {t('admin.system.activeActions' as any, { count: activeActionsQ.data?.active.length ?? 0 })}
            </CardTitle>
            <Link
              to="/admin/observability"
              className="text-xs text-primary hover:underline"
            >
              {t('admin.system.manage' as any)} →
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {activeActions.map((a: ActiveAutoAction) => (
              <div
                key={a.id}
                className="flex items-center justify-between rounded-md border border-border bg-background/50 px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Badge className="bg-warning/20 text-warning">{a.action_type}</Badge>
                  <span className="font-mono text-xs text-foreground truncate">
                    {a.action_slug}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground whitespace-nowrap">
                  <span>{t('admin.system.trigger' as any)}: {a.trigger_rule_slug || 'any-critical'}</span>
                  <span>{t('admin.system.expires' as any)} {new Date(a.expires_at).toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground text-sm">{t('admin.system.health.title' as any)}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(['database', 'auth', 'realtime', 'storage', 'edge'] as const).map(s => (
              <div key={s} className="flex items-center justify-between">
                <span className="text-muted-foreground text-sm">{t(`admin.system.health.${s}` as any)}</span>
                <Badge className="bg-success/20 text-success gap-1">
                  <CheckCircle className="h-3 w-3" /> {t('admin.common.healthy' as any)}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-foreground text-sm flex items-center gap-2">
              <Activity className="h-4 w-4" /> {t('admin.system.realtimeHour' as any)}
            </CardTitle>
            <Link
              to="/admin/observability"
              className="text-xs text-primary hover:underline"
            >
              {t('admin.system.drillDown' as any)} →
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {summary.isLoading && (
              <p className="text-muted-foreground text-sm">{t('admin.common.loading' as any)}</p>
            )}
            {summary.error && !summary.isLoading && (
              <p className="text-destructive text-sm">{t('admin.system.metricsUnavailable' as any)}</p>
            )}
            {!summary.isLoading && !summary.error && summaryRows.map((r) => (
              <div key={r.metric} className="flex items-center justify-between">
                <span className="text-muted-foreground text-sm">{r.label}</span>
                <Badge variant="outline">{counts[r.metric]?.total ?? 0}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-foreground text-sm flex items-center gap-2">
              <Gauge className="h-4 w-4" /> {t('admin.system.performanceHour' as any)}
            </CardTitle>
            <Link
              to="/admin/observability"
              className="text-xs text-primary hover:underline"
            >
              {t('admin.system.drillDown' as any)} →
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {perfSummaryQ.isLoading && (
              <p className="text-muted-foreground text-sm">{t('admin.common.loading' as any)}</p>
            )}
            {(perfSummaryQ.error || perfProcessQ.error) && !perfSummaryQ.isLoading && (
              <p className="text-destructive text-sm">{t('admin.system.performanceUnavailable' as any)}</p>
            )}
            {!perfSummaryQ.isLoading && !perfSummaryQ.error && !perfProcessQ.error && perfRows.length === 0 && (
              <p className="text-muted-foreground text-sm">{t('admin.system.noPerformance' as any)}</p>
            )}
            {!perfSummaryQ.error && !perfProcessQ.error && perfRows.map((r) => (
              <div
                key={`${r.route_group}|${r.method}`}
                className="flex items-center justify-between"
              >
                <span className="text-muted-foreground font-mono text-xs truncate max-w-[55%]">
                  {r.route_group}
                </span>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">{r.count}</Badge>
                  <Badge variant="outline" className="text-xs">p95 {r.p95}ms</Badge>
                </div>
              </div>
            ))}
            {perfLatest && (
              <div className="pt-2 mt-2 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('admin.system.eventLoopLag' as any)} {perfLatest.event_loop_lag_ms.toFixed(2)}ms</span>
                <span>RSS {fmtBytes(perfLatest.rss_bytes)}</span>
                <span>{t('admin.system.heap' as any)} {fmtBytes(perfLatest.heap_used_bytes)}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground text-sm">{t('admin.system.runtimeConfig' as any)}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {config?.length === 0 && <p className="text-muted-foreground text-sm">{t('admin.system.noRuntimeConfig' as any)}</p>}
            {config?.map(c => (
              <div key={c.key} className="flex items-center justify-between">
                <span className="text-muted-foreground font-mono text-sm">{c.key}</span>
                <span className="text-muted-foreground text-xs truncate max-w-[200px]">
                  {JSON.stringify(c.value)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-foreground text-sm flex items-center gap-2">
            <Activity className="h-4 w-4" /> {t('admin.system.reliabilityDay' as any)}
          </CardTitle>
          <Link to="/admin/observability" className="text-xs text-primary hover:underline">
            {t('admin.system.drillDown' as any)} →
          </Link>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-md border border-border px-3 py-2">
            <div className="text-xs text-muted-foreground">{t('admin.system.uptime' as any)}</div>
            <div className="text-foreground font-medium">
              {slaQ.data?.summary.uptime_pct != null
                ? `${slaQ.data.summary.uptime_pct.toFixed(2)}%`
                : '—'}
            </div>
          </div>
          <div className="rounded-md border border-border px-3 py-2">
            <div className="text-xs text-muted-foreground">{t('admin.system.degradedMinutes' as any)}</div>
            <div className="text-foreground font-medium">
              {slaQ.data?.summary.degraded_minutes?.toFixed(1) ?? '—'}
            </div>
          </div>
          <div className="rounded-md border border-border px-3 py-2">
            <div className="text-xs text-muted-foreground">{t('admin.system.failovers' as any)}</div>
            <div className="text-foreground font-medium">
              {slaQ.data?.summary.failover_count ?? '—'}
            </div>
          </div>
          <div className="rounded-md border border-border px-3 py-2">
            <div className="text-xs text-muted-foreground">{t('admin.system.criticalAlerts' as any)}</div>
            <div className="text-foreground font-medium">
              {slaQ.data?.summary.critical_alert_count ?? '—'}
            </div>
          </div>
          <div className="rounded-md border border-border px-3 py-2 col-span-2 md:col-span-4">
            <div className="text-xs text-muted-foreground mb-1">{t('admin.system.workspaceHealth' as any)}</div>
            <div className="flex items-center gap-2">
              <Badge className="bg-success/20 text-success">
                {t('admin.common.healthy' as any)} {healthQ.data?.counts.healthy ?? 0}
              </Badge>
              <Badge className="bg-warning/20 text-warning">
                {t('admin.system.warning' as any)} {healthQ.data?.counts.warning ?? 0}
              </Badge>
              <Badge className="bg-destructive/20 text-destructive">
                {t('admin.system.atRisk' as any)} {healthQ.data?.counts.at_risk ?? 0}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
