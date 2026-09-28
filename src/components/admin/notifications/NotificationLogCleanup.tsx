/**
 * The notification log's cleanup: automatic, and on demand.
 *
 * Every notification sent to the iPhone and Android apps leaves one row in
 * `push_dispatch_log` — the row that stops it being sent twice, and what the
 * list below shows. Nothing ever removed one; the retention field used to sit
 * under Policy with nothing behind it. The server's janitor now applies it
 * while the switch is on, and "Clean up now" applies it immediately — to the
 * days shown here, saved or not, and after asking, since it cannot be undone.
 */
import { useState } from 'react';
import { Eraser, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { SettingsSection, FieldGrid, SwitchField, TextField } from '@/components/admin/settings/SettingsFields';
import { toast } from '@/hooks/use-toast';
import { useI18n, useTranslation } from '@/i18n';
import {
  useDispatchLogStats,
  usePurgeDispatchLog,
  type PushPlatformSettings,
} from '@/hooks/useAdminNotifications';

export function NotificationLogCleanup({
  draft,
  set,
}: {
  draft: PushPlatformSettings;
  set: (patch: Partial<PushPlatformSettings>) => void;
}) {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const days = draft.dispatch_log_retention_days;
  const { data: stats } = useDispatchLogStats(days);
  const purge = usePurgeDispatchLog();
  const [confirming, setConfirming] = useState(false);

  const dateLocale = locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';
  const format = new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium', timeStyle: 'short' });
  const number = new Intl.NumberFormat(dateLocale);

  const onPurge = async () => {
    try {
      const result = await purge.mutateAsync(days);
      toast({
        title: result.removed
          ? t('admin.notifications.diagnostics.cleanup.done', { count: number.format(result.removed) })
          : t('admin.notifications.diagnostics.cleanup.nothing', { days }),
      });
    } catch (e) {
      toast({
        title: t('admin.notifications.diagnostics.cleanup.failed'),
        description: e instanceof Error ? e.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setConfirming(false);
    }
  };

  const facts: { label: string; value: string }[] = stats
    ? [
        { label: t('admin.notifications.diagnostics.cleanup.records'), value: number.format(stats.total) },
        {
          label: t('admin.notifications.diagnostics.cleanup.expired', { days }),
          value: number.format(stats.expired),
        },
        {
          label: t('admin.notifications.diagnostics.cleanup.oldest'),
          value: stats.oldest ? format.format(new Date(stats.oldest)) : '—',
        },
        {
          label: t('admin.notifications.diagnostics.cleanup.lastRun'),
          value: stats.lastPurgedAt
            ? t('admin.notifications.diagnostics.cleanup.lastRunValue', {
                date: format.format(new Date(stats.lastPurgedAt)),
                count: number.format(stats.lastPurgedCount ?? 0),
              })
            : t('admin.notifications.diagnostics.cleanup.never'),
        },
      ]
    : [];

  return (
    <SettingsSection
      icon={Eraser}
      heading={t('admin.notifications.diagnostics.cleanup.title')}
      caption={t('admin.notifications.diagnostics.cleanup.caption')}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => setConfirming(true)}
          disabled={purge.isPending}
        >
          {purge.isPending ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Eraser className="me-2 h-4 w-4" />}
          {t('admin.notifications.diagnostics.cleanup.now')}
        </Button>
      }
    >
      <FieldGrid>
        <SwitchField
          label={t('admin.notifications.diagnostics.cleanup.auto')}
          hint={t('admin.notifications.diagnostics.cleanup.autoHint')}
          checked={draft.dispatch_log_auto_purge}
          onChange={(dispatch_log_auto_purge) => set({ dispatch_log_auto_purge })}
        />
        <TextField
          label={t('admin.notifications.policy.logRetention')}
          hint={t('admin.notifications.policy.logRetentionHint')}
          value={String(days)}
          dir="ltr"
          type="number"
          onChange={(value) =>
            set({ dispatch_log_retention_days: Math.min(365, Math.max(1, Number(value) || 1)) })
          }
        />
      </FieldGrid>

      {facts.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-4">
          {facts.map((fact) => (
            <div key={fact.label} className="rounded-xl border border-border/70 p-3">
              <p className="text-xs text-muted-foreground">{fact.label}</p>
              <p className="mt-1 text-sm font-semibold tabular-nums">{fact.value}</p>
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={confirming} onOpenChange={(open) => !open && !purge.isPending && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.notifications.diagnostics.cleanup.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin.notifications.diagnostics.cleanup.confirmBody', {
                days,
                count: number.format(stats?.expired ?? 0),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={purge.isPending}>
              {t('admin.notifications.diagnostics.cleanup.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={purge.isPending}
              onClick={(event) => {
                event.preventDefault();
                void onPurge();
              }}
            >
              {purge.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('admin.notifications.diagnostics.cleanup.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
