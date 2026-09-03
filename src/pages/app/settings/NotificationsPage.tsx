/**
 * Notifications settings — Crisp-inspired layout, modern Lovable polish.
 *
 * Architecture:
 *   - GET /api/notifications/prefs (self-hosted)
 *   - PATCH /api/notifications/prefs (autosave on toggle)
 *   - Browser permission state is detected client-side; we surface a
 *     native "Enable notifications" CTA when blocked/default.
 *   - All toggles are theme-tokenized (no hardcoded colors).
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchNotificationPrefs,
  updateNotificationPrefs,
  type NotificationPrefs,
} from '@/lib/notifications-api';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Loader2,
  Mail,
  Moon,
  Volume2,
} from 'lucide-react';

type PermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

function useBrowserNotificationPermission(): {
  permission: PermissionState;
  request: () => Promise<void>;
} {
  const [permission, setPermission] = useState<PermissionState>(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return Notification.permission as PermissionState;
  });

  const request = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    try {
      const result = await Notification.requestPermission();
      setPermission(result as PermissionState);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onFocus = () => {
      if ('Notification' in window) setPermission(Notification.permission as PermissionState);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return { permission, request };
}

interface ToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

function ToggleRow({ label, description, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-6 py-3.5',
        disabled && 'opacity-50'
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && (
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  title,
  hint,
}: {
  icon: React.ElementType;
  title: string;
  hint?: string;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2.5">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-[13.5px] font-semibold text-foreground">{title}</div>
        {hint && <div className="text-[12px] text-muted-foreground">{hint}</div>}
      </div>
    </div>
  );
}

export default function SettingsNotificationsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { permission, request: requestPermission } = useBrowserNotificationPermission();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['notification-prefs'],
    queryFn: fetchNotificationPrefs,
  });

  // Local optimistic state mirrors server prefs
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  useEffect(() => {
    if (data?.prefs) setPrefs(data.prefs);
  }, [data?.prefs]);

  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: updateNotificationPrefs,
    onSuccess: (resp) => {
      qc.setQueryData(['notification-prefs'], resp);
      setPrefs(resp.prefs);
      setSavedKey(savingKey);
      setSavingKey(null);
      window.setTimeout(() => setSavedKey(null), 1500);
    },
    onError: (err: Error) => {
      setSavingKey(null);
      toast({
        title: t('notifications.saveFailed'),
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const update = (key: keyof NotificationPrefs, value: NotificationPrefs[keyof NotificationPrefs]) => {
    if (!prefs) return;
    setPrefs({ ...prefs, [key]: value } as NotificationPrefs);
    setSavingKey(String(key));
    mutation.mutate({ [key]: value } as Partial<NotificationPrefs>);
  };

  const masterDisabled = !!prefs?.disable_all;
  const pushDisabled = masterDisabled || permission === 'denied';
  const emailDisabled = masterDisabled;

  const headerStatus = useMemo(() => {
    if (mutation.isPending || savingKey) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('notifications.saving')}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11.5px] font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        {t('notifications.autoSaved')}
      </span>
    );
  }, [mutation.isPending, savingKey, t]);

  if (isLoading || !prefs) {
    return (
      <div className="space-y-5">
        <SkeletonCard lines={4} />
        <SkeletonCard lines={4} />
      </div>
    );
  }

  if (isError) {
    return (
      <Card className="border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
        {(error as Error)?.message || t('notifications.loadFailed')}
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t('notifications.title')}
          </h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            {t('notifications.subtitle')}
          </p>
        </div>
        {headerStatus}
      </div>

      {/* Browser permission banner */}
      {permission !== 'granted' && permission !== 'unsupported' && (
        <Card className="border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-destructive/15 text-destructive">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-destructive">
                {permission === 'denied'
                  ? t('notifications.permissionBlocked')
                  : t('notifications.permissionNeeded')}
              </div>
              <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                {permission === 'denied'
                  ? t('notifications.permissionBlockedHelp')
                  : t('notifications.permissionNeededHelp')}
              </div>
              {permission === 'default' && (
                <Button
                  size="sm"
                  variant="default"
                  className="mt-3"
                  onClick={requestPermission}
                >
                  {t('notifications.enableInBrowser')}
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Master switch */}
      <Card className="overflow-hidden">
        <div className="border-b border-border/60 px-6 py-4">
          <p className="text-[13px] text-muted-foreground">
            {t('notifications.intro')}
          </p>
          <p className="mt-1 text-[12.5px] text-muted-foreground/80">
            {t('notifications.introWarn')}
          </p>
        </div>
        <div className="px-6">
          <ToggleRow
            label={t('notifications.disableAll')}
            description={t('notifications.disableAllHelp')}
            checked={prefs.disable_all}
            onChange={(v) => update('disable_all', v)}
          />
        </div>
      </Card>

      {/* Push notifications */}
      <Card className="p-6">
        <SectionHeader
          icon={Bell}
          title={t('notifications.pushTitle')}
          hint={t('notifications.pushHint')}
        />
        <div className="mt-3 divide-y divide-border/60">
          <ToggleRow
            label={t('notifications.notifyOnline')}
            checked={prefs.push_when_online}
            disabled={pushDisabled}
            onChange={(v) => update('push_when_online', v)}
          />
          <ToggleRow
            label={t('notifications.notifyOffline')}
            checked={prefs.push_when_offline}
            disabled={pushDisabled}
            onChange={(v) => update('push_when_offline', v)}
          />
          <ToggleRow
            label={t('notifications.notifyVisitorBrowsing')}
            checked={prefs.push_visitor_browsing}
            disabled={pushDisabled}
            onChange={(v) => update('push_visitor_browsing', v)}
          />
          <ToggleRow
            label={t('notifications.playSound')}
            checked={prefs.play_sound}
            disabled={masterDisabled}
            onChange={(v) => update('play_sound', v)}
          />
        </div>
      </Card>

      {/* Email notifications */}
      <Card className="p-6">
        <SectionHeader
          icon={Mail}
          title={t('notifications.emailTitle')}
          hint={t('notifications.emailHint')}
        />
        <div className="mt-3 divide-y divide-border/60">
          <ToggleRow
            label={t('notifications.emailUnread')}
            checked={prefs.email_unread_messages}
            disabled={emailDisabled}
            onChange={(v) => update('email_unread_messages', v)}
          />
          <ToggleRow
            label={t('notifications.emailTranscripts')}
            checked={prefs.email_transcripts}
            disabled={emailDisabled}
            onChange={(v) => update('email_transcripts', v)}
          />
          <ToggleRow
            label={t('notifications.emailRatings')}
            checked={prefs.email_user_ratings}
            disabled={emailDisabled}
            onChange={(v) => update('email_user_ratings', v)}
          />
          <ToggleRow
            label={t('notifications.emailInvoices')}
            checked={prefs.email_paid_invoices}
            disabled={emailDisabled}
            onChange={(v) => update('email_paid_invoices', v)}
          />
          <ToggleRow
            label={t('notifications.emailWeekly')}
            checked={prefs.email_weekly_summary}
            disabled={emailDisabled}
            onChange={(v) => update('email_weekly_summary', v)}
          />
          <ToggleRow
            label={t('notifications.emailProduct')}
            checked={prefs.email_product_updates}
            disabled={emailDisabled}
            onChange={(v) => update('email_product_updates', v)}
          />
        </div>
      </Card>

      {/* Quiet hours */}
      <Card className="p-6">
        <SectionHeader
          icon={Moon}
          title={t('notifications.quietTitle')}
          hint={t('notifications.quietHint')}
        />
        <div className="mt-3 divide-y divide-border/60">
          <ToggleRow
            label={t('notifications.quietEnable')}
            description={t('notifications.quietEnableHelp')}
            checked={prefs.quiet_hours_enabled}
            disabled={masterDisabled}
            onChange={(v) => update('quiet_hours_enabled', v)}
          />
          {prefs.quiet_hours_enabled && (
            <div className="grid grid-cols-1 gap-4 py-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="quiet-start" className="text-[12.5px] text-muted-foreground">
                  {t('notifications.quietStart')}
                </Label>
                <Input
                  id="quiet-start"
                  type="time"
                  value={prefs.quiet_hours_start || ''}
                  disabled={masterDisabled}
                  onChange={(e) => setPrefs({ ...prefs, quiet_hours_start: e.target.value || null })}
                  onBlur={(e) =>
                    update('quiet_hours_start', e.target.value || null)
                  }
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="quiet-end" className="text-[12.5px] text-muted-foreground">
                  {t('notifications.quietEnd')}
                </Label>
                <Input
                  id="quiet-end"
                  type="time"
                  value={prefs.quiet_hours_end || ''}
                  disabled={masterDisabled}
                  onChange={(e) => setPrefs({ ...prefs, quiet_hours_end: e.target.value || null })}
                  onBlur={(e) =>
                    update('quiet_hours_end', e.target.value || null)
                  }
                  className="mt-1.5"
                />
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
