/**
 * Workspace plugin detail — a full page (never a dialog).
 *
 * Availability is decided by the server (platform state + plan entitlement);
 * this page only reflects it. Installing happens here too, so the marketplace
 * card is a pure navigation surface.
 */

import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import { pluginsApi } from '@/lib/plugins-api';
import { TelegramConfigPanel } from '@/components/plugins/TelegramConfigPanel';
import { PluginLogsTable } from '@/components/plugins/PluginLogsTable';
import { ArrowLeft, ArrowRight, Lock, Plug, Trash2, Wrench } from 'lucide-react';

export default function PluginDetailPage() {
  const { t, dir } = useTranslation();
  const { pluginId = '', slug = '' } = useParams();
  const navigate = useNavigate();
  const { workspace } = useActiveWorkspace();
  const workspaceId = workspace?.id ?? '';
  const qc = useQueryClient();
  const BackIcon = dir === 'rtl' ? ArrowRight : ArrowLeft;

  const { data, isLoading } = useQuery({
    queryKey: ['plugins', 'catalog', workspaceId],
    queryFn: () => pluginsApi.catalog(workspaceId),
    enabled: !!workspaceId,
  });

  const item = useMemo(
    () => (data?.items ?? []).find((p) => p.id === pluginId) ?? null,
    [data, pluginId],
  );

  const install = useMutation({
    mutationFn: () => pluginsApi.install(workspaceId, pluginId),
    onSuccess: () => {
      toast({ title: t('plugins.badge.installed') });
      qc.invalidateQueries({ queryKey: ['plugins'] });
    },
    onError: (err: any) =>
      toast({ variant: 'destructive', title: t('plugins.error.generic'), description: err?.message }),
  });

  const uninstall = useMutation({
    mutationFn: () => pluginsApi.uninstall(workspaceId, pluginId),
    onSuccess: () => {
      toast({ title: t('plugins.telegram.disconnected') });
      qc.invalidateQueries({ queryKey: ['plugins'] });
      navigate(`/app/w/${slug}/plugins`);
    },
    onError: (err: any) =>
      toast({ variant: 'destructive', title: t('plugins.error.generic'), description: err?.message }),
  });

  const nameKey = `plugins.${pluginId}.name`;
  const descKey = `plugins.${pluginId}.description`;
  const name = t(nameKey as never) === nameKey ? pluginId : t(nameKey as never);
  const description = t(descKey as never) === descKey ? '' : t(descKey as never);

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

  const comingSoon = item.status === 'coming_soon' || item.rolloutStatus === 'coming_soon';
  const locked = !item.planAllowed;
  const blocked = comingSoon || locked || item.maintenanceMode || !item.installable;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <Button asChild variant="ghost" size="sm" className="-ms-2">
        <Link to={`/app/w/${slug}/plugins`}>
          <BackIcon className="me-1.5 h-4 w-4" />
          {t('plugins.title')}
        </Link>
      </Button>

      <header className="flex flex-wrap items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Plug className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{name}</h1>
            {item.installed && <Badge variant="secondary">{t('plugins.badge.installed')}</Badge>}
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
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          {item.installed ? (
            <Button variant="ghost" disabled={uninstall.isPending} onClick={() => uninstall.mutate()}>
              <Trash2 className="me-1.5 h-4 w-4" />
              {t('plugins.action.uninstall')}
            </Button>
          ) : (
            <Button disabled={blocked || install.isPending} onClick={() => install.mutate()}>
              {t('plugins.action.install')}
            </Button>
          )}
        </div>
      </header>

      {blocked && (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          {t(
            (comingSoon
              ? 'plugins.badge.comingSoon'
              : locked
                ? 'plugins.error.plan_locked'
                : item.maintenanceMode
                  ? 'plugins.error.maintenance_mode'
                  : 'plugins.error.not_installable') as never,
          )}
        </Card>
      )}

      {pluginId === 'telegram' && !blocked ? (
        <Tabs defaultValue="connection" className="space-y-4" dir={dir}>
          <TabsList>
            <TabsTrigger value="connection">{t('plugins.tab.connection')}</TabsTrigger>
            <TabsTrigger value="branding">{t('plugins.tab.branding')}</TabsTrigger>
            <TabsTrigger value="messages">{t('plugins.tab.messages')}</TabsTrigger>
            
          </TabsList>
          <TabsContent value="connection">
            <TelegramConfigPanel workspaceId={workspaceId} section="connection" />
          </TabsContent>
          <TabsContent value="branding">
            <TelegramConfigPanel workspaceId={workspaceId} section="branding" />
          </TabsContent>
          <TabsContent value="messages">
            <TelegramConfigPanel workspaceId={workspaceId} section="messages" />
          </TabsContent>
          </TabsContent>

        </Tabs>
      ) : (
        !blocked && (
          <Card className="p-10 text-center text-sm text-muted-foreground">
            {t('plugins.noSettings')}
          </Card>
        )
      )}
    </div>
  );
}
