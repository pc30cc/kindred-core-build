/**
 * Workspace plugin marketplace.
 *
 * Availability is decided by the server (platform state + plan entitlement);
 * this page only reflects it. Cards stay visible when locked so operators can
 * see what an upgrade unlocks, but the actions are disabled.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { pluginsApi, type PluginCatalogItem } from '@/lib/plugins-api';
import { TelegramConfig } from '@/components/plugins/TelegramConfig';
import { cn } from '@/lib/utils';
import { Lock, Plug, Settings2, Trash2, Wrench } from 'lucide-react';

function PluginIcon({ id }: { id: string }) {
  return (
    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
      <Plug className="h-5 w-5" />
      <span className="sr-only">{id}</span>
    </div>
  );
}

export default function PluginsPage() {
  const { t } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const workspaceId = workspace?.id ?? '';
  const qc = useQueryClient();
  const [telegramOpen, setTelegramOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['plugins', 'catalog', workspaceId],
    queryFn: () => pluginsApi.catalog(workspaceId),
    enabled: !!workspaceId,
  });

  const uninstall = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.uninstall(workspaceId, pluginId),
    onSuccess: () => {
      toast({ title: t('plugins.telegram.disconnected') });
      qc.invalidateQueries({ queryKey: ['plugins'] });
    },
    onError: (err: any) =>
      toast({ variant: 'destructive', title: t('plugins.error.generic'), description: err?.message }),
  });

  const grouped = useMemo(() => {
    const map = new Map<string, PluginCatalogItem[]>();
    for (const item of data?.items ?? []) {
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    }
    return [...map.entries()];
  }, [data]);

  function localizedName(item: PluginCatalogItem) {
    const key = `plugins.${item.id}.name`;
    const label = t(key);
    return label === key ? item.id : label;
  }

  function localizedDescription(item: PluginCatalogItem) {
    const key = `plugins.${item.id}.description`;
    const label = t(key);
    return label === key ? '' : label;
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold">{t('plugins.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('plugins.subtitle')}</p>
      </header>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
        </div>
      ) : grouped.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">{t('plugins.catalogEmpty')}</Card>
      ) : (
        grouped.map(([category, items]) => (
          <section key={category} className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              {t(`plugins.category.${category}`)}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((item) => {
                const comingSoon = item.status === 'coming_soon' || item.rolloutStatus === 'coming_soon';
                const locked = !item.planAllowed;
                const blocked = comingSoon || locked || item.maintenanceMode || !item.installable;
                return (
                  <Card
                    key={item.id}
                    className={cn(
                      'flex flex-col gap-3 p-4 transition-shadow hover:shadow-md',
                      blocked && 'opacity-70',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <PluginIcon id={item.id} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{localizedName(item)}</span>
                          {item.installed && !blocked && (
                            <Badge variant="secondary">{t('plugins.badge.installed')}</Badge>
                          )}
                          {comingSoon && <Badge variant="outline">{t('plugins.badge.comingSoon')}</Badge>}
                          {item.rolloutStatus === 'beta' && <Badge variant="outline">{t('plugins.badge.beta')}</Badge>}
                          {item.maintenanceMode && (
                            <Badge variant="outline" className="gap-1">
                              <Wrench className="h-3 w-3" />{t('plugins.badge.maintenance')}
                            </Badge>
                          )}
                          {locked && !comingSoon && (
                            <Badge variant="outline" className="gap-1">
                              <Lock className="h-3 w-3" />{t('plugins.badge.planLocked')}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {localizedDescription(item)}
                        </p>
                      </div>
                    </div>

                    <div className="mt-auto flex items-center justify-end gap-2">
                      {item.installed && !comingSoon && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={uninstall.isPending}
                          onClick={() => uninstall.mutate(item.id)}
                        >
                          <Trash2 className="me-1.5 h-4 w-4" />
                          {t('plugins.action.uninstall')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        disabled={blocked || item.id !== 'telegram'}
                        onClick={() => item.id === 'telegram' && setTelegramOpen(true)}
                      >
                        <Settings2 className="me-1.5 h-4 w-4" />
                        {item.installed ? t('plugins.action.configure') : t('plugins.action.install')}
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          </section>
        ))
      )}

      {workspaceId && (
        <TelegramConfig workspaceId={workspaceId} open={telegramOpen} onOpenChange={setTelegramOpen} />
      )}
    </div>
  );
}
