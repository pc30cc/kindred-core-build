/**
 * Phase 6B — Failover engine state panel.
 * Shows current effective provider, per-provider health, cooldown timer,
 * failback timer, and last switch summary. Read-only (no manual switch
 * button per scope).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Lock, RefreshCw } from 'lucide-react';
import {
  realtimeControlApi,
  type RealtimeFailoverProviderHealth,
  type RealtimeProviderId,
} from '@/lib/realtime-control-api';

const PROVIDER_LABEL: Record<RealtimeProviderId, string> = {
  centrifugo: 'Centrifugo',
  supabase_realtime: 'Supabase Realtime',
  polling_builtin: 'Polling (built-in)',
};

function statusBadge(status: string) {
  if (status === 'healthy') return <Badge className="bg-success/15 text-success">healthy</Badge>;
  if (status === 'degraded') return <Badge className="bg-warning/15 text-warning">degraded</Badge>;
  if (status === 'unhealthy') return <Badge variant="destructive">unhealthy</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function fmtMs(ms: number): string {
  if (ms <= 0) return 'ready';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function fmtTime(ts: string | null): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

export default function FailoverStatePanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({
    queryKey: ['admin-realtime-failover'],
    queryFn: () => realtimeControlApi.failover(),
    refetchInterval: 15_000,
  });
  const evalMut = useMutation({
    mutationFn: () => realtimeControlApi.evaluateFailover(),
    onSuccess: ({ effective_provider }) => {
      qc.invalidateQueries({ queryKey: ['admin-realtime-failover'] });
      qc.invalidateQueries({ queryKey: ['admin-realtime-control'] });
      qc.invalidateQueries({ queryKey: ['admin-realtime-control-audit'] });
      toast({
        title: 'Failover engine evaluated',
        description: `Effective provider: ${effective_provider}`,
      });
    },
    onError: (err: Error) =>
      toast({ title: 'Evaluate failed', description: err.message, variant: 'destructive' }),
  });

  if (q.isLoading) {
    return <p className="text-muted-foreground text-sm">Loading failover state…</p>;
  }
  if (q.error || !q.data) {
    return <p className="text-destructive text-sm">Failed to load failover state.</p>;
  }

  const s = q.data;
  const healthEntries: Array<[RealtimeProviderId, RealtimeFailoverProviderHealth | undefined]> =
    s.provider_order.map((p) => [p, s.last_health?.[p] as RealtimeFailoverProviderHealth | undefined]);

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="flex-row items-start justify-between">
          <div>
            <CardTitle className="text-foreground text-sm">Failover engine</CardTitle>
            <CardDescription>
              Effective provider, per-provider health, cooldowns, and last switch.
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => evalMut.mutate()}
            disabled={evalMut.isPending}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-2 ${evalMut.isPending ? 'animate-spin' : ''}`} />
            Re-evaluate now
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {s.provider_lock && (
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
              <Lock className="h-4 w-4 text-warning mt-0.5" />
              <div>
                <p className="text-sm text-foreground font-medium">
                  Manual lock active — automation overridden
                </p>
                <p className="text-xs text-muted-foreground">
                  Locked to <span className="font-mono">{s.provider_lock}</span>. Clear the lock in
                  the Provider priority section to re-enable automatic failover.
                </p>
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Effective provider</p>
              <p className="font-mono text-sm text-foreground">{s.effective_provider}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Failover enabled</p>
              <p className="text-sm text-foreground">{s.failover_enabled ? 'yes' : 'no'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Cooldown remaining</p>
              <p className="font-mono text-sm text-foreground">
                {fmtMs(s.cooldown_remaining_ms)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Failback in</p>
              <p className="font-mono text-sm text-foreground">
                {s.candidate_recovery_provider
                  ? fmtMs(s.failback_remaining_ms)
                  : '—'}
              </p>
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-2">Per-provider health</p>
            <div className="space-y-2">
              {healthEntries.map(([p, h]) => (
                <div
                  key={p}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-foreground">{PROVIDER_LABEL[p]}</span>
                    <span className="font-mono text-xs text-muted-foreground">{p}</span>
                    {p === s.effective_provider && (
                      <Badge variant="outline" className="text-xs">active</Badge>
                    )}
                    {p === s.candidate_recovery_provider && (
                      <Badge variant="outline" className="text-xs">recovery candidate</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {h?.error_rate !== null && h?.error_rate !== undefined && (
                      <span className="text-xs text-muted-foreground font-mono">
                        err {(h.error_rate * 100).toFixed(1)}%
                      </span>
                    )}
                    {h?.p95_latency_ms !== null && h?.p95_latency_ms !== undefined && (
                      <span className="text-xs text-muted-foreground font-mono">
                        p95 {h.p95_latency_ms}ms
                      </span>
                    )}
                    {statusBadge(h?.status ?? 'unknown')}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground">Last switch</p>
              <p className="text-sm text-foreground">{fmtTime(s.last_failover_at)}</p>
              {s.last_failover_reason && (
                <p className="text-xs text-muted-foreground font-mono">
                  {s.last_failover_reason}
                </p>
              )}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Last evaluated</p>
              <p className="text-sm text-foreground">{fmtTime(s.last_evaluated_at)}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}