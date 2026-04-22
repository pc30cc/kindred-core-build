import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  fetchSla,
  fetchBusinessMetrics,
  fetchWorkspaceHealth,
  fetchSlos,
  triggerReliabilityRollup,
} from '@/lib/admin-reliability-api';
import { useState } from 'react';
import { useToast } from '@/hooks/use-toast';

function fmtPct(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(2)}%`;
}
function fmtNum(v: number | null | undefined, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Number(v).toFixed(digits);
}
function fmtSecs(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v < 60) return `${v.toFixed(1)}s`;
  if (v < 3600) return `${(v / 60).toFixed(1)}m`;
  return `${(v / 3600).toFixed(1)}h`;
}
function stateColor(s: string) {
  if (s === 'healthy') return 'bg-success/20 text-success';
  if (s === 'warning') return 'bg-warning/20 text-warning';
  return 'bg-destructive/20 text-destructive';
}

export default function ReliabilityPanel() {
  const [range] = useState<'24h' | '7d'>('24h');
  const { toast } = useToast();

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
        <p className="text-sm text-muted-foreground">
          SLA, reliability and business KPIs derived from the existing observability layer.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            try {
              await triggerReliabilityRollup();
              toast({ title: 'Rollup triggered' });
              slaQ.refetch();
              bizQ.refetch();
              healthQ.refetch();
            } catch (e: any) {
              toast({ title: 'Rollup failed', description: e.message, variant: 'destructive' });
            }
          }}
        >
          Run rollup now
        </Button>
      </div>

      {/* SLA */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">Platform SLA · {range}</CardTitle>
        </CardHeader>
        <CardContent>
          {slaQ.isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {sla && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Uptime" value={fmtPct(sla.uptime_pct)} />
              <Stat label="Realtime availability" value={fmtPct(sla.realtime_availability_pct)} />
              <Stat label="Degraded minutes" value={fmtNum(sla.degraded_minutes)} />
              <Stat label="Forced polling minutes" value={fmtNum(sla.forced_polling_minutes)} />
              <Stat label="Critical alerts" value={String(sla.critical_alert_count)} />
              <Stat label="Warn alerts" value={String(sla.warn_alert_count)} />
              <Stat label="Failovers" value={String(sla.failover_count)} />
              <Stat label="Mean recovery" value={fmtSecs(sla.mean_failover_recovery_seconds)} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Business metrics */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">Business KPIs · {range}</CardTitle>
        </CardHeader>
        <CardContent>
          {bizQ.isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {biz && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="New conversations" value={String(biz.new_conversations)} />
              <Stat label="Resolved" value={String(biz.resolved_conversations)} />
              <Stat label="Unanswered" value={String(biz.unanswered_conversations)} />
              <Stat label="Stale open" value={String(biz.stale_open_conversations)} />
              <Stat label="Messages sent" value={String(biz.messages_sent)} />
              <Stat label="FRT p50" value={fmtSecs(biz.avg_first_response_p50)} />
              <Stat label="FRT p95" value={fmtSecs(biz.avg_first_response_p95)} />
              <Stat label="Avg resolution" value={fmtSecs(biz.avg_resolution_seconds)} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Workspace Health */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">Workspace Health</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {healthQ.isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {healthQ.data && (
            <>
              <div className="flex items-center gap-2">
                <Badge className="bg-success/20 text-success">
                  Healthy: {healthQ.data.counts.healthy}
                </Badge>
                <Badge className="bg-warning/20 text-warning">
                  Warning: {healthQ.data.counts.warning}
                </Badge>
                <Badge className="bg-destructive/20 text-destructive">
                  At risk: {healthQ.data.counts.at_risk}
                </Badge>
                <span className="text-xs text-muted-foreground ml-auto">
                  {healthQ.data.total} workspaces tracked
                </span>
              </div>
              {healthQ.data.at_risk.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Workspace</TableHead>
                      <TableHead>Score</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Captured</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {healthQ.data.at_risk.map((w) => (
                      <TableRow key={w.id}>
                        <TableCell className="font-mono text-xs">{w.workspace_id}</TableCell>
                        <TableCell>{w.health_score}</TableCell>
                        <TableCell>
                          <Badge className={stateColor(w.state)}>{w.state}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(w.captured_at).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-muted-foreground text-sm">All workspaces healthy.</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* SLOs */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">Service Level Objectives</CardTitle>
        </CardHeader>
        <CardContent>
          {slosQ.isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {slosQ.data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SLO</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead>Enabled</TableHead>
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
                    <TableCell className="text-xs">{Math.round(s.window_seconds / 3600)}h</TableCell>
                    <TableCell>
                      <Badge variant={s.enabled ? 'default' : 'outline'}>
                        {s.enabled ? 'on' : 'off'}
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