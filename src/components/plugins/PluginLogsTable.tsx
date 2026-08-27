/**
 * Shared plugin activity log.
 *
 * Deliberately payload-free: the API returns status + failure reason only, so
 * this surface can never leak message contents or credentials. Used by both
 * the workspace plugin page and the Super Admin plugin page.
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '@/i18n';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime } from '@/lib/date';
import { adminPluginsApi, pluginsApi, type PluginLogEntry } from '@/lib/plugins-api';
import { ArrowDownLeft, ArrowUpRight, RefreshCw } from 'lucide-react';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  succeeded: 'default',
  processed: 'default',
  pending: 'secondary',
  processing: 'secondary',
  running: 'secondary',
  failed: 'destructive',
  ignored: 'outline',
  duplicate: 'outline',
};

export function PluginLogsTable({
  pluginId,
  workspaceId,
  scope,
}: {
  pluginId: string;
  /** Required for the workspace scope, ignored for the admin scope. */
  workspaceId?: string;
  scope: 'workspace' | 'admin';
}) {
  const { t } = useTranslation();

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['plugins', 'logs', scope, pluginId, workspaceId ?? null],
    queryFn: () =>
      scope === 'admin' ? adminPluginsApi.logs(pluginId) : pluginsApi.logs(workspaceId!, pluginId),
    enabled: scope === 'admin' || !!workspaceId,
    refetchInterval: 30_000,
  });

  const items = data?.items ?? [];

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t('plugins.logs.title')}</h3>
        <Button type="button" size="sm" variant="outline" disabled={isFetching} onClick={() => refetch()}>
          <RefreshCw className={`me-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          {t('plugins.logs.refresh')}
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t('plugins.logs.empty')}</p>
      ) : (
        <div className="space-y-2">
          {items.map((row: PluginLogEntry) => (
            <div key={`${row.kind}-${row.id}`} className="rounded-lg border p-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                {row.kind === 'inbound' ? (
                  <ArrowDownLeft className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <Badge variant={STATUS_VARIANT[row.status] ?? 'secondary'}>{row.status}</Badge>
                <span className="font-mono" dir="ltr">{row.type}</span>
                {row.attempts != null && row.attempts > 0 && (
                  <span className="text-muted-foreground">
                    {t('plugins.runtime.attempts')}: {row.attempts}
                  </span>
                )}
                <span className="ms-auto text-muted-foreground">{formatDateTime(row.at)}</span>
              </div>
              {scope === 'admin' && row.workspaceId && (
                <p className="mt-1 text-muted-foreground" dir="ltr">
                  {t('plugins.runtime.workspace')}: {row.workspaceId.slice(0, 8)}…
                </p>
              )}
              {row.error && (
                <p className="mt-1 break-all text-destructive" dir="ltr">{row.error}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default PluginLogsTable;
