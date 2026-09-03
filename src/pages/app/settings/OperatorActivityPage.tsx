/**
 * Operator Activity — online-time & productivity report for the workspace.
 *
 * Visible to workspace owners/admins only (the API enforces this too).
 * Online minutes come from `operator_activity_samples`, filled by the
 * panel heartbeat and filtered by each operator's availability schedule.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, Clock, Users, MessageSquare, Loader2, TrendingUp, CircleDot, Download, FileSpreadsheet,
} from 'lucide-react';

import { useI18n, useTranslation } from '@/i18n';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceRole, isWorkspaceAdmin } from '@/hooks/useWorkspaceRole';
import { fetchOperatorActivity, type OperatorActivityRow } from '@/lib/operator-activity-api';
import { exportSummaryCsv, exportDetailedCsv, exportOperatorCsv } from '@/lib/operator-activity-export';

import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SkeletonStats, SkeletonTable } from '@/components/common/Skeletons';

const RANGES = [1, 7, 30] as const;

function useFormatters(locale: string) {
  return useMemo(() => {
    const num = new Intl.NumberFormat(locale);
    return {
      num: (n: number) => num.format(n),
      dt: (iso: string | null) =>
        iso
          ? new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso))
          : '—',
    };
  }, [locale]);
}

export default function OperatorActivityPage() {
  const { t } = useTranslation();
  const { dir, locale } = useI18n();
  const { workspace } = useActiveWorkspace();
  const wsId = workspace?.id;
  const { data: role } = useWorkspaceRole(wsId);
  const [days, setDays] = useState<number>(7);
  const fmt = useFormatters(locale);

  const allowed = isWorkspaceAdmin(role);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['operator-activity', wsId, days],
    queryFn: () => fetchOperatorActivity(wsId!, days),
    enabled: !!wsId && allowed,
    refetchInterval: 60_000,
  });

  const duration = (minutes: number) => {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return t('operatorActivity.minutesShort', { n: fmt.num(m) });
    return t('operatorActivity.hoursMinutesShort', { h: fmt.num(h), m: fmt.num(m) });
  };

  if (!wsId) {
    return (
      <div className="space-y-5">
        <SkeletonStats count={4} />
        <SkeletonTable rows={6} columns={5} />
      </div>
    );
  }

  if (role && !allowed) {
    return (
      <div dir={dir} className="py-16 text-center">
        <p className="text-sm text-muted-foreground">{t('operatorActivity.adminOnly')}</p>
      </div>
    );
  }

  const maxMinutes = Math.max(1, ...(data?.operators || []).map((o) => o.online_minutes));

  return (
    <div dir={dir} className="space-y-6 animate-fade-in">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground flex items-center gap-2">
            <Activity className="h-6 w-6" />
            {t('operatorActivity.title')}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {t('operatorActivity.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-muted/30 p-1">
          {RANGES.map((r) => (
            <Button
              key={r}
              size="sm"
              variant={days === r ? 'default' : 'ghost'}
              className="h-8 px-3 text-xs"
              onClick={() => setDays(r)}
            >
              {t(`operatorActivity.range.d${r}` as Parameters<typeof t>[0])}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-9 gap-2 text-xs"
            disabled={!data?.operators.length}
            onClick={() => data && exportSummaryCsv(data)}
          >
            <Download className="h-4 w-4" />
            {t('operatorActivity.export.summary')}
          </Button>
          <Button
            size="sm"
            className="h-9 gap-2 text-xs"
            disabled={!data?.operators.length}
            onClick={() => data && exportDetailedCsv(data)}
          >
            <FileSpreadsheet className="h-4 w-4" />
            {t('operatorActivity.export.detailed')}
          </Button>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { icon: CircleDot, key: 'onlineNow', value: fmt.num(data?.totals.online_now ?? 0), tone: 'text-emerald-500' },
          { icon: Clock, key: 'totalOnline', value: duration(data?.totals.online_minutes ?? 0), tone: 'text-primary' },
          { icon: MessageSquare, key: 'replies', value: fmt.num(data?.totals.replies_sent ?? 0), tone: 'text-indigo-500' },
          { icon: Users, key: 'operators', value: fmt.num(data?.totals.operators ?? 0), tone: 'text-amber-500' },
        ].map(({ icon: Icon, key, value, tone }) => (
          <Card key={key} className="border-border/60 p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon className={`h-4 w-4 ${tone}`} />
              {t(`operatorActivity.kpi.${key}` as Parameters<typeof t>[0])}
            </div>
            <div className="mt-2 text-xl font-semibold text-foreground">{value}</div>
          </Card>
        ))}
      </div>

      {isError && (
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {(error as Error)?.message || t('operatorActivity.loadError')}
        </Card>
      )}

      {/* Operator table */}
      <Card className="overflow-hidden border-border/60">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{t('operatorActivity.tableTitle')}</h2>
          <span className="text-xs text-muted-foreground">
            {t('operatorActivity.since', { date: fmt.dt(data?.since ?? null) })}
          </span>
        </div>

        {isLoading ? (
          <div className="space-y-2 p-4" dir={dir}>
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/40" />
            ))}
          </div>
        ) : !data?.operators.length ? (
          <div className="py-14 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted/50">
              <Activity className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="font-medium text-foreground">{t('operatorActivity.emptyTitle')}</p>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
              {t('operatorActivity.emptyHint')}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {data.operators.map((op: OperatorActivityRow) => {
              const name = op.profile?.full_name || op.profile?.email || '—';
              return (
                <div key={op.user_id} className="flex flex-wrap items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/30">
                  <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-full bg-primary/10">
                    {op.profile?.avatar_url ? (
                      <img src={op.profile.avatar_url} alt={name} className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-sm font-semibold text-primary">
                        {name.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{name}</span>
                      <Badge
                        className={`border px-2 py-0 text-[10px] ${
                          op.current_state === 'online'
                            ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500'
                            : 'border-border bg-secondary text-muted-foreground'
                        }`}
                      >
                        {t(`operatorActivity.state.${op.current_state}` as Parameters<typeof t>[0])}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {t('operatorActivity.lastSeen', { date: fmt.dt(op.last_seen) })}
                    </p>
                  </div>

                  {/* Online time + bar */}
                  <div className="w-40">
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{t('operatorActivity.col.online')}</span>
                      <span className="font-medium text-foreground">{duration(op.online_minutes)}</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${Math.round((op.online_minutes / maxMinutes) * 100)}%` }}
                      />
                    </div>
                  </div>

                  <div className="hidden text-center md:block">
                    <div className="text-xs text-muted-foreground">{t('operatorActivity.col.activeDays')}</div>
                    <div className="text-sm font-medium text-foreground">{fmt.num(op.active_days)}</div>
                  </div>
                  <div className="hidden text-center md:block">
                    <div className="text-xs text-muted-foreground">{t('operatorActivity.col.avgPerDay')}</div>
                    <div className="text-sm font-medium text-foreground">{duration(op.avg_minutes_per_active_day)}</div>
                  </div>
                  <div className="hidden text-center lg:block">
                    <div className="text-xs text-muted-foreground">{t('operatorActivity.col.replies')}</div>
                    <div className="text-sm font-medium text-foreground">{fmt.num(op.replies_sent)}</div>
                  </div>
                  <div className="hidden text-center lg:block">
                    <div className="text-xs text-muted-foreground">{t('operatorActivity.col.conversations')}</div>
                    <div className="text-sm font-medium text-foreground">
                      {fmt.num(op.conversations_resolved)}/{fmt.num(op.conversations_assigned)}
                    </div>
                  </div>

                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0"
                    title={t('operatorActivity.export.one')}
                    aria-label={t('operatorActivity.export.one')}
                    onClick={() => data && exportOperatorCsv(op, data)}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="border-border/60 bg-muted/20 p-4">
        <div className="flex items-start gap-3 text-sm text-muted-foreground">
          <TrendingUp className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t('operatorActivity.methodology')}</span>
        </div>
      </Card>
    </div>
  );
}
