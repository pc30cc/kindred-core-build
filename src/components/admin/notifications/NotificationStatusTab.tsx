/**
 * Transport health, the device fleet, and a real end-to-end test send.
 *
 * "Configured" only means credentials are loaded. The test send is the only
 * thing that proves the whole chain — credentials, Firebase project, APNs key,
 * entitlement, device token — actually rings a phone, so it sits right next to
 * the status rather than hidden in a diagnostics corner.
 */
import { useState } from 'react';
import {
  CheckCircle2, Loader2, Send, Smartphone, XCircle, Power,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  SettingsSection, FieldGrid, SelectField, SwitchField,
} from '@/components/admin/settings/SettingsFields';
import {
  useDeviceFleet, useSendTestNotification,
  type PushEventType, type PushPlatformSettings, type TransportStatus,
} from '@/hooks/useAdminNotifications';
import { cn } from '@/lib/utils';

export function NotificationStatusTab({
  transport,
  draft,
  set,
  active,
}: {
  transport: TransportStatus;
  draft: PushPlatformSettings;
  set: (patch: Partial<PushPlatformSettings>) => void;
  active: boolean;
}) {
  const { t } = useTranslation();
  const fleet = useDeviceFleet();
  const test = useSendTestNotification();
  const [eventType, setEventType] = useState<PushEventType>('new_message');
  const [locale, setLocale] = useState('en');
  const [preview, setPreview] = useState(true);

  const runTest = async () => {
    try {
      const result = await test.mutateAsync({ event_type: eventType, locale, preview });
      if (result.accepted > 0) {
        toast({
          title: t('admin.notifications.status.testSent'),
          description: t('admin.notifications.status.testSentDetail', {
            accepted: result.accepted,
            devices: result.devices,
          }),
        });
      } else {
        toast({
          title: t('admin.notifications.status.testFailed'),
          description: result.failures[0]?.error ?? undefined,
          variant: 'destructive',
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      toast({
        title: t('admin.notifications.status.testFailed'),
        description:
          message === 'no_devices'
            ? t('admin.notifications.status.noDevices')
            : message === 'push_not_configured'
              ? t('admin.notifications.status.transportMissingHint')
              : message,
        variant: 'destructive',
      });
    }
  };

  const stats = [
    { key: 'enabled', value: fleet.data?.enabled ?? 0 },
    { key: 'ios', value: fleet.data?.ios ?? 0 },
    { key: 'android', value: fleet.data?.android ?? 0 },
    { key: 'activeLast7d', value: fleet.data?.activeLast7d ?? 0 },
    { key: 'denied', value: fleet.data?.denied ?? 0 },
  ] as const;

  return (
    <div className="space-y-4">
      <SettingsSection
        icon={Power}
        heading={t('admin.notifications.status.masterSwitch')}
        caption={t('admin.notifications.status.masterSwitchHint')}
      >
        <SwitchField
          label={t('admin.notifications.status.pushEnabled')}
          hint={t('admin.notifications.status.pushEnabledHint')}
          checked={draft.push_enabled}
          onChange={(push_enabled) => set({ push_enabled })}
        />
      </SettingsSection>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('admin.notifications.status.transport')}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {t('admin.notifications.status.transportHint')}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">
              {t('admin.notifications.status.credentials')}
            </span>
            {transport.configured ? (
              <span className="flex items-center gap-1 text-xs font-medium text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t('admin.notifications.status.loaded')}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs font-medium text-destructive">
                <XCircle className="h-3.5 w-3.5" />
                {t('admin.notifications.status.notLoaded')}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">
              {t('admin.notifications.status.firebaseProject')}
            </span>
            <span dir="ltr" className="font-mono text-[12.5px]">
              {transport.projectId ?? '—'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">
              {t('admin.notifications.status.serviceAccount')}
            </span>
            <span dir="ltr" className="truncate font-mono text-[12.5px]">
              {transport.clientEmailMasked ?? '—'}
            </span>
          </div>
          {!transport.configured && (
            <p className="rounded-xl bg-destructive/10 p-3 text-xs text-destructive">
              {t('admin.notifications.status.transportMissingHint')}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">{t('admin.notifications.status.fleet')}</CardTitle>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('admin.notifications.status.fleetHint')}
          </p>
        </CardHeader>
        <CardContent>
          {fleet.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {stats.map((stat) => (
                <div key={stat.key} className="rounded-xl border border-border/70 p-3">
                  <p className="text-xs text-muted-foreground">
                    {t(`admin.notifications.status.fleetStat.${stat.key}` as TranslationKey)}
                  </p>
                  <p
                    className={cn(
                      'mt-1 text-2xl font-bold tabular-nums',
                      stat.key === 'denied' && stat.value > 0 && 'text-amber-600',
                    )}
                  >
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <SettingsSection
        icon={Send}
        heading={t('admin.notifications.status.testTitle')}
        caption={t('admin.notifications.status.testHint')}
      >
        <FieldGrid cols={3}>
          <SelectField
            label={t('admin.notifications.status.testEvent')}
            value={eventType}
            onChange={(value) => setEventType(value as PushEventType)}
            options={[
              { value: 'new_message', label: t('admin.notifications.events.new_message') },
              { value: 'internal_note', label: t('admin.notifications.events.internal_note') },
              { value: 'mention', label: t('admin.notifications.events.mention') },
            ]}
          />
          <SelectField
            label={t('admin.notifications.status.testLocale')}
            value={locale}
            onChange={setLocale}
            options={[
              { value: 'en', label: t('admin.brandingPage.languages.en') },
              { value: 'fa', label: t('admin.brandingPage.languages.fa') },
              { value: 'tr', label: t('admin.brandingPage.languages.tr') },
            ]}
          />
          <SelectField
            label={t('admin.notifications.status.testPreview')}
            value={preview ? 'on' : 'off'}
            onChange={(value) => setPreview(value === 'on')}
            options={[
              { value: 'on', label: t('admin.notifications.status.previewOn') },
              { value: 'off', label: t('admin.notifications.status.previewOff') },
            ]}
          />
        </FieldGrid>
        <div className="flex items-center gap-3">
          <Button onClick={runTest} disabled={test.isPending || !transport.configured || !active}>
            {test.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('admin.notifications.status.sendTest')}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t('admin.notifications.status.testTargetHint')}
          </p>
        </div>
      </SettingsSection>
    </div>
  );
}
