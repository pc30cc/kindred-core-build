/**
 * Super Admin — single plugin control page (never a dialog).
 *
 * Tabs keep the two very different concerns apart: availability policy (the
 * outer gate every workspace is subject to) and runtime observability.
 */

import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@/i18n';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { adminPluginsApi, type PluginRolloutStatus } from '@/lib/plugins-api';
import { ChannelsRuntimePanel } from '@/components/plugins/ChannelsRuntimePanel';
import { PluginLogsTable } from '@/components/plugins/PluginLogsTable';
import { ArrowLeft, ArrowRight, Plug } from 'lucide-react';

const ROLLOUT_OPTIONS: PluginRolloutStatus[] = ['hidden', 'coming_soon', 'beta', 'public'];

export default function AdminPluginDetailPage() {
  const { t, dir } = useTranslation();
  const { pluginId = '' } = useParams();
  const qc = useQueryClient();
  const BackIcon = dir === 'rtl' ? ArrowRight : ArrowLeft;

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'plugins'],
    queryFn: () => adminPluginsApi.list(),
  });

  const item = useMemo(() => (data?.items ?? []).find((p) => p.id === pluginId) ?? null, [data, pluginId]);

  const update = useMutation({
    mutationFn: (patch: Parameters<typeof adminPluginsApi.update>[1]) => adminPluginsApi.update(pluginId, patch),
    onSuccess: () => {
      toast({ title: t('plugins.admin.saved') });
      qc.invalidateQueries({ queryKey: ['admin', 'plugins'] });
    },
    onError: (err: any) =>
      toast({ variant: 'destructive', title: t('plugins.admin.saveFailed'), description: err?.message }),
  });

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4 md:p-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="mx-auto w-full max-w-5xl p-4 md:p-6">
        <Card className="p-10 text-center text-sm text-muted-foreground">
          {t('plugins.error.unknown_plugin')}
        </Card>
      </div>
    );
  }

  const toggles = [
    ['enabled', item.enabled, t('plugins.admin.enabled')],
    ['marketplace_visible', item.marketplaceVisible, t('plugins.admin.marketplaceVisible')],
    ['installable', item.installable, t('plugins.admin.installable')],
    ['maintenance_mode', item.maintenanceMode, t('plugins.admin.maintenanceMode')],
    ['featured', item.featured, t('plugins.admin.featured')],
  ] as const;

  const aiEnabled = (item.policy as Record<string, unknown> | null)?.aiEnabled !== false;


  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <Button asChild variant="ghost" size="sm" className="-ms-2">
        <Link to="/admin/plugins">
          <BackIcon className="me-1.5 h-4 w-4" />
          {t('plugins.admin.title')}
        </Link>
      </Button>

      <header className="flex flex-wrap items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Plug className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold capitalize">{item.id}</h1>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant="outline">v{item.version}</Badge>
            <Badge variant="secondary">{t(`plugins.category.${item.category}` as never)}</Badge>
          </div>
        </div>
      </header>

      <Tabs defaultValue="policy" className="space-y-4" dir={dir}>
        <TabsList>
          <TabsTrigger value="policy">{t('plugins.tab.policy')}</TabsTrigger>
          <TabsTrigger value="runtime">{t('plugins.tab.runtime')}</TabsTrigger>
          <TabsTrigger value="logs">{t('plugins.tab.logs')}</TabsTrigger>
        </TabsList>

        <TabsContent value="policy">
          <Card className="space-y-3 p-4">
            {toggles.map(([field, current, label]) => (
              <div key={field} className="flex items-center justify-between gap-3">
                <Label className="text-sm font-normal">{label}</Label>
                <Switch
                  checked={!!current}
                  disabled={update.isPending}
                  onCheckedChange={(v) => update.mutate({ [field]: v } as any)}
                />
              </div>
            ))}

            {/* Master AI switch: absent policy means ON, so existing plugins
                keep answering until an admin deliberately turns AI off. */}
            {item.supportsAI && (
              <div className="flex items-start justify-between gap-3 border-t pt-3">
                <div>
                  <Label className="text-sm font-normal">{t('plugins.admin.aiEnabled')}</Label>
                  <p className="mt-1 max-w-md text-xs text-muted-foreground">
                    {t('plugins.admin.aiEnabledHint')}
                  </p>
                </div>
                <Switch
                  checked={aiEnabled}
                  disabled={update.isPending}
                  onCheckedChange={(v) =>
                    update.mutate({ policy: { ...(item.policy ?? {}), aiEnabled: v } })
                  }
                />
              </div>
            )}

            {item.id === 'telegram' && (
              <div className="flex items-start justify-between gap-3 border-t pt-3">
                <div>
                  <Label className="text-sm font-normal">{t('plugins.admin.menuEventsVisible')}</Label>
                  <p className="mt-1 max-w-md text-xs text-muted-foreground">
                    {t('plugins.admin.menuEventsVisibleHint')}
                  </p>
                </div>
                <Switch
                  checked={menuEventsVisible}
                  disabled={update.isPending}
                  onCheckedChange={(v) =>
                    update.mutate({ policy: { ...(item.policy ?? {}), menuEventsVisible: v } })
                  }
                />
              </div>
            )}

            <div className="space-y-1.5 border-t pt-3">
              <Label className="text-xs font-normal text-muted-foreground">
                {t('plugins.admin.rolloutStatus')}
              </Label>
              <Select
                value={item.rolloutStatus}
                disabled={update.isPending}
                onValueChange={(v) => update.mutate({ rollout_status: v as PluginRolloutStatus })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLLOUT_OPTIONS.map((opt) => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Card>
        </TabsContent>


        <TabsContent value="runtime">
          <ChannelsRuntimePanel />
        </TabsContent>

        <TabsContent value="logs">
          <PluginLogsTable pluginId={item.id} scope="admin" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
