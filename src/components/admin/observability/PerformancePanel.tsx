import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  fetchPerfSummary,
  fetchPerfProcess,
  triggerPerfRollup,
  type PerfRange,
} from '@/lib/admin-perf-api';
import { RefreshCw, Activity, Cpu, MemoryStick } from 'lucide-react';

function formatBytes(n: number): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function latencyTone(ms: number): string {
  if (ms >= 1500) return 'bg-destructive/15 text-destructive';
  if (ms >= 800) return 'bg-warning/15 text-warning';
  return 'bg-primary/10 text-primary';
}

function errorRateTone(rate: number): string {
  if (rate >= 0.05) return 'bg-destructive/15 text-destructive';
  if (rate >= 0.01) return 'bg-warning/15 text-warning';
  return 'bg-muted text-muted-foreground';
}

export default function PerformancePanel() {
  const [range, setRange] = useState<PerfRange>('1h');

  const summaryQ = useQuery({
    queryKey: ['admin-perf-summary', range],
    queryFn: () => fetchPerfSummary(range),
    refetchInterval: 30_000,
  });

  const processQ = useQuery({
    queryKey: ['admin-perf-process', range],
    queryFn: () => fetchPerfProcess(range),
    refetchInterval: 30_000,
  });

  const rows = summaryQ.data?.rows || [];
  const latest = processQ.data?.latest;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Tabs value={range} onValueChange={(v) => setRange(v as PerfRange)}>
            <TabsList>
              <TabsTrigger value="1h">Last hour</TabsTrigger>
              <TabsTrigger value="24h">24h</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await triggerPerfRollup();
            await summaryQ.refetch();
          }}
        >
          <RefreshCw className="mr-2 h-3 w-3" /> Run rollup
        </Button>
      </div>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm">
            Endpoint latency ({range})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {summaryQ.isLoading && (
            <p className="text-muted-foreground text-sm">Loading…</p>
          )}
          {summaryQ.error && (
            <p className="text-destructive text-sm">Failed to load summary.</p>
          )}
          {!summaryQ.isLoading && rows.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No instrumented requests recorded in this range.
            </p>
          )}
          {rows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Endpoint</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                  <TableHead className="text-right">p50</TableHead>
                  <TableHead className="text-right">p95</TableHead>
                  <TableHead className="text-right">p99</TableHead>
                  <TableHead className="text-right">Max</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={`${r.route_group}|${r.method}`}>
                    <TableCell>
                      <div className="font-mono text-xs">{r.route_group}</div>
                      <div className="text-muted-foreground text-[10px]">
                        {r.method}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-xs">{r.count}</TableCell>
                    <TableCell className="text-right">
                      <Badge className={latencyTone(r.p50)}>{r.p50} ms</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge className={latencyTone(r.p95)}>{r.p95} ms</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge className={latencyTone(r.p99)}>{r.p99} ms</Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {r.max_ms} ms
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge className={errorRateTone(r.error_rate)}>
                        {r.error_count} ({(r.error_rate * 100).toFixed(2)}%)
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-sm flex items-center gap-2">
            <Activity className="h-4 w-4" /> Process metrics (latest sample)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {processQ.isLoading && (
            <p className="text-muted-foreground text-sm">Loading…</p>
          )}
          {!processQ.isLoading && !latest && (
            <p className="text-muted-foreground text-sm">
              No process samples yet (sampled every 60s).
            </p>
          )}
          {latest && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-md border border-border p-3">
                <div className="text-muted-foreground text-xs flex items-center gap-1">
                  <Cpu className="h-3 w-3" /> Event loop lag
                </div>
                <div className="text-foreground text-lg font-semibold">
                  {latest.event_loop_lag_ms.toFixed(2)} ms
                </div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-muted-foreground text-xs flex items-center gap-1">
                  <MemoryStick className="h-3 w-3" /> RSS
                </div>
                <div className="text-foreground text-lg font-semibold">
                  {formatBytes(latest.rss_bytes)}
                </div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-muted-foreground text-xs">Heap used</div>
                <div className="text-foreground text-lg font-semibold">
                  {formatBytes(latest.heap_used_bytes)}{' '}
                  <span className="text-muted-foreground text-xs">
                    / {formatBytes(latest.heap_total_bytes)}
                  </span>
                </div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-muted-foreground text-xs">Uptime</div>
                <div className="text-foreground text-lg font-semibold">
                  {Math.floor(latest.uptime_seconds / 3600)}h{' '}
                  {Math.floor((latest.uptime_seconds % 3600) / 60)}m
                </div>
              </div>
            </div>
          )}
          {processQ.data && processQ.data.samples.length > 1 && (
            <p className="text-muted-foreground text-xs mt-3">
              {processQ.data.samples.length} samples in selected range.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
