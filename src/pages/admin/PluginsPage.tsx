/**
 * Super Admin — platform-wide plugin controls.
 *
 * These switches are the outer gate: a workspace can never use a plugin the
 * platform has disabled, regardless of its plan.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@/i18n';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { adminPluginsApi, type AdminPluginItem, type PluginRolloutStatus } from '@/lib/plugins-api';
import { ChannelsRuntimePanel } from '@/components/plugins/ChannelsRuntimePanel';

const ROLLOUT_OPTIONS: PluginRolloutStatus[] = ['hidden', 'coming_soon', 'beta', 'public'];

export default function AdminPluginsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'plugins'],
    queryFn: () => adminPluginsApi.list(),
  });

  const update = useMutation({
    mutationFn: ({ pluginId, patch }: { pluginId: string; patch: Parameters<typeof adminPluginsApi.update>[1] }) =>
      adminPluginsApi.update(pluginId, patch),
    onSuccess: () => {
      toast({ title: t('plugins.admin.saved') });
      qc.invalidateQueries({ queryKey: ['admin', 'plugins'] });
    },
    onError: (err: any) =>
      toast({ variant: 'destructive', title: t('plugins.admin.saveFailed'), description: err?.message }),
  });

  function Toggle({ item, field, label }: { item: AdminPluginItem; field: 'enabled' | 'marketplace_visible' | 'installable' | 'maintenance_mode' | 'featured'; label: string }) {
    const current = {
      enabled: item.enabled,
      marketplace_visible: item.marketplaceVisible,
      installable: item.installable,
      maintenance_mode: item.maintenanceMode,
      featured: item.featured,
    }[field];
    return (
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
        <Switch
          checked={!!current}
          disabled={update.isPending}
          onCheckedChange={(v) => update.mutate({ pluginId: item.id, patch: { [field]: v } as any })}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold">{t('plugins.admin.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('plugins.admin.subtitle')}</p>
      </header>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(data?.items ?? []).map((item) => (
            <Card key={item.id} className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium capitalize">{item.id}</span>
                  <Badge variant="outline">v{item.version}</Badge>
                </div>
                <Badge variant="secondary">{t(`plugins.category.${item.category}` as never)}</Badge>
              </div>

              <div className="space-y-2 border-t pt-3">
                <Toggle item={item} field="enabled" label={t('plugins.admin.enabled')} />
                <Toggle item={item} field="marketplace_visible" label={t('plugins.admin.marketplaceVisible')} />
                <Toggle item={item} field="installable" label={t('plugins.admin.installable')} />
                <Toggle item={item} field="maintenance_mode" label={t('plugins.admin.maintenanceMode')} />
                <Toggle item={item} field="featured" label={t('plugins.admin.featured')} />
              </div>

              <div className="space-y-1.5 border-t pt-3">
                <Label className="text-xs font-normal text-muted-foreground">
                  {t('plugins.admin.rolloutStatus')}
                </Label>
                <Select
                  value={item.rolloutStatus}
                  disabled={update.isPending}
                  onValueChange={(v) =>
                    update.mutate({ pluginId: item.id, patch: { rollout_status: v as PluginRolloutStatus } })
                  }
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
          ))}
        </div>
      )}

      <ChannelsRuntimePanel />
    </div>
  );
}
