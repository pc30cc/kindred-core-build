/**
 * Super Admin — Channels runtime panel.
 *
 * Shows the operational truth an operator needs when a Telegram bot "stops
 * working": queue depth, worker liveness, dead-lettered jobs, and every
 * integration with its verification and error state. Credentials are never
 * part of this surface.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@/i18n';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { formatDateTime } from '@/lib/date';
import { adminPluginsApi, type ChannelIntegrationRow } from '@/lib/plugins-api';
import { Activity, AlertTriangle, PlugZap, ServerCog } from 'lucide-react';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  connected: 'default',
  pending: 'secondary',
  disconnected: 'outline',
  error: 'destructive',
};

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: 'warn' | 'bad' }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          'text-xl font-semibold ' +
          (tone === 'bad' ? 'text-destructive' : tone === 'warn' ? 'text-amber-600' : '')
        }
      >
        {value}
      </p>
    </div>
  );
}

export function ChannelsRuntimePanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const health = useQuery({
    queryKey: ['admin', 'channels', 'health'],
    queryFn: () => adminPluginsApi.channelsHealth(),
    refetchInterval: 15_000,
  });

  const integrations = useQuery({
    queryKey: ['admin', 'channels', 'integrations'],
    queryFn: () => adminPluginsApi.channelIntegrations(),
    refetchInterval: 60_000,
  });

  const forceDisconnect = useMutation({
    mutationFn: (integrationId: string) => adminPluginsApi.forceDisconnect(integrationId),
    onSuccess: () => {
      toast({ title: t('plugins.runtime.disconnected') });
      qc.invalidateQueries({ queryKey: ['admin', 'channels'] });
    },
    onError: (err: any) =>
      toast({ variant: 'destructive', title: t('plugins.admin.saveFailed'), description: err?.message }),
  });

  const queue = health.data?.queue;
  const staleWorkers = (health.data?.workers ?? []).filter((w) => !w.alive).length;

  return (
    <section className="space-y-4">
      <header className="flex items-center gap-2">
        <ServerCog className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{t('plugins.runtime.title')}</h2>
      </header>

      {health.isLoading ? (
        <Skeleton className="h-24 rounded-xl" />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Metric label={t('plugins.runtime.pending')} value={queue?.pending ?? 0} />
          <Metric label={t('plugins.runtime.running')} value={queue?.running ?? 0} />
          <Metric
            label={t('plugins.runtime.failed')}
            value={queue?.failed ?? 0}
            tone={(queue?.failed ?? 0) > 0 ? 'bad' : undefined}
          />
          <Metric
            label={t('plugins.runtime.oldestPending')}
            value={queue?.oldestPendingAgeSeconds != null ? `${queue.oldestPendingAgeSeconds}s` : '—'}
            tone={(queue?.oldestPendingAgeSeconds ?? 0) > 120 ? 'warn' : undefined}
          />
          <Metric
            label={t('plugins.runtime.workers')}
            value={health.data?.workersAlive ?? 0}
            tone={(health.data?.workersAlive ?? 0) === 0 ? 'bad' : staleWorkers > 0 ? 'warn' : undefined}
          />
        </div>
      )}

      {(health.data?.workersAlive ?? 0) === 0 && !health.isLoading && (
        <Card className="flex items-start gap-2 border-destructive/40 bg-destructive/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>{t('plugins.runtime.noWorkers')}</span>
        </Card>
      )}

      {!!health.data?.deadLetters?.length && (
        <Card className="p-4">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            {t('plugins.runtime.deadLetters')}
          </h3>
          <div className="space-y-2">
            {health.data.deadLetters.map((job) => (
              <div key={job.id} className="rounded-lg border p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{job.job_type}</Badge>
                  <span className="text-muted-foreground">
                    {t('plugins.runtime.attempts')}: {job.attempt_count}
                  </span>
                  <span className="text-muted-foreground">{formatDateTime(job.updated_at)}</span>
                </div>
                {job.last_error && <p className="mt-1 break-all text-destructive">{job.last_error}</p>}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <PlugZap className="h-4 w-4 text-muted-foreground" />
          {t('plugins.runtime.integrations')}
        </h3>

        {integrations.isLoading ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : !integrations.data?.items.length ? (
          <p className="text-sm text-muted-foreground">{t('plugins.runtime.noIntegrations')}</p>
        ) : (
          <div className="space-y-2">
            {integrations.data.items.map((row: ChannelIntegrationRow) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={STATUS_VARIANT[row.status] ?? 'secondary'}>{row.status}</Badge>
                    <span className="font-medium" dir="ltr">
                      {row.username ? `@${row.username}` : row.display_name || row.provider}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground" dir="ltr">
                    {t('plugins.runtime.workspace')}: {row.workspace_id.slice(0, 8)}…
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <Activity className="me-1 inline h-3 w-3" />
                    {t('plugins.telegram.lastInbound')}:{' '}
                    {row.last_inbound_at ? formatDateTime(row.last_inbound_at) : t('plugins.telegram.never')}
                  </p>
                  {row.last_error_code && (
                    <p className="text-xs text-destructive" dir="ltr">
                      {row.last_error_code}
                      {row.last_error_at ? ` · ${formatDateTime(row.last_error_at)}` : ''}
                    </p>
                  )}
                </div>

                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={row.status === 'disconnected' || forceDisconnect.isPending}
                  onClick={() => {
                    if (window.confirm(t('plugins.runtime.confirmDisconnect'))) forceDisconnect.mutate(row.id);
                  }}
                >
                  {t('plugins.runtime.forceDisconnect')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </section>
  );
}

export default ChannelsRuntimePanel;
