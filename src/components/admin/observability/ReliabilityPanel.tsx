import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  fetchSla,
  fetchBusinessMetrics,
  fetchWorkspaceHealth,
  fetchSlos,
  triggerReliabilityRollup,
} from '@/lib/admin-reliability-api';
import { useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from '@/i18n';

function fmtPct(v: number | null | undefined, locale: string) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toLocaleString(locale, { maximumFractionDigits: 2 })}%`;
}
function fmtNum(v: number | null | undefined, locale: string, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Number(v).toLocaleString(locale, { maximumFractionDigits: digits });
}
function fmtSecs(
  v: number | null | undefined,
  locale: string,
  units: { second: string; minute: string; hour: string },
) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v < 60) return `${v.toLocaleString(locale, { maximumFractionDigits: 1 })} ${units.second}`;
  if (v < 3600) return `${(v / 60).toLocaleString(locale, { maximumFractionDigits: 1 })} ${units.minute}`;
  return `${(v / 3600).toLocaleString(locale, { maximumFractionDigits: 1 })} ${units.hour}`;
}
function stateColor(s: string) {
  if (s === 'healthy') return 'bg-success/20 text-success';
  if (s === 'warning') return 'bg-warning/20 text-warning';
  return 'bg-destructive/20 text-destructive';
}

export default function ReliabilityPanel() {
  const [range] = useState<'24h' | '7d'>('24h');
  const { toast } = useToast();
  const { t, locale } = useTranslation();
  const units = {
    second: t('admin.observability.reliability.units.second' as any),
    minute: t('admin.observability.reliability.units.minute' as any),
    hour: t('admin.observability.reliability.units.hour' as any),
  };

  const slaQ = useQuery({ queryKey: ['admin-sla', range], queryFn: () => fetchSla(range), refetchInterval: 60_000 });
  const bizQ = useQuery({
    queryKey: ['admin-business', range],
    queryFn: () => fetchBusinessMetrics(range),
    refetchInterval: 60_000,
  });
  const healthQ = useQuery({
    queryKey: ['admin-workspace-health'],
    queryFn: () => fetchWorkspaceHealth(),
    refetchInterval: 60_000,
  });
  const slosQ = useQuery({ queryKey: ['admin-slos'], queryFn: () => fetchSlos(), refetchInterval: 120_000 });

  const sla = slaQ.data?.summary;
  const biz = bizQ.data?.summary;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('admin.observability.reliability.description' as any)}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            try {
              await triggerReliabilityRollup();
              toast({ title: t('admin.observability.reliability.rollupTriggered' as any) });
              slaQ.refetch();
              bizQ.refetch();
              healthQ.refetch();
            } catch (e: any) {
              toast({
                title: t('admin.observability.reliability.rollupFailed' as any),
                description: e.message,
                variant: 'destructive',
              });
            }
          }}
        >
          {t('admin.observability.reliability.runRollup' as any)}
        </Button>
      </div>

      {/* SLA */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">
            {t('admin.observability.reliability.platformSla' as any)} · {t('admin.observability.ranges.day' as any)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {slaQ.isLoading && <p className="text-muted-foreground text-sm">{t('admin.common.loading' as any)}</p>}
          {sla && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label={t('admin.observability.reliability.uptime' as any)} value={fmtPct(sla.uptime_pct, locale)} />
              <Stat
                label={t('admin.observability.reliability.realtimeAvailability' as any)}
                value={fmtPct(sla.realtime_availability_pct, locale)}
              />
              <Stat
                label={t('admin.observability.reliability.degradedMinutes' as any)}
                value={fmtNum(sla.degraded_minutes, locale)}
              />
              <Stat
                label={t('admin.observability.reliability.forcedPollingMinutes' as any)}
                value={fmtNum(sla.forced_polling_minutes, locale)}
              />
              <Stat
                label={t('admin.observability.reliability.criticalAlerts' as any)}
                value={sla.critical_alert_count.toLocaleString(locale)}
              />
              <Stat
                label={t('admin.observability.reliability.warningAlerts' as any)}
                value={sla.warn_alert_count.toLocaleString(locale)}
              />
              <Stat
                label={t('admin.observability.reliability.failovers' as any)}
                value={sla.failover_count.toLocaleString(locale)}
              />
              <Stat
                label={t('admin.observability.reliability.meanRecovery' as any)}
                value={fmtSecs(sla.mean_failover_recovery_seconds, locale, units)}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Business metrics */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">
            {t('admin.observability.reliability.businessKpis' as any)} · {t('admin.observability.ranges.day' as any)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {bizQ.isLoading && <p className="text-muted-foreground text-sm">{t('admin.common.loading' as any)}</p>}
          {biz && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat
                label={t('admin.observability.reliability.newConversations' as any)}
                value={biz.new_conversations.toLocaleString(locale)}
              />
              <Stat
                label={t('admin.observability.reliability.resolved' as any)}
                value={biz.resolved_conversations.toLocaleString(locale)}
              />
              <Stat
                label={t('admin.observability.reliability.unanswered' as any)}
                value={biz.unanswered_conversations.toLocaleString(locale)}
              />
              <Stat
                label={t('admin.observability.reliability.staleOpen' as any)}
                value={biz.stale_open_conversations.toLocaleString(locale)}
              />
              <Stat
                label={t('admin.observability.reliability.messagesSent' as any)}
                value={biz.messages_sent.toLocaleString(locale)}
              />
              <Stat
                label={t('admin.observability.reliability.frtP50' as any)}
                value={fmtSecs(biz.avg_first_response_p50, locale, units)}
              />
              <Stat
                label={t('admin.observability.reliability.frtP95' as any)}
                value={fmtSecs(biz.avg_first_response_p95, locale, units)}
              />
              <Stat
                label={t('admin.observability.reliability.avgResolution' as any)}
                value={fmtSecs(biz.avg_resolution_seconds, locale, units)}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Workspace Health */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">
            {t('admin.observability.reliability.workspaceHealth' as any)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {healthQ.isLoading && <p className="text-muted-foreground text-sm">{t('admin.common.loading' as any)}</p>}
          {healthQ.data && (
            <>
              <div className="flex items-center gap-2">
                <Badge className="bg-success/20 text-success">
                  {t('admin.observability.reliability.healthyCount' as any, { count: healthQ.data.counts.healthy })}
                </Badge>
                <Badge className="bg-warning/20 text-warning">
                  {t('admin.observability.reliability.warningCount' as any, { count: healthQ.data.counts.warning })}
                </Badge>
                <Badge className="bg-destructive/20 text-destructive">
                  {t('admin.observability.reliability.atRiskCount' as any, { count: healthQ.data.counts.at_risk })}
                </Badge>
                <span className="text-xs text-muted-foreground ms-auto">
                  {t('admin.observability.reliability.trackedWorkspaces' as any, { count: healthQ.data.total })}
                </span>
              </div>
              {healthQ.data.at_risk.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('admin.observability.reliability.workspace' as any)}</TableHead>
                      <TableHead>{t('admin.observability.reliability.score' as any)}</TableHead>
                      <TableHead>{t('admin.observability.reliability.state' as any)}</TableHead>
                      <TableHead>{t('admin.observability.reliability.captured' as any)}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {healthQ.data.at_risk.map((w) => (
                      <TableRow key={w.id}>
                        <TableCell className="font-mono text-xs">{w.workspace_id}</TableCell>
                        <TableCell>{w.health_score}</TableCell>
                        <TableCell>
                          <Badge className={stateColor(w.state)}>
                            {t(`admin.observability.reliability.states.${w.state}` as any)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(w.captured_at).toLocaleString(locale)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-muted-foreground text-sm">
                  {t('admin.observability.reliability.allHealthy' as any)}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* SLOs */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">{t('admin.observability.reliability.slos' as any)}</CardTitle>
        </CardHeader>
        <CardContent>
          {slosQ.isLoading && <p className="text-muted-foreground text-sm">{t('admin.common.loading' as any)}</p>}
          {slosQ.data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SLO</TableHead>
                  <TableHead>{t('admin.observability.reliability.scope' as any)}</TableHead>
                  <TableHead>{t('admin.observability.reliability.target' as any)}</TableHead>
                  <TableHead>{t('admin.observability.reliability.window' as any)}</TableHead>
                  <TableHead>{t('admin.observability.reliability.enabled' as any)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slosQ.data.slos.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="font-medium text-foreground text-sm">{s.title}</div>
                      <div className="text-xs text-muted-foreground font-mono">{s.slug}</div>
                    </TableCell>
                    <TableCell className="text-xs">{s.scope_type}</TableCell>
                    <TableCell className="text-xs">
                      {s.target_type === 'min' ? '≥' : '≤'} {s.target_value}
                    </TableCell>
                    <TableCell className="text-xs">
                      {Math.round(s.window_seconds / 3600).toLocaleString(locale)} {units.hour}
                    </TableCell>
                    <TableCell>
                      <Badge variant={s.enabled ? 'default' : 'outline'}>
                        {s.enabled
                          ? t('admin.observability.reliability.on' as any)
                          : t('admin.observability.reliability.off' as any)}
                      </Badge>
                    </TableCell>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-foreground font-medium">{value}</div>
    </div>
  );
}
