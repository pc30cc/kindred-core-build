/**
 * Account Security — mirrors the Crisp "Security" panel layout but powered by
 * our self-hosted backend (Express + Supabase service role). Shows:
 *   • Active sessions (Supabase auth.sessions, geo + UA enriched)
 *   • Recent login history (login_attempts table, geo enriched)
 *
 * No Edge Functions. All reads/writes go through /api/account/security/*.
 */

import { useMemo, useState } from 'react';
import { useTranslation, useI18n } from '@/i18n';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchSecuritySessions,
  revokeSecuritySession,
  revokeAllOtherSessions,
  fetchSecurityLoginHistory,
  type AccountSecuritySession,
  type AccountLoginHistoryEntry,
} from '@/lib/account-api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';
import {
  CheckCircle2,
  Loader2,
  Monitor,
  RefreshCw,
  Shield,
  ShieldX,
  Smartphone,
  Tablet,
  X,
} from 'lucide-react';
import { ShieldAlert, ShieldCheck, LogIn, Clock, Globe2, KeyRound } from 'lucide-react';
import { cn } from '@/lib/utils';

function deviceIcon(device: string) {
  if (device === 'Mobile') return Smartphone;
  if (device === 'Tablet') return Tablet;
  return Monitor;
}

function flagEmoji(cc: string | null): string {
  if (!cc || cc.length !== 2) return '';
  const A = 0x1f1e6;
  const base = 'A'.charCodeAt(0);
  return String.fromCodePoint(A + cc.toUpperCase().charCodeAt(0) - base) +
         String.fromCodePoint(A + cc.toUpperCase().charCodeAt(1) - base);
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat(locale, {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  } catch {
    return iso;
  }
}

function formatRelative(iso: string | null, locale: string): string {
  if (!iso) return '—';
  try {
    const diffMs = new Date(iso).getTime() - Date.now();
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const abs = Math.abs(diffMs);
    const min = 60_000, hour = 3_600_000, day = 86_400_000;
    if (abs < hour) return rtf.format(Math.round(diffMs / min), 'minute');
    if (abs < day) return rtf.format(Math.round(diffMs / hour), 'hour');
    return rtf.format(Math.round(diffMs / day), 'day');
  } catch {
    return formatDate(iso, locale);
  }
}

function StatTile({
  icon: Icon,
  label,
  value,
  tone = 'default',
}: {
  icon: any;
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'danger';
}) {
  return (
    <Card className="flex items-center gap-3 border-border/60 p-4 shadow-sm">
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
          tone === 'success' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
          tone === 'danger' && 'bg-destructive/10 text-destructive',
          tone === 'default' && 'bg-primary/10 text-primary',
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-semibold text-foreground">{value}</p>
      </div>
    </Card>
  );
}

function LocationCell({
  country,
  countryCode,
  city,
  ip,
  unknownLabel,
}: {
  country: string | null;
  countryCode: string | null;
  city: string | null;
  ip: string;
  unknownLabel: string;
}) {
  if (!country && !ip) {
    return <span className="text-muted-foreground">{unknownLabel}</span>;
  }
  const emoji = flagEmoji(countryCode);
  return (
    <div className="flex items-center gap-2">
      {emoji && <span aria-hidden className="text-base leading-none">{emoji}</span>}
      <span className="text-foreground">
        {country || unknownLabel}
        {city ? <span className="text-muted-foreground"> · {city}</span> : null}
      </span>
      {ip && <span className="text-xs text-muted-foreground">({ip})</span>}
    </div>
  );
}

export default function SettingsSecurityPage() {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const qc = useQueryClient();

  const sessionsQ = useQuery({
    queryKey: ['account', 'security', 'sessions'],
    queryFn: fetchSecuritySessions,
    refetchInterval: 60_000,
  });

  const historyQ = useQuery({
    queryKey: ['account', 'security', 'login-history'],
    queryFn: () => fetchSecurityLoginHistory(25),
    refetchInterval: 60_000,
  });

  const revokeOne = useMutation({
    mutationFn: revokeSecuritySession,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['account', 'security', 'sessions'] });
      toast({ title: t('security.revokeSuccess' as any) });
    },
    onError: (err: any) => {
      toast({ title: t('security.revokeError' as any), description: err?.message, variant: 'destructive' });
    },
  });

  const revokeAll = useMutation({
    mutationFn: revokeAllOtherSessions,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['account', 'security', 'sessions'] });
      toast({ title: t('security.revokeSuccess' as any) });
    },
    onError: (err: any) => {
      toast({ title: t('security.revokeError' as any), description: err?.message, variant: 'destructive' });
    },
  });

  const [revokeTarget, setRevokeTarget] = useState<AccountSecuritySession | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);

  const sessions = sessionsQ.data?.sessions ?? [];
  const otherCount = sessions.filter(s => !s.is_current).length;
  const loading = sessionsQ.isLoading || historyQ.isLoading;
  const history = historyQ.data?.entries ?? [];

  const stats = useMemo(() => {
    const lastSuccess = history.find((h) => h.success)?.created_at ?? null;
    const since = Date.now() - 24 * 3600_000;
    const failed24 = history.filter(
      (h) => !h.success && h.created_at && new Date(h.created_at).getTime() >= since,
    ).length;
    return { lastSuccess, failed24 };
  }, [history]);

  const hasError = sessionsQ.isError || historyQ.isError;

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t('security.title' as any)}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('security.subtitle' as any)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          {t('security.autoSaved' as any)}
        </div>
      </div>

      {hasError && (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          {t('security.loadError' as any)}
        </div>
      )}

      {/* Overview */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={ShieldCheck}
          tone="success"
          label={t('security.overviewSessions' as any) as string}
          value={sessionsQ.isLoading ? '…' : String(sessions.length)}
        />
        <StatTile
          icon={Globe2}
          label={t('security.overviewOther' as any) as string}
          value={sessionsQ.isLoading ? '…' : String(otherCount)}
        />
        <StatTile
          icon={LogIn}
          label={t('security.overviewLastLogin' as any) as string}
          value={historyQ.isLoading ? '…' : formatRelative(stats.lastSuccess, locale)}
        />
        <StatTile
          icon={KeyRound}
          tone={stats.failed24 > 0 ? 'danger' : 'default'}
          label={t('security.overviewFailed' as any) as string}
          value={historyQ.isLoading ? '…' : String(stats.failed24)}
        />
      </div>

      {/* Active sessions */}
      <Card className="overflow-hidden border-border/60 shadow-sm">
        <div className="flex items-center justify-between gap-4 border-b border-border/60 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{t('security.activeSessions' as any)}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('security.activeSessionsHelper' as any)}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => sessionsQ.refetch()}
              disabled={sessionsQ.isFetching}
              className="text-muted-foreground"
            >
              <RefreshCw className={cn('me-1.5 h-3.5 w-3.5', sessionsQ.isFetching && 'animate-spin')} />
              {t('security.refresh' as any)}
            </Button>
            {otherCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRevokeAllOpen(true)}
                disabled={revokeAll.isPending}
              >
                <ShieldX className="me-1.5 h-3.5 w-3.5" />
                {t('security.revokeAll' as any)}
              </Button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-center">
            <Shield className="h-6 w-6 text-muted-foreground/60" />
            <p className="text-sm text-muted-foreground">{t('security.noSessions' as any)}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-6 py-3 text-start font-medium">{t('security.sessionDevice' as any)}</th>
                  <th className="px-6 py-3 text-start font-medium">{t('security.sessionLocation' as any)}</th>
                  <th className="px-6 py-3 text-start font-medium">{t('security.sessionLastActive' as any)}</th>
                  <th className="px-6 py-3 text-end font-medium">{t('security.sessionActions' as any)}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {sessions.map((s) => {
                  const Icon = deviceIcon(s.device);
                  return (
                    <tr key={s.id} className="transition-colors hover:bg-muted/20">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                            <Icon className="h-4 w-4" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-foreground">
                                {s.browser} <span className="text-muted-foreground">({s.os})</span>
                              </span>
                              {s.is_current && (
                                <Badge variant="secondary" className="border-emerald-500/30 bg-emerald-500/10 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                                  {t('security.thisDevice' as any)}
                                </Badge>
                              )}
                            </div>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {t('security.signedInAt' as any)}: {formatDate(s.created_at, locale)}
                              {' · '}
                              {t('security.expiresAt' as any)}:{' '}
                              {s.not_after ? formatDate(s.not_after, locale) : (t('security.neverExpires' as any) as string)}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <LocationCell
                          country={s.country}
                          countryCode={s.country_code}
                          city={s.city}
                          ip={s.ip}
                          unknownLabel={t('security.unknownLocation' as any)}
                        />
                      </td>
                      <td className="px-6 py-4 text-muted-foreground" title={formatDate(s.last_active_at, locale)}>
                        <span className="inline-flex items-center gap-1.5">
                          <Clock className="h-3.5 w-3.5" />
                          {formatRelative(s.last_active_at, locale)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-end">
                        {s.is_current ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRevokeTarget(s)}
                            disabled={revokeOne.isPending}
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          >
                            <X className="me-1 h-3.5 w-3.5" />
                            {t('security.revoke' as any)}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Recent login history */}
      <Card className="overflow-hidden border-border/60 shadow-sm">
        <div className="flex items-center justify-between gap-4 border-b border-border/60 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">{t('security.loginHistory' as any)}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('security.loginHistoryHelper' as any)}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => historyQ.refetch()}
            disabled={historyQ.isFetching}
            className="text-muted-foreground"
          >
            <RefreshCw className={cn('me-1.5 h-3.5 w-3.5', historyQ.isFetching && 'animate-spin')} />
            {t('security.refresh' as any)}
          </Button>
        </div>

        {historyQ.isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : history.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            {t('security.noHistory' as any)}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-6 py-3 text-start font-medium">{t('security.historyDate' as any)}</th>
                  <th className="px-6 py-3 text-start font-medium">{t('security.historyLocation' as any)}</th>
                  <th className="px-6 py-3 text-end font-medium">{t('security.historyState' as any)}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {history.map((h: AccountLoginHistoryEntry) => (
                  <tr key={h.id} className="transition-colors hover:bg-muted/20">
                    <td className="px-6 py-4 text-foreground">{formatDate(h.created_at, locale)}</td>
                    <td className="px-6 py-4">
                      <LocationCell
                        country={h.country}
                        countryCode={h.country_code}
                        city={h.city}
                        ip={h.ip}
                        unknownLabel={t('security.unknownLocation' as any)}
                      />
                    </td>
                    <td className="px-6 py-4 text-end">
                      {h.success ? (
                        <Badge variant="secondary" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                          {t('security.stateAuthorized' as any)}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="border-destructive/30 bg-destructive/10 text-destructive">
                          {t('security.stateFailed' as any)}
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Safety tip */}
      <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
        <Shield className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div>
          <p className="text-sm font-medium text-foreground">{t('security.tipTitle' as any)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('security.tipBody' as any)}</p>
        </div>
      </div>

      {/* Revoke single session */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('security.revoke' as any)}</AlertDialogTitle>
            <AlertDialogDescription>{t('security.revokeConfirm' as any)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel' as any)}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revokeTarget) revokeOne.mutate(revokeTarget.id);
                setRevokeTarget(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('security.revoke' as any)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke all others */}
      <AlertDialog open={revokeAllOpen} onOpenChange={setRevokeAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('security.revokeAll' as any)}</AlertDialogTitle>
            <AlertDialogDescription>{t('security.revokeAllConfirm' as any)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel' as any)}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                revokeAll.mutate();
                setRevokeAllOpen(false);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('security.revokeAll' as any)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}