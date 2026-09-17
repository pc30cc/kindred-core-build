/**
 * Delivery diagnostics — the last 50 dispatches with their real outcome.
 *
 * `attempted` rows are not failures: a row is claimed before the send and
 * updated after it, so a row stuck on `attempted` means the process died
 * mid-dispatch, which is a genuinely different signal from `failed`.
 */
import { useState } from 'react';
import { Activity, CheckCircle2, CircleDashed, RefreshCw, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useI18n, useTranslation, type TranslationKey } from '@/i18n';
import { useDispatchLog } from '@/hooks/useAdminNotifications';
import { cn } from '@/lib/utils';

const FILTERS = ['all', 'sent', 'failed', 'attempted'] as const;

export function NotificationDiagnosticsTab({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const [status, setStatus] = useState<string>('all');
  const { data, isLoading, refetch, isFetching } = useDispatchLog(status);

  const dateLocale = locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';
  const format = new Intl.DateTimeFormat(dateLocale, { dateStyle: 'short', timeStyle: 'medium' });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              <div>
                <CardTitle className="text-base">
                  {t('admin.notifications.diagnostics.title')}
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('admin.notifications.diagnostics.subtitle')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 rounded-xl border border-border/70 p-1">
                {FILTERS.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    onClick={() => setStatus(entry)}
                    className={cn(
                      'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                      status === entry
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {t(`admin.notifications.diagnostics.filter.${entry}` as TranslationKey)}
                  </button>
                ))}
              </div>
              <Button size="sm" variant="outline" onClick={() => refetch()} disabled={!active || isFetching}>
                <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {data && (
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              {(['devices', 'accepted', 'failed'] as const).map((key) => (
                <div key={key} className="rounded-xl border border-border/70 p-3">
                  <p className="text-xs text-muted-foreground">
                    {t(`admin.notifications.diagnostics.total.${key}` as TranslationKey)}
                  </p>
                  <p className="mt-1 text-2xl font-bold tabular-nums">{data.totals[key]}</p>
                </div>
              ))}
            </div>
          )}

          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : !data?.entries.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('admin.notifications.diagnostics.empty')}
            </p>
          ) : (
            <div className="space-y-1.5">
              {data.entries.map((entry) => {
                const Icon =
                  entry.status === 'sent'
                    ? CheckCircle2
                    : entry.status === 'failed'
                      ? XCircle
                      : CircleDashed;
                const tone =
                  entry.status === 'sent'
                    ? 'text-emerald-600'
                    : entry.status === 'failed'
                      ? 'text-destructive'
                      : 'text-amber-600';
                return (
                  <div
                    key={entry.id}
                    className="flex items-start gap-3 rounded-xl border border-border/70 p-3"
                  >
                    <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">
                          {t(`admin.notifications.events.${entry.notification_type}` as TranslationKey)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t('admin.notifications.diagnostics.deviceSummary', {
                            accepted: entry.accepted_count,
                            devices: entry.device_count,
                          })}
                        </span>
                      </div>
                      {entry.error && (
                        <p dir="ltr" className="mt-1 truncate font-mono text-[11px] text-destructive">
                          {entry.error}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {format.format(new Date(entry.created_at))}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
