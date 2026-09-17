import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useAdminAuditLogs, useAdminFeatureFlags, useAdminProfileCount, useAdminProfiles, useAdminProviderConfigs, useAdminWorkspaceCount, useAdminWorkspaces } from '@/hooks/useAdmin';
import { fetchActiveAlerts } from '@/lib/admin-alerts-api';
import { fetchPerfSummary } from '@/lib/admin-perf-api';
import { fetchBusinessMetrics, fetchSla, type Range as ReliabilityRange } from '@/lib/admin-reliability-api';
import { Activity, AlertTriangle, ArrowUpRight, BarChart3, BellRing, Building2, CheckCircle2, Clock3, CreditCard, Flag, Gauge, Loader2, MessageSquare, Plug, RefreshCw, Settings2, ShieldCheck, Sparkles, TrendingUp, UserRoundPlus, Users, Workflow } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

type DashboardRange = '24h' | '7d' | '30d';

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDuration(seconds: number | null | undefined, locale: string, t: (key: string, vars?: any) => string) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return t('admin.dashboard.units.seconds' as any, { value: Math.round(seconds) });
  if (seconds < 3600) return t('admin.dashboard.units.minutes' as any, { value: Math.round(seconds / 60) });
  return t('admin.dashboard.units.hours' as any, { value: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(seconds / 3600) });
}

export default function AdminDashboardPage() {
  const { t, locale } = useTranslation();
  const [range, setRange] = useState<DashboardRange>('24h');
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const percent = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }), [locale]);
  const dateLocale = locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';

  const userCountQ = useAdminProfileCount();
  const workspaceCountQ = useAdminWorkspaceCount();
  const usersQ = useAdminProfiles(5, 0, '', 'newest');
  const workspacesQ = useAdminWorkspaces(5, 0, '', 'newest');
  const flagsQ = useAdminFeatureFlags();
  const providersQ = useAdminProviderConfigs();
  const auditQ = useAdminAuditLogs({ limit: 8 });
  const businessQ = useQuery({ queryKey: ['admin-dashboard', 'business', range], queryFn: () => fetchBusinessMetrics(range as ReliabilityRange), refetchInterval: 60_000 });
  const slaQ = useQuery({ queryKey: ['admin-dashboard', 'sla', range], queryFn: () => fetchSla(range as ReliabilityRange), refetchInterval: 60_000 });
  const alertsQ = useQuery({ queryKey: ['admin-dashboard', 'active-alerts'], queryFn: fetchActiveAlerts, refetchInterval: 30_000 });
  const perfQ = useQuery({ queryKey: ['admin-dashboard', 'performance'], queryFn: () => fetchPerfSummary('24h'), refetchInterval: 60_000 });

  const allQueries = [userCountQ, workspaceCountQ, usersQ, workspacesQ, flagsQ, providersQ, auditQ, businessQ, slaQ, alertsQ, perfQ];
  const isRefreshing = allQueries.some((query) => query.isFetching);
  const hasUnavailableData = allQueries.some((query) => query.isError);
  const lastUpdatedAt = Math.max(...allQueries.map((query) => query.dataUpdatedAt || 0));
  const refresh = () => Promise.all(allQueries.map((query) => query.refetch()));
  const business = businessQ.data?.summary;
  const sla = slaQ.data?.summary;
  const activeAlerts = alertsQ.data?.active ?? [];
  const criticalAlerts = activeAlerts.filter((alert) => alert.severity === 'critical').length;
  const warningAlerts = activeAlerts.filter((alert) => alert.severity === 'warn').length;
  const activeProviders = (providersQ.data ?? []).filter((provider: any) => provider.is_active !== false).length;
  const enabledFlags = (flagsQ.data ?? []).filter((flag: any) => flag.enabled === true || flag.value === true).length;
  const resolutionRate = business?.new_conversations ? Math.min(100, (business.resolved_conversations / business.new_conversations) * 100) : 0;
  const platformState = hasUnavailableData ? 'unavailable' : criticalAlerts > 0 ? 'critical' : warningAlerts > 0 ? 'attention' : 'healthy';

  const chartData = useMemo(() => {
    const buckets = new Map<string, { timestamp: number; label: string; conversations: number; resolved: number }>();
    for (const row of businessQ.data?.rows ?? []) {
      const date = new Date(row.bucket_hour);
      if (Number.isNaN(date.getTime())) continue;
      const key = range === '24h' ? `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}-${date.getUTCHours()}` : `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
      const existing = buckets.get(key) ?? {
        timestamp: date.getTime(),
        label: new Intl.DateTimeFormat(dateLocale, range === '24h' ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' }).format(date),
        conversations: 0,
        resolved: 0,
      };
      existing.timestamp = Math.min(existing.timestamp, date.getTime());
      existing.conversations += numberValue(row.new_conversations);
      existing.resolved += numberValue(row.resolved_conversations);
      buckets.set(key, existing);
    }
    return Array.from(buckets.values()).sort((a, b) => a.timestamp - b.timestamp);
  }, [businessQ.data?.rows, dateLocale, range]);

  const perfTotals = useMemo(() => {
    const rows = perfQ.data?.rows ?? [];
    const requestCount = rows.reduce((sum, row) => sum + numberValue(row.count), 0);
    const errorCount = rows.reduce((sum, row) => sum + numberValue(row.error_count), 0);
    return { requestCount, errorRate: requestCount ? (errorCount / requestCount) * 100 : 0, p95: rows.length ? Math.max(...rows.map((row) => numberValue(row.p95))) : null };
  }, [perfQ.data?.rows]);

  const statCards = [
    { label: t('admin.dashboard.stats.users' as any), value: userCountQ.data, icon: Users, tone: 'blue', href: '/admin/users' },
    { label: t('admin.dashboard.stats.workspaces' as any), value: workspaceCountQ.data, icon: Building2, tone: 'violet', href: '/admin/workspaces' },
    { label: t('admin.dashboard.stats.activeProviders' as any), value: activeProviders, icon: Plug, tone: 'emerald', href: '/admin/providers' },
    { label: t('admin.dashboard.stats.enabledFlags' as any), value: enabledFlags, icon: Flag, tone: 'amber', href: '/admin/feature-flags' },
  ] as const;
  const quickActions = [
    { key: 'users', href: '/admin/users', icon: UserRoundPlus }, { key: 'workspaces', href: '/admin/workspaces', icon: Building2 },
    { key: 'observability', href: '/admin/observability', icon: BarChart3 }, { key: 'billing', href: '/admin/billing', icon: CreditCard },
    { key: 'providers', href: '/admin/providers', icon: Plug }, { key: 'settings', href: '/admin/widget-settings', icon: Settings2 },
  ] as const;

  return (
    <div className="space-y-6 pb-8">
      <section className="relative overflow-hidden rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/15 via-card to-violet-500/10 p-5 shadow-sm sm:p-7">
        <div className="pointer-events-none absolute -end-16 -top-24 h-64 w-64 rounded-full bg-primary/15 blur-3xl" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-3 flex flex-wrap items-center gap-2"><Badge className="gap-1.5 border-primary/25 bg-primary/10 text-primary hover:bg-primary/15" variant="outline"><Sparkles className="h-3.5 w-3.5" />{t('admin.dashboard.badge' as any)}</Badge><PlatformStatus state={platformState} t={t} /></div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{t('admin.dashboard.title' as any)}</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">{t('admin.dashboard.subtitle' as any)}</p>
          </div>
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            <div className="flex rounded-xl border border-border/70 bg-background/70 p-1 shadow-sm backdrop-blur">
              {(['24h', '7d', '30d'] as const).map((value) => <button key={value} type="button" onClick={() => setRange(value)} className={cn('rounded-lg px-3 py-2 text-xs font-medium transition-all', range === value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{t(`admin.dashboard.ranges.${value}` as any)}</button>)}
            </div>
            <Button variant="outline" className="gap-2 bg-background/70" onClick={refresh} disabled={isRefreshing}><RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />{t('admin.dashboard.refresh' as any)}</Button>
          </div>
        </div>
        <div className="relative mt-5 flex items-center gap-2 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />{lastUpdatedAt ? t('admin.dashboard.updatedAt' as any, { date: new Intl.DateTimeFormat(dateLocale, { hour: '2-digit', minute: '2-digit' }).format(lastUpdatedAt) }) : t('admin.dashboard.loading' as any)}</div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {statCards.map((stat) => <Link key={stat.label} to={stat.href} className="group focus:outline-none"><StatCard {...stat} value={stat.value == null ? '—' : number.format(stat.value)} /></Link>)}
      </section>

      <section className="grid gap-4">
        <Card className="overflow-hidden border-border/70 bg-card/90 shadow-sm">
          <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2"><div><CardTitle className="flex items-center gap-2 text-base"><TrendingUp className="h-4 w-4 text-primary" />{t('admin.dashboard.activity.title' as any)}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{t('admin.dashboard.activity.description' as any)}</p></div><Link to="/admin/observability" className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline">{t('admin.dashboard.viewDetails' as any)}<ArrowUpRight className="h-3.5 w-3.5 rtl:-scale-x-100" /></Link></CardHeader>
          <CardContent className="pt-3">
            {businessQ.isLoading ? <ChartSkeleton /> : chartData.length ? <div className="h-[270px] w-full" dir="ltr"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ top: 10, right: 4, left: -18, bottom: 0 }}><defs><linearGradient id="dashboardConversationFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.35} /><stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} /></linearGradient><linearGradient id="dashboardResolvedFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} /><stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} /></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} /><XAxis dataKey="label" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} /><YAxis allowDecimals={false} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} axisLine={false} tickLine={false} /><ChartTooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 12, fontSize: 12 }} /><Area type="monotone" dataKey="conversations" name={t('admin.dashboard.activity.newConversations' as any)} stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#dashboardConversationFill)" /><Area type="monotone" dataKey="resolved" name={t('admin.dashboard.activity.resolved' as any)} stroke="#8b5cf6" strokeWidth={2} fill="url(#dashboardResolvedFill)" /></AreaChart></ResponsiveContainer></div> : <EmptyState icon={BarChart3} text={t('admin.dashboard.activity.empty' as any)} />}
            <div className="mt-3 flex flex-wrap gap-4 border-t border-border/60 pt-3 text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-primary" />{t('admin.dashboard.activity.newConversations' as any)}</span><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-violet-500" />{t('admin.dashboard.activity.resolved' as any)}</span></div>
          </CardContent>
        </Card>

      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={MessageSquare} label={t('admin.dashboard.business.conversations' as any)} value={number.format(business?.new_conversations ?? 0)} hint={t('admin.dashboard.business.selectedRange' as any)} />
        <MetricCard icon={CheckCircle2} label={t('admin.dashboard.business.resolutionRate' as any)} value={`${percent.format(resolutionRate)}%`} hint={t('admin.dashboard.business.resolvedCount' as any, { count: number.format(business?.resolved_conversations ?? 0) })} progress={resolutionRate} />
        <MetricCard icon={Workflow} label={t('admin.dashboard.business.messages' as any)} value={number.format(business?.messages_sent ?? 0)} hint={t('admin.dashboard.business.selectedRange' as any)} />
        <MetricCard icon={Clock3} label={t('admin.dashboard.business.firstResponse' as any)} value={formatDuration(business?.avg_first_response_p50, locale, t)} hint={t('admin.dashboard.business.p95' as any, { value: formatDuration(business?.avg_first_response_p95, locale, t) })} />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card className="border-border/70 shadow-sm"><CardHeader className="flex flex-row items-start justify-between gap-3 pb-3"><div><CardTitle className="flex items-center gap-2 text-base"><BellRing className="h-4 w-4 text-amber-500" />{t('admin.dashboard.alerts.title' as any)}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{t('admin.dashboard.alerts.description' as any)}</p></div><Badge variant={criticalAlerts ? 'destructive' : activeAlerts.length ? 'outline' : 'secondary'}>{number.format(activeAlerts.length)}</Badge></CardHeader><CardContent>
          {alertsQ.isLoading ? <ListSkeleton /> : activeAlerts.length ? <div className="space-y-2">{activeAlerts.slice(0, 5).map((alert) => <div key={alert.id} className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/20 p-3"><span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', alert.severity === 'critical' ? 'bg-destructive/10 text-destructive' : 'bg-amber-500/10 text-amber-600')}><AlertTriangle className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{alert.rule_slug}</p><p className="text-xs text-muted-foreground">{new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(alert.fired_at))}</p></div><Badge variant={alert.severity === 'critical' ? 'destructive' : 'outline'}>{t(`admin.dashboard.alerts.${alert.severity}` as any)}</Badge></div>)}</div> : <EmptyState icon={ShieldCheck} text={t('admin.dashboard.alerts.empty' as any)} compact />}
          <Link to="/admin/observability" className="mt-3 flex items-center justify-center gap-1 border-t pt-3 text-xs font-medium text-primary hover:underline">{t('admin.dashboard.alerts.manage' as any)}<ArrowUpRight className="h-3.5 w-3.5 rtl:-scale-x-100" /></Link>
        </CardContent></Card>

        <Card className="border-border/70 shadow-sm"><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><Gauge className="h-4 w-4 text-blue-500" />{t('admin.dashboard.performance.title' as any)}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{t('admin.dashboard.performance.description' as any)}</p></CardHeader><CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-3"><PerformanceMetric label={t('admin.dashboard.performance.uptime' as any)} value={sla?.uptime_pct == null ? '—' : `${percent.format(sla.uptime_pct)}%`} good={sla?.uptime_pct != null && sla.uptime_pct >= 99} /><PerformanceMetric label={t('admin.dashboard.performance.p95' as any)} value={perfTotals.p95 == null ? '—' : `${number.format(Math.round(perfTotals.p95))} ms`} good={perfTotals.p95 != null && perfTotals.p95 < 500} /><PerformanceMetric label={t('admin.dashboard.performance.errorRate' as any)} value={`${percent.format(perfTotals.errorRate)}%`} good={perfTotals.errorRate < 1} /></div>
          <div className="rounded-xl border border-border/60 bg-muted/20 p-3"><div className="mb-2 flex items-center justify-between text-xs"><span className="text-muted-foreground">{t('admin.dashboard.performance.realtime' as any)}</span><span className="font-semibold">{sla?.realtime_availability_pct == null ? '—' : `${percent.format(sla.realtime_availability_pct)}%`}</span></div><Progress value={sla?.realtime_availability_pct ?? 0} className="h-2" /></div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs"><SmallMetric label={t('admin.dashboard.performance.requests' as any)} value={number.format(perfTotals.requestCount)} /><SmallMetric label={t('admin.dashboard.performance.failovers' as any)} value={number.format(sla?.failover_count ?? 0)} /><SmallMetric label={t('admin.dashboard.performance.recovery' as any)} value={formatDuration(sla?.mean_failover_recovery_seconds, locale, t)} /></div>
        </CardContent></Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <RecentListCard title={t('admin.dashboard.recentUsers.title' as any)} description={t('admin.dashboard.recentUsers.description' as any)} href="/admin/users" icon={Users} loading={usersQ.isLoading} empty={!usersQ.data?.length} emptyText={t('admin.dashboard.recentUsers.empty' as any)} viewAll={t('admin.dashboard.viewAll' as any)}>
          {(usersQ.data ?? []).map((user) => <div key={user.id} className="flex items-center gap-3 border-b border-border/50 py-3 last:border-0"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">{(user.full_name || user.email || '?').charAt(0).toUpperCase()}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{user.full_name || user.email}</p><p className="truncate text-xs text-muted-foreground">{user.email}</p></div><div className="text-end"><p className="text-xs font-medium">{t('admin.dashboard.recentUsers.workspaceCount' as any, { count: number.format(user.workspace_count) })}</p><p className="text-[11px] text-muted-foreground">{user.created_at ? new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium' }).format(new Date(user.created_at)) : '—'}</p></div></div>)}
        </RecentListCard>
        <RecentListCard title={t('admin.dashboard.recentWorkspaces.title' as any)} description={t('admin.dashboard.recentWorkspaces.description' as any)} href="/admin/workspaces" icon={Building2} loading={workspacesQ.isLoading} empty={!workspacesQ.data?.length} emptyText={t('admin.dashboard.recentWorkspaces.empty' as any)} viewAll={t('admin.dashboard.viewAll' as any)}>
          {(workspacesQ.data ?? []).map((workspace) => <div key={workspace.id} className="flex items-center gap-3 border-b border-border/50 py-3 last:border-0"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600"><Building2 className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{workspace.name}</p><p className="truncate text-xs text-muted-foreground">{workspace.owner_email}</p></div><div className="flex shrink-0 gap-1.5"><Badge variant="secondary">{t('admin.dashboard.recentWorkspaces.members' as any, { count: number.format(workspace.member_count) })}</Badge><Badge variant="outline">{t('admin.dashboard.recentWorkspaces.conversations' as any, { count: number.format(workspace.conversation_count) })}</Badge></div></div>)}
        </RecentListCard>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Card className="border-border/70 shadow-sm"><CardHeader className="flex flex-row items-start justify-between gap-3 pb-3"><div><CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4 text-primary" />{t('admin.dashboard.audit.title' as any)}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{t('admin.dashboard.audit.description' as any)}</p></div><Link to="/admin/audit-logs" className="text-xs font-medium text-primary hover:underline">{t('admin.dashboard.viewAll' as any)}</Link></CardHeader><CardContent>
          {auditQ.isLoading ? <ListSkeleton /> : auditQ.data?.logs.length ? <div className="space-y-1">{auditQ.data.logs.slice(0, 6).map((log) => <div key={log.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-muted/50"><span className="h-2 w-2 rounded-full bg-primary" /><div className="min-w-0"><p className="truncate font-mono text-xs text-foreground">{log.action || '—'}</p><p className="truncate text-[11px] text-muted-foreground">{log.entity_type || t('admin.dashboard.audit.platform' as any)}</p></div><span className="text-[11px] text-muted-foreground">{log.created_at ? new Intl.DateTimeFormat(dateLocale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(log.created_at)) : '—'}</span></div>)}</div> : <EmptyState icon={Activity} text={t('admin.dashboard.audit.empty' as any)} compact />}
        </CardContent></Card>
        <Card className="border-border/70 bg-gradient-to-br from-card to-primary/5 shadow-sm"><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4 text-primary" />{t('admin.dashboard.quick.title' as any)}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{t('admin.dashboard.quick.description' as any)}</p></CardHeader><CardContent className="grid grid-cols-2 gap-2">{quickActions.map((action) => <Link key={action.key} to={action.href} className="group flex items-center gap-2 rounded-xl border border-border/60 bg-background/60 p-3 text-sm font-medium transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:bg-primary/5 hover:shadow-sm"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><action.icon className="h-4 w-4" /></span><span className="truncate">{t(`admin.dashboard.quick.${action.key}` as any)}</span><ArrowUpRight className="ms-auto h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 rtl:-scale-x-100" /></Link>)}</CardContent></Card>
      </section>
    </div>
  );
}

function PlatformStatus({ state, t }: { state: 'healthy' | 'attention' | 'critical' | 'unavailable'; t: (key: string) => string }) {
  const styles = { healthy: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600', attention: 'border-amber-500/25 bg-amber-500/10 text-amber-600', critical: 'border-destructive/25 bg-destructive/10 text-destructive', unavailable: 'border-border bg-muted text-muted-foreground' };
  return <Badge variant="outline" className={cn('gap-1.5', styles[state])}><span className={cn('h-1.5 w-1.5 rounded-full', state === 'healthy' ? 'bg-emerald-500' : state === 'attention' ? 'bg-amber-500' : state === 'critical' ? 'bg-destructive' : 'bg-muted-foreground')} />{t(`admin.dashboard.platform.${state}` as any)}</Badge>;
}

function StatCard({ label, value, icon: Icon, tone }: { label: string; value: string | number; icon: any; tone: 'blue' | 'violet' | 'emerald' | 'amber' }) {
  const tones = { blue: 'bg-blue-500/10 text-blue-600', violet: 'bg-violet-500/10 text-violet-600', emerald: 'bg-emerald-500/10 text-emerald-600', amber: 'bg-amber-500/10 text-amber-600' };
  return <Card className="h-full border-border/70 shadow-sm transition-all group-hover:-translate-y-0.5 group-hover:border-primary/25 group-hover:shadow-md"><CardContent className="flex items-center gap-4 p-4 sm:p-5"><span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl', tones[tone])}><Icon className="h-5 w-5" /></span><div className="min-w-0 flex-1"><p className="truncate text-xs text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{value}</p></div><ArrowUpRight className="h-4 w-4 text-muted-foreground/50 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 rtl:-scale-x-100" /></CardContent></Card>;
}

function MetricCard({ icon: Icon, label, value, hint, progress }: { icon: any; label: string; value: string; hint: string; progress?: number }) {
  return <Card className="border-border/70 shadow-sm"><CardContent className="p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs font-medium text-muted-foreground">{label}</span><Icon className="h-4 w-4 text-primary" /></div><p className="text-2xl font-bold tabular-nums">{value}</p>{progress != null && <Progress value={progress} className="mt-3 h-1.5" />}<p className="mt-2 text-[11px] text-muted-foreground">{hint}</p></CardContent></Card>;
}

function PerformanceMetric({ label, value, good }: { label: string; value: string; good: boolean }) {
  return <div className="rounded-xl border border-border/60 bg-muted/20 p-3 text-center"><p className="truncate text-[10px] text-muted-foreground">{label}</p><p className={cn('mt-1 text-lg font-bold tabular-nums', good ? 'text-emerald-600' : 'text-foreground')}>{value}</p></div>;
}

function SmallMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-muted/50 p-2"><p className="truncate text-[10px] text-muted-foreground">{label}</p><p className="mt-1 font-semibold tabular-nums">{value}</p></div>;
}

function RecentListCard({ title, description, href, icon: Icon, loading, empty, emptyText, viewAll, children }: { title: string; description: string; href: string; icon: any; loading: boolean; empty: boolean; emptyText: string; viewAll: string; children: ReactNode }) {
  return <Card className="border-border/70 shadow-sm"><CardHeader className="flex flex-row items-start justify-between gap-3 pb-1"><div><CardTitle className="flex items-center gap-2 text-base"><Icon className="h-4 w-4 text-primary" />{title}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{description}</p></div><Link to={href} className="shrink-0 text-xs font-medium text-primary hover:underline">{viewAll}</Link></CardHeader><CardContent>{loading ? <ListSkeleton /> : empty ? <EmptyState icon={Icon} text={emptyText} compact /> : children}</CardContent></Card>;
}

function EmptyState({ icon: Icon, text, compact = false }: { icon: any; text: string; compact?: boolean }) {
  return <div className={cn('flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-4 text-center text-muted-foreground', compact ? 'min-h-32 py-5' : 'min-h-[270px] py-8')}><Icon className="mb-2 h-6 w-6 opacity-50" /><p className="text-xs">{text}</p></div>;
}

function ChartSkeleton({ compact = false }: { compact?: boolean }) {
  return <div className={cn('flex items-center justify-center rounded-xl bg-muted/30', compact ? 'h-[180px]' : 'h-[270px]')}><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
}

function ListSkeleton() {
  return <div className="space-y-3 py-2">{[0, 1, 2, 3].map((item) => <div key={item} className="flex animate-pulse items-center gap-3"><div className="h-9 w-9 rounded-xl bg-muted" /><div className="flex-1 space-y-2"><div className="h-3 w-1/3 rounded bg-muted" /><div className="h-2.5 w-2/3 rounded bg-muted" /></div></div>)}</div>;
}
