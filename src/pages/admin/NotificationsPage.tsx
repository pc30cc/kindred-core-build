/**
 * Super Admin → Notifications.
 *
 * Platform-wide notification policy for the native apps: who gets notified by
 * default, how the notification behaves on iOS (priority, interruption level,
 * grouping, sound, badge), which action buttons it carries, and what it says
 * in each language — plus the transport status, the device fleet, a real test
 * send and the delivery log.
 *
 * What is NOT here, by design: the FCM service account. It lives in the
 * server environment and is never readable from an admin session; this screen
 * only reports whether it is present and which Firebase project it targets.
 */
import { useEffect, useMemo, useState } from 'react';
import { Bell, SlidersHorizontal, Send, Layers, Languages, Activity, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/hooks/use-toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  useNotificationSettings,
  useSaveNotificationSettings,
  type PushPlatformSettings,
} from '@/hooks/useAdminNotifications';
import { NotificationStatusTab } from '@/components/admin/notifications/NotificationStatusTab';
import { NotificationPolicyTab } from '@/components/admin/notifications/NotificationPolicyTab';
import { NotificationDeliveryTab } from '@/components/admin/notifications/NotificationDeliveryTab';
import { NotificationCategoriesTab } from '@/components/admin/notifications/NotificationCategoriesTab';
import { NotificationTemplatesTab } from '@/components/admin/notifications/NotificationTemplatesTab';
import { NotificationDiagnosticsTab } from '@/components/admin/notifications/NotificationDiagnosticsTab';

const TABS = [
  { value: 'status', icon: Send },
  { value: 'policy', icon: SlidersHorizontal },
  { value: 'delivery', icon: Bell },
  { value: 'categories', icon: Layers },
  { value: 'templates', icon: Languages },
  { value: 'diagnostics', icon: Activity },
] as const;

export default function AdminNotificationsPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useNotificationSettings();
  const save = useSaveNotificationSettings();

  const [tab, setTab] = useState<string>('status');
  const [draft, setDraft] = useState<PushPlatformSettings | null>(null);

  useEffect(() => {
    if (data?.settings) setDraft(data.settings);
  }, [data?.settings]);

  const dirty = useMemo(() => {
    if (!draft || !data?.settings) return false;
    return JSON.stringify(draft) !== JSON.stringify(data.settings);
  }, [draft, data?.settings]);

  const set = (patch: Partial<PushPlatformSettings>) =>
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous));

  const onSave = async () => {
    if (!draft) return;
    const { updated_at, ...payload } = draft;
    try {
      await save.mutateAsync(payload);
      toast({ title: t('admin.notifications.common.saved') });
    } catch (e) {
      toast({
        title: t('admin.notifications.common.saveFailed'),
        description: e instanceof Error ? e.message : undefined,
        variant: 'destructive',
      });
    }
  };

  if (isLoading || !draft || !data) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 pb-28">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Bell className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold">{t('admin.notifications.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('admin.notifications.subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={data.transport.configured ? 'default' : 'destructive'}>
            {data.transport.configured
              ? t('admin.notifications.status.transportReady')
              : t('admin.notifications.status.transportMissing')}
          </Badge>
          {!draft.push_enabled && (
            <Badge variant="secondary">{t('admin.notifications.status.pausedBadge')}</Badge>
          )}
        </div>
      </header>

      {error && (
        <p className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
          {t('admin.notifications.common.loadFailed')}
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.value} value={entry.value} className="gap-1.5">
              <entry.icon className="h-4 w-4" />
              {t(`admin.notifications.tabs.${entry.value}` as TranslationKey)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="status" className="space-y-4">
          <NotificationStatusTab
            transport={data.transport}
            draft={draft}
            set={set}
            active={tab === 'status'}
          />
        </TabsContent>
        <TabsContent value="policy" className="space-y-4">
          <NotificationPolicyTab draft={draft} set={set} />
        </TabsContent>
        <TabsContent value="delivery" className="space-y-4">
          <NotificationDeliveryTab draft={draft} set={set} />
        </TabsContent>
        <TabsContent value="categories" className="space-y-4">
          <NotificationCategoriesTab draft={draft} set={set} />
        </TabsContent>
        <TabsContent value="templates" className="space-y-4">
          <NotificationTemplatesTab draft={draft} set={set} />
        </TabsContent>
        <TabsContent value="diagnostics" className="space-y-4">
          <NotificationDiagnosticsTab active={tab === 'diagnostics'} />
        </TabsContent>
      </Tabs>

      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-card/95 px-6 py-3 backdrop-blur-xl lg:start-72">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              {t('admin.notifications.common.unsaved')}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDraft(data.settings)}>
                {t('admin.notifications.common.discard')}
              </Button>
              <Button size="sm" onClick={onSave} disabled={save.isPending}>
                {save.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {t('admin.notifications.common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
