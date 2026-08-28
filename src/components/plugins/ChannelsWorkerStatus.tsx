/**
 * Live Channels Worker status strip.
 *
 * Answers a single operational question before an admin clicks "reconnect":
 * is a channels worker alive right now? Polls the same admin health endpoint
 * the runtime panel uses, but stays compact enough to sit above the tabs.
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '@/i18n';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/date';
import { adminPluginsApi } from '@/lib/plugins-api';
import { CircleCheck, CircleX, Loader2, RefreshCw } from 'lucide-react';

export function ChannelsWorkerStatus() {
  const { t } = useTranslation();

  const health = useQuery({
    queryKey: ['admin', 'channels', 'health'],
    queryFn: () => adminPluginsApi.channelsHealth(),
    refetchInterval: 10_000,
  });

  const alive = (health.data?.workersAlive ?? 0) > 0;
  const lastSeen = (health.data?.workers ?? [])
    .map((w) => w.last_seen_at)
    .sort()
    .at(-1);

  return (
    <Card
      className={
        'flex flex-wrap items-center justify-between gap-3 p-3 ' +
        (health.isLoading
          ? ''
          : alive
            ? 'border-emerald-500/40 bg-emerald-500/5'
            : 'border-destructive/40 bg-destructive/5')
      }
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {health.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : alive ? (
          <CircleCheck className="h-4 w-4 text-emerald-600" />
        ) : (
          <CircleX className="h-4 w-4 text-destructive" />
        )}
        <span className="font-medium">{t('plugins.runtime.workerStatus')}</span>
        {!health.isLoading && (
          <Badge variant={alive ? 'default' : 'destructive'}>
            {alive ? t('plugins.runtime.online') : t('plugins.runtime.offline')}
          </Badge>
        )}
        {!health.isLoading && alive && (
          <span className="text-xs text-muted-foreground">
            {t('plugins.runtime.workers')}: {health.data?.workersAlive}
            {lastSeen ? ` · ${t('plugins.runtime.lastSeen')}: ${formatDateTime(lastSeen)}` : ''}
          </span>
        )}
        {!health.isLoading && !alive && (
          <span className="text-xs text-muted-foreground">{t('plugins.runtime.offlineHint')}</span>
        )}
      </div>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={health.isFetching}
        onClick={() => health.refetch()}
      >
        <RefreshCw className={'me-2 h-4 w-4 ' + (health.isFetching ? 'animate-spin' : '')} />
        {t('plugins.runtime.refresh')}
      </Button>
    </Card>
  );
}

export default ChannelsWorkerStatus;
