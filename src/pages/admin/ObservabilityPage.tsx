import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchMetricsSummary, fetchMetricsEvents } from '@/lib/admin-metrics-api';
import AlertsPanel from '@/components/admin/observability/AlertsPanel';
import PerformancePanel from '@/components/admin/observability/PerformancePanel';
import AutoActionsPanel from '@/components/admin/observability/AutoActionsPanel';
import SystemDegradedBanner from '@/components/admin/observability/SystemDegradedBanner';
import RealtimeControlPanel from '@/components/admin/observability/RealtimeControlPanel';
import EffectivePolicyPanel from '@/components/admin/observability/EffectivePolicyPanel';
import ReliabilityPanel from '@/components/admin/observability/ReliabilityPanel';
import EnforcementPanel from '@/components/admin/observability/EnforcementPanel';
import { useTranslation } from '@/i18n';

type Range = '1h' | '24h' | '7d';

export default function AdminObservabilityPage() {
  const { t } = useTranslation();
  const [range, setRange] = useState<Range>('1h');
  const [filter, setFilter] = useState<string>('');
  const [tab, setTab] = useState<
    'metrics' | 'performance' | 'alerts' | 'auto-actions' | 'realtime-control' | 'reliability' | 'enforcement'
  >('metrics');

  const summaryQ = useQuery({
    queryKey: ['admin-metrics-summary', range],
    queryFn: () => fetchMetricsSummary(range),
    refetchInterval: 30_000,
  });

  const eventsQ = useQuery({
    queryKey: ['admin-metrics-events', filter],
    queryFn: () => fetchMetricsEvents({ metric: filter || undefined, limit: 100 }),
    refetchInterval: 30_000,
  });

  const counts = summaryQ.data?.counts || {};
  const metricNames = Object.keys(counts).sort();

  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-bold text-foreground">{t('admin.observability.title' as any)}</h1><p className="mt-1 text-sm text-muted-foreground">{t('admin.observability.subtitle' as any)}</p></div>
      <SystemDegradedBanner />
      <EffectivePolicyPanel />
      <Tabs
        value={tab}
        onValueChange={(v) =>
          setTab(
            v as
              | 'metrics'
              | 'performance'
              | 'alerts'
              | 'auto-actions'
              | 'realtime-control'
              | 'reliability'
              | 'enforcement',
          )
        }
      >
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-xl bg-muted/70 p-1.5">
          <TabsTrigger value="metrics">{t('admin.observability.tabs.metrics' as any)}</TabsTrigger>
          <TabsTrigger value="performance">{t('admin.observability.tabs.performance' as any)}</TabsTrigger>
          <TabsTrigger value="alerts">{t('admin.observability.tabs.alerts' as any)}</TabsTrigger>
          <TabsTrigger value="auto-actions">{t('admin.observability.tabs.autoActions' as any)}</TabsTrigger>
          <TabsTrigger value="realtime-control">{t('admin.observability.tabs.realtimeControl' as any)}</TabsTrigger>
          <TabsTrigger value="reliability">{t('admin.observability.tabs.reliability' as any)}</TabsTrigger>
          <TabsTrigger value="enforcement">{t('admin.observability.tabs.enforcement' as any)}</TabsTrigger>
        </TabsList>
        <TabsContent value="metrics" className="space-y-6">
          <div className="flex items-center justify-end">
            <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
              <TabsList>
                <TabsTrigger value="1h">{t('admin.observability.ranges.hour' as any)}</TabsTrigger>
                <TabsTrigger value="24h">{t('admin.observability.ranges.day' as any)}</TabsTrigger>
                <TabsTrigger value="7d">{t('admin.observability.ranges.week' as any)}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">{t('admin.observability.metrics.counters' as any, { range })}</CardTitle>
        </CardHeader>
        <CardContent>
          {summaryQ.isLoading && <p className="text-muted-foreground text-sm">{t('admin.common.loading' as any)}</p>}
          {summaryQ.error && (
            <p className="text-destructive text-sm">{t('admin.observability.metrics.loadFailed' as any)}</p>
          )}
          {!summaryQ.isLoading && metricNames.length === 0 && (
            <p className="text-muted-foreground text-sm">{t('admin.observability.metrics.emptyRange' as any)}</p>
          )}
          <div className="space-y-2">
            {metricNames.map((m) => (
              <div
                key={m}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2"
              >
                <button
                  onClick={() => setFilter(m === filter ? '' : m)}
                  className="text-left"
                >
                  <span className="font-mono text-sm text-foreground">{m}</span>
                  {filter === m && (
                    <Badge variant="outline" className="ms-2">{t('admin.observability.metrics.filtered' as any)}</Badge>
                  )}
                </button>
                <div className="flex items-center gap-2">
                  <Badge className="bg-primary/15 text-primary">{counts[m].total}</Badge>
                  {Object.entries(counts[m].by_driver).map(([d, c]) => (
                    <Badge key={d} variant="outline" className="text-xs">
                      {d}: {c}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-foreground text-sm">
            {t('admin.observability.metrics.recentEvents' as any)} {filter ? `· ${filter}` : ''}
          </CardTitle>
          {filter && (
            <Button size="sm" variant="ghost" onClick={() => setFilter('')}>
              {t('admin.observability.metrics.clearFilter' as any)}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.common.time' as any)}</TableHead>
                <TableHead>{t('admin.observability.metrics.metric' as any)}</TableHead>
                <TableHead>{t('admin.observability.metrics.driver' as any)}</TableHead>
                <TableHead>{t('admin.observability.metrics.source' as any)}</TableHead>
                <TableHead>{t('admin.observability.metrics.tags' as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(eventsQ.data?.events || []).map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                    {new Date(e.occurred_at).toLocaleTimeString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.metric}</TableCell>
                  <TableCell className="text-xs">{e.driver || '—'}</TableCell>
                  <TableCell className="text-xs">{e.source}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[400px] truncate">
                    {Object.keys(e.tags || {}).length
                      ? JSON.stringify(e.tags)
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
              {!eventsQ.isLoading && (eventsQ.data?.events.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground text-sm">
                    {t('admin.observability.metrics.noEvents' as any)}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
        </TabsContent>
        <TabsContent value="alerts">
          <AlertsPanel />
        </TabsContent>
        <TabsContent value="performance">
          <PerformancePanel />
        </TabsContent>
        <TabsContent value="auto-actions">
          <AutoActionsPanel />
        </TabsContent>
        <TabsContent value="realtime-control">
          <RealtimeControlPanel />
        </TabsContent>
        <TabsContent value="reliability">
          <ReliabilityPanel />
        </TabsContent>
        <TabsContent value="enforcement">
          <EnforcementPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
