/**
 * Notifications settings — the browser's own, per operator.
 *
 * Every control on this page is read by something that acts on it. That was
 * not true before: nine of the sixteen switches here saved, answered 200 and
 * changed nothing at all — six email ones with no sender behind them, a
 * "visitor is browsing" one with no such event anywhere in the product, and
 * two presence ones the server never consulted. A switch an operator turns
 * off and believes is worse than one that was never offered, so what remains
 * is what is enforced, and the two presence switches moved to the phone,
 * which is the surface they were ever about.
 *
 * Architecture:
 *   - GET  /api/notifications/prefs?platform=web
 *   - PATCH /api/notifications/prefs  (autosave on change, platform included)
 *   - The browser permission is detected client-side — and now actually used:
 *     `features/notifications/operatorBrowserNotification.ts` draws the
 *     banner this page is describing.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchNotificationEmailPrefs,
  fetchNotificationPrefs,
  notificationPlatform,
  updateNotificationEmailPrefs,
  updateNotificationPrefs,
  type NotificationEmailType,
  type NotificationPrefs,
  type NotificationScope,
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
  Check,
  CheckCircle2,
  Loader2,
  Mail,
  Moon,
  Smartphone,
} from 'lucide-react';
import { SkeletonCard } from '@/components/common/Skeletons';

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

/**
 * One of a set. A radio group rather than a row of switches, because these
 * four are exclusive — and "every conversation" plus "only mine" both on is
 * not a state anybody means.
 */
function ChoiceRow({
  label,
  description,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  description?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start justify-between gap-6 py-3.5 text-start',
        disabled && 'cursor-not-allowed opacity-50'
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
      <span
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
        )}
      >
        {selected && <Check className="h-3 w-3" />}
      </span>
    </button>
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

/** The zone the times on this page are read in — this computer's own. */
function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * The email switches, drawn from what the platform offers.
 *
 * `available` comes from the server and decides which rows exist at all.
 * That is the whole point: six email switches used to sit here with no
 * sender behind any of them, and a switch an operator turns off and
 * believes is worse than one that was never offered. Nothing renders here
 * unless Super Admin has turned that type on.
 */
function EmailSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ['notification-email-prefs'],
    queryFn: fetchNotificationEmailPrefs,
  });

  const mutation = useMutation({
    mutationFn: updateNotificationEmailPrefs,
    onSuccess: (resp) => qc.setQueryData(['notification-email-prefs'], resp),
    onError: (err: Error) => {
      qc.invalidateQueries({ queryKey: ['notification-email-prefs'] });
      toast({ title: t('notifications.saveFailed'), description: err.message, variant: 'destructive' });
    },
  });

  if (!data) return null;

  const LABELS: Record<NotificationEmailType, { label: string; description?: string }> = {
    unread_messages: {
      label: t('notifications.emailUnreadMessages'),
      description: t('notifications.emailUnreadMessagesHelp'),
    },
    transcripts: {
      label: t('notifications.emailTranscripts'),
      description: t('notifications.emailTranscriptsHelp'),
    },
    paid_invoices: {
      label: t('notifications.emailPaidInvoices'),
      description: t('notifications.emailPaidInvoicesHelp'),
    },
    weekly_summary: { label: t('notifications.emailWeeklySummary') },
    product_updates: { label: t('notifications.emailProductUpdates') },
  };

  return (
    <Card className="p-6">
      <SectionHeader icon={Mail} title={t('notifications.emailTitle')} hint={t('notifications.emailHint')} />
      {data.available.length === 0 ? (
        <p className="mt-3 text-[12.5px] text-muted-foreground">{t('notifications.emailNone')}</p>
      ) : (
        <div className="mt-3 divide-y divide-border/60">
          {data.available.map((type) => (
            <ToggleRow
              key={type}
              label={LABELS[type].label}
              description={LABELS[type].description}
              checked={data.prefs[type] !== false}
              onChange={(v) => mutation.mutate({ [type]: v })}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

export default function SettingsNotificationsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { permission, request: requestPermission } = useBrowserNotificationPermission();

  // The same bundle is the browser console and the inside of the phone
  // shell. Which one it is decides whose preferences this page edits — and
  // what it can honestly say about the other surface and about a browser
  // permission that means nothing inside a native app.
  const isNativeShell = notificationPlatform() === 'mobile';

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

  const mutation = useMutation({
    mutationFn: updateNotificationPrefs,
    onSuccess: (resp) => {
      qc.setQueryData(['notification-prefs'], resp);
      setPrefs(resp.prefs);
      setSavingKey(null);
    },
    onError: (err: Error) => {
      setSavingKey(null);
      // Put the switch back. One that stays where it was put while the server
      // disagrees is a lie about what will reach this browser tonight.
      if (data?.prefs) setPrefs(data.prefs);
      toast({
        title: t('notifications.saveFailed'),
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const save = (updates: Partial<NotificationPrefs>) => {
    if (!prefs) return;
    setPrefs({ ...prefs, ...updates });
    setSavingKey(Object.keys(updates)[0] ?? null);
    mutation.mutate(updates);
  };

  const masterDisabled = !!prefs?.disable_all;
  const pushDisabled = masterDisabled || (!isNativeShell && permission === 'denied');

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

  const scopes: Array<{ value: NotificationScope; label: string; description?: string }> = [
    { value: 'all', label: t('notifications.scopeAll') },
    { value: 'assigned', label: t('notifications.scopeAssigned') },
    {
      value: 'mentions',
      label: t('notifications.scopeMentions'),
      description: t('notifications.scopeMentionsHelp'),
    },
    { value: 'none', label: t('notifications.scopeNone') },
  ];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t('notifications.title')}
          </h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            {isNativeShell ? t('notifications.subtitleNative') : t('notifications.subtitle')}
          </p>
        </div>
        {headerStatus}
      </div>

      {/* Browser permission banner. It means something now: the app draws a
          real notification when this is granted. */}
      {!isNativeShell && permission !== 'granted' && permission !== 'unsupported' && (
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
                <Button size="sm" variant="default" className="mt-3" onClick={requestPermission}>
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
          <p className="text-[13px] text-muted-foreground">{t('notifications.intro')}</p>
          <p className="mt-1 flex items-center gap-1.5 text-[12.5px] text-muted-foreground/80">
            <Smartphone className="h-3.5 w-3.5 shrink-0" />
            {isNativeShell ? t('notifications.introWarnNative') : t('notifications.introWarn')}
          </p>
        </div>
        <div className="px-6">
          <ToggleRow
            label={t('notifications.disableAll')}
            description={t('notifications.disableAllHelp')}
            checked={prefs.disable_all}
            onChange={(v) => save({ disable_all: v })}
          />
        </div>
      </Card>

      {/* What to be told about, and how */}
      <Card className="p-6">
        <SectionHeader
          icon={Bell}
          title={isNativeShell ? t('notifications.pushTitleApp') : t('notifications.pushTitle')}
          hint={isNativeShell ? t('notifications.pushHintApp') : t('notifications.pushHint')}
        />
        <div className="mt-3 divide-y divide-border/60" role="radiogroup" aria-label={t('notifications.scopeTitle')}>
          {scopes.map((scope) => (
            <ChoiceRow
              key={scope.value}
              label={scope.label}
              description={scope.description}
              selected={prefs.push_scope === scope.value}
              disabled={pushDisabled}
              onSelect={() => save({ push_scope: scope.value })}
            />
          ))}
        </div>
        <div className="mt-1 divide-y divide-border/60 border-t border-border/60">
          <ToggleRow
            label={t('notifications.showPreview')}
            description={t('notifications.showPreviewHelp')}
            checked={prefs.push_preview}
            disabled={pushDisabled}
            onChange={(v) => save({ push_preview: v })}
          />
          <ToggleRow
            label={t('notifications.playSound')}
            checked={prefs.play_sound}
            disabled={masterDisabled}
            onChange={(v) => save({ play_sound: v })}
          />
        </div>
      </Card>

      <EmailSection />

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
            onChange={(v) =>
              save(
                v
                  ? {
                      quiet_hours_enabled: true,
                      // A window nobody has chosen yet still has to be a
                      // window, and it has to carry a zone: without one the
                      // server evaluated a Tehran operator's night in UTC and
                      // silenced them from half past one in the morning.
                      quiet_hours_start: prefs.quiet_hours_start || '22:00',
                      quiet_hours_end: prefs.quiet_hours_end || '08:00',
                      quiet_hours_timezone: localTimezone(),
                    }
                  : { quiet_hours_enabled: false }
              )
            }
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
                    save({
                      quiet_hours_start: e.target.value || null,
                      quiet_hours_timezone: localTimezone(),
                    })
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
                    save({
                      quiet_hours_end: e.target.value || null,
                      quiet_hours_timezone: localTimezone(),
                    })
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
