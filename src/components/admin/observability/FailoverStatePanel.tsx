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
import { useTranslation } from '@/i18n';

const PROVIDER_LABEL: Record<RealtimeProviderId, string> = {
  centrifugo: 'Centrifugo',
  supabase_realtime: 'Supabase Realtime',
  polling_builtin: 'Polling',
};

function statusBadge(status: string, label: string) {
  if (status === 'healthy') return <Badge className="bg-success/15 text-success">{label}</Badge>;
  if (status === 'degraded') return <Badge className="bg-warning/15 text-warning">{label}</Badge>;
  if (status === 'unhealthy') return <Badge variant="destructive">{label}</Badge>;
  return <Badge variant="outline">{label}</Badge>;
}

function fmtMs(ms: number, ready: string): string {
  if (ms <= 0) return ready;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function fmtTime(ts: string | null, locale: string): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(locale);
  } catch {
    return ts;
  }
}

export default function FailoverStatePanel() {
  const { t, locale } = useTranslation();
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
        title: t('admin.observability.realtimeControl.failover.evaluated' as any),
        description: t('admin.observability.realtimeControl.failover.effectiveSummary' as any, {
          provider: effective_provider,
        }),
      });
    },
    onError: (err: Error) =>
      toast({
        title: t('admin.observability.realtimeControl.failover.evaluateFailed' as any),
        description: err.message,
        variant: 'destructive',
      }),
  });

  if (q.isLoading) {
    return (
      <p className="text-muted-foreground text-sm">
        {t('admin.observability.realtimeControl.failover.loading' as any)}
      </p>
    );
  }
  if (q.error || !q.data) {
    return (
      <p className="text-destructive text-sm">{t('admin.observability.realtimeControl.failover.loadFailed' as any)}</p>
    );
  }

  const s = q.data;
  const healthEntries: Array<[RealtimeProviderId, RealtimeFailoverProviderHealth | undefined]> = s.provider_order.map(
    (p) => [p, s.last_health?.[p] as RealtimeFailoverProviderHealth | undefined],
  );

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="flex-row items-start justify-between">
          <div>
            <CardTitle className="text-foreground text-sm">
              {t('admin.observability.realtimeControl.failover.title' as any)}
            </CardTitle>
            <CardDescription>{t('admin.observability.realtimeControl.failover.description' as any)}</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => evalMut.mutate()} disabled={evalMut.isPending}>
            <RefreshCw className={`h-3.5 w-3.5 me-2 ${evalMut.isPending ? 'animate-spin' : ''}`} />
            {t('admin.observability.realtimeControl.failover.reevaluate' as any)}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {s.provider_lock && (
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
              <Lock className="h-4 w-4 text-warning mt-0.5" />
              <div>
                <p className="text-sm text-foreground font-medium">
                  {t('admin.observability.realtimeControl.failover.lockActive' as any)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('admin.observability.realtimeControl.failover.lockedTo' as any)}{' '}
                  <span className="font-mono">{s.provider_lock}</span>.{' '}
                  {t('admin.observability.realtimeControl.failover.clearLockHint' as any)}
                </p>
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">
                {t('admin.observability.realtimeControl.effective' as any)}
              </p>
              <p className="font-mono text-sm text-foreground">{s.effective_provider}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">
                {t('admin.observability.realtimeControl.failover.enabled' as any)}
              </p>
              <p className="text-sm text-foreground">
                {s.failover_enabled
                  ? t('admin.observability.realtimeControl.yes' as any)
                  : t('admin.observability.realtimeControl.no' as any)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">
                {t('admin.observability.realtimeControl.failover.cooldownRemaining' as any)}
              </p>
              <p className="font-mono text-sm text-foreground">
                {fmtMs(s.cooldown_remaining_ms, t('admin.observability.realtimeControl.failover.ready' as any))}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">
                {t('admin.observability.realtimeControl.failover.failbackIn' as any)}
              </p>
              <p className="font-mono text-sm text-foreground">
                {s.candidate_recovery_provider
                  ? fmtMs(s.failback_remaining_ms, t('admin.observability.realtimeControl.failover.ready' as any))
                  : '—'}
              </p>
            </div>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-2">
              {t('admin.observability.realtimeControl.failover.providerHealth' as any)}
            </p>
            <div className="space-y-2">
              {healthEntries.map(([p, h]) => (
                <div key={p} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-foreground">
                      {p === 'polling_builtin'
                        ? t('admin.observability.realtimeControl.pollingBuiltin' as any)
                        : PROVIDER_LABEL[p]}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">{p}</span>
                    {p === s.effective_provider && (
                      <Badge variant="outline" className="text-xs">
                        {t('admin.observability.realtimeControl.failover.active' as any)}
                      </Badge>
                    )}
                    {p === s.candidate_recovery_provider && (
                      <Badge variant="outline" className="text-xs">
                        {t('admin.observability.realtimeControl.failover.recoveryCandidate' as any)}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {h?.error_rate !== null && h?.error_rate !== undefined && (
                      <span className="text-xs text-muted-foreground font-mono">
                        {t('admin.observability.realtimeControl.failover.errorRateShort' as any)}{' '}
                        {(h.error_rate * 100).toLocaleString(locale, { maximumFractionDigits: 1 })}%
                      </span>
                    )}
                    {h?.p95_latency_ms !== null && h?.p95_latency_ms !== undefined && (
                      <span className="text-xs text-muted-foreground font-mono">p95 {h.p95_latency_ms}ms</span>
                    )}
                    {statusBadge(
                      h?.status ?? 'unknown',
                      t(`admin.observability.realtimeControl.status.${h?.status ?? 'unknown'}` as any),
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground">
                {t('admin.observability.realtimeControl.failover.lastSwitch' as any)}
              </p>
              <p className="text-sm text-foreground">{fmtTime(s.last_failover_at, locale)}</p>
              {s.last_failover_reason && (
                <p className="text-xs text-muted-foreground font-mono">{s.last_failover_reason}</p>
              )}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">
                {t('admin.observability.realtimeControl.failover.lastEvaluated' as any)}
              </p>
              <p className="text-sm text-foreground">{fmtTime(s.last_evaluated_at, locale)}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
