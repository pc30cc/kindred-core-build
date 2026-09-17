/**
 * ADMIN — ANALYTICS CUTOVER READINESS (Phase 2.5)
 *
 * Three things an operator needs before anyone can sensibly discuss turning
 * PostgreSQL off for Web Analytics:
 *
 *   1. a readiness list that says what is still blocking, from live signals;
 *   2. a way to run a parity check against REAL production data, bounded so
 *      a date picker cannot start a full-history scan of object storage;
 *   3. a way to rebuild a date range, resumable, so history can be made
 *      complete without a migration script.
 *
 * Nothing here performs a cutover. The footer says BLOCKED regardless of how
 * green the list is, because the phase lock is a separate decision from the
 * checks — and a panel that let a green list imply permission would be
 * making that decision by accident.
 *
 * No credential, endpoint or bucket name is rendered. Parity differences
 * arrive from the server with dimension values (page paths, cities, campaign
 * and event names) already replaced by stable digests: this is a platform
 * operator's screen, not the workspace's own analytics page.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Lock, PlayCircle, RefreshCw, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import {
  adminAcknowledgeAnalyticsInstances, adminBackfillAnalyticsRange, adminRunAnalyticsParity,
  type AnalyticsBackfillRangeReport, type AnalyticsParitySummaryDto,
  type AnalyticsStorageDto, type ReadinessState,
} from '@/lib/analytics-storage-api';

/** Mirrors MAX_PARITY_DAYS on the server; the server still enforces it. */
const MAX_PARITY_DAYS = 92;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function StateIcon({ state }: { state: ReadinessState }) {
  if (state === 'ready') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />;
  if (state === 'warning') return <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />;
  return <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />;
}

function stateClasses(state: ReadinessState): string {
  if (state === 'ready') return 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400';
  if (state === 'warning') return 'border-amber-500/40 text-amber-700 dark:text-amber-400';
  return 'border-destructive/40 text-destructive';
}

export function AdminAnalyticsCutoverSection({ pool }: { pool: AnalyticsStorageDto | undefined }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const readiness = pool?.readiness;
  const durability = pool?.durability;
  const instances = pool?.instances;

  const acknowledge = useMutation({
    mutationFn: () => adminAcknowledgeAnalyticsInstances(),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['admin-analytics-storage'] }); },
    onError: (error: unknown) => {
      toast({
        variant: 'destructive',
        title: t('analyticsStorage.phase25.instances.title'),
        description: error instanceof Error ? error.message : undefined,
      });
    },
  });

  const [workspaceId, setWorkspaceId] = useState('');
  const [parityFrom, setParityFrom] = useState('');
  const [parityTo, setParityTo] = useState('');
  const [includeFunnels, setIncludeFunnels] = useState(false);
  const [paritySummary, setParitySummary] = useState<AnalyticsParitySummaryDto | null>(null);

  const [backfillFrom, setBackfillFrom] = useState('');
  const [backfillTo, setBackfillTo] = useState('');
  const [backfillReport, setBackfillReport] = useState<AnalyticsBackfillRangeReport | null>(null);

  const runParity = useMutation({
    mutationFn: () => adminRunAnalyticsParity({
      workspaceId: workspaceId.trim(),
      startDate: parityFrom,
      endDate: parityTo,
      includeFunnels,
    }),
    onSuccess: (data) => setParitySummary(data.summary),
    onError: (error: unknown) => {
      setParitySummary(null);
      toast({
        variant: 'destructive',
        title: t('analyticsStorage.phase25.parityRun.title'),
        description: error instanceof Error ? error.message : undefined,
      });
    },
  });

  const runBackfill = useMutation({
    // `from` is a parameter so "Continue" can resume at nextDay without
    // waiting for React state to settle.
    mutationFn: (from: string) => adminBackfillAnalyticsRange({
      workspaceId: workspaceId.trim(),
      fromDay: from,
      toDay: backfillTo,
    }),
    onSuccess: (data) => setBackfillReport(data.report),
    onError: (error: unknown) => {
      toast({
        variant: 'destructive',
        title: t('analyticsStorage.phase25.backfill.title'),
        description: error instanceof Error ? error.message : undefined,
      });
    },
  });

  const parityRangeDays = parityFrom && parityTo
    ? Math.floor((Date.parse(`${parityTo}T00:00:00Z`) - Date.parse(`${parityFrom}T00:00:00Z`)) / 86_400_000) + 1
    : 0;
  const parityRangeTooLong = parityRangeDays > MAX_PARITY_DAYS;
  const canRunParity = !!workspaceId.trim() && !!parityFrom && !!parityTo
    && parityRangeDays > 0 && !parityRangeTooLong && !runParity.isPending;
  const canRunBackfill = !!workspaceId.trim() && !!backfillFrom && !!backfillTo && !runBackfill.isPending;

  return (
    <Card className="border-border/60">
      <CardContent className="p-4 space-y-4">
        <div className="min-w-0">
          <h4 className="text-xs font-semibold text-foreground">{t('analyticsStorage.phase25.title')}</h4>
          <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed max-w-2xl">
            {t('analyticsStorage.phase25.desc')}
          </p>
        </div>

        {/* ── The nine checks ──────────────────────────────────── */}
        {readiness && (
          <div className="rounded-lg border border-border/60 divide-y divide-border/60 overflow-hidden">
            {readiness.checks.map((check) => (
              <div key={check.key} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <StateIcon state={check.state} />
                  <span className="text-[11px] text-foreground truncate">
                    {t(`analyticsStorage.phase25.check.${check.key}` as never)}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {check.detail && (
                    <span className="text-[10px] text-muted-foreground tabular-nums truncate max-w-[12rem]">
                      {check.detail}
                    </span>
                  )}
                  <Badge variant="outline" className={cn('text-[10px] h-5', stateClasses(check.state))}>
                    {t(`analyticsStorage.phase25.state.${check.state}` as never)}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── The verdict. Locked regardless of the list above. ── */}
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 space-y-1">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Lock className="h-3.5 w-3.5 text-destructive shrink-0" />
              <span className="text-[11px] font-semibold text-foreground">
                {t('analyticsStorage.phase25.activation')}
              </span>
            </div>
            <Badge variant="outline" className="text-[10px] h-5 border-destructive/40 text-destructive">
              {t('analyticsStorage.phase25.activationBlocked')}
            </Badge>
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            {t('analyticsStorage.phase25.activationBlockedHint')}
          </p>
          {readiness && (readiness.blockedCount > 0 || readiness.warningCount > 0) && (
            <p className="text-[10px] text-muted-foreground tabular-nums">
              {readiness.blockedCount > 0 && t('analyticsStorage.phase25.blockedCount', { count: readiness.blockedCount })}
              {readiness.blockedCount > 0 && readiness.warningCount > 0 && ' · '}
              {readiness.warningCount > 0 && t('analyticsStorage.phase25.warningCount', { count: readiness.warningCount })}
            </p>
          )}
        </div>

        {/* ── Durable ingestion ────────────────────────────────── */}
        {durability && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h5 className="text-[11px] font-semibold text-foreground">
                {t('analyticsStorage.phase25.durability.title')}
              </h5>
              <Badge
                variant="outline"
                className={cn('text-[10px] h-5', stateClasses(durability.ready ? (durability.enabled ? 'ready' : 'warning') : 'blocked'))}
              >
                {durability.ready
                  ? (durability.enabled
                    ? t('analyticsStorage.phase25.durability.active')
                    : t('analyticsStorage.phase25.durability.standby'))
                  : t('analyticsStorage.phase25.durability.notReady')}
              </Badge>
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed max-w-2xl">
              {t('analyticsStorage.phase25.durability.desc')}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px]">
              <div>
                <div className="text-muted-foreground">{t('analyticsStorage.phase25.durability.segments')}</div>
                <div className="tabular-nums text-foreground">{durability.segments}</div>
              </div>
              <div>
                <div className="text-muted-foreground">{t('analyticsStorage.phase25.durability.bytes')}</div>
                <div className="tabular-nums text-foreground">{formatBytes(durability.bytes)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">{t('analyticsStorage.phase25.durability.replayed')}</div>
                <div className="tabular-nums text-foreground">{durability.replayedRows}</div>
              </div>
              <div>
                <div className="text-muted-foreground">{t('analyticsStorage.phase25.durability.dropped')}</div>
                <div className={cn('tabular-nums', durability.droppedForSize > 0 ? 'text-destructive' : 'text-foreground')}>
                  {durability.droppedForSize}
                </div>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed max-w-2xl">
              {t('analyticsStorage.phase25.durability.multiInstance')}
            </p>
            {durability.lastError && (
              <p className="text-[10px] text-destructive break-all">{durability.lastError}</p>
            )}
          </div>
        )}

        {/* ── Backend instances ────────────────────────────────── */}
        {instances && (
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h5 className="text-[11px] font-semibold text-foreground">
                {t('analyticsStorage.phase25.instances.title')}
              </h5>
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px] h-5',
                  stateClasses(!instances.multiInstance ? 'ready' : instances.acknowledged ? 'warning' : 'blocked'),
                )}
              >
                {instances.multiInstance
                  ? t('analyticsStorage.phase25.instances.multiple', { count: instances.count })
                  : t('analyticsStorage.phase25.instances.single')}
              </Badge>
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed max-w-2xl">
              {t('analyticsStorage.phase25.instances.desc')}
            </p>

            {/* Only a multi-instance fleet needs a promise. */}
            {instances.multiInstance && (
              instances.acknowledged ? (
                <p className="text-[10px] text-emerald-600">
                  {instances.acknowledgedAt
                    ? t('analyticsStorage.phase25.instances.acknowledgedAt', {
                      at: new Date(instances.acknowledgedAt).toLocaleString(),
                    })
                    : t('analyticsStorage.phase25.instances.acknowledged')}
                </p>
              ) : (
                <div className="space-y-1.5">
                  <p className="text-[10px] text-destructive">
                    {t('analyticsStorage.phase25.instances.notAcknowledged')}
                  </p>
                  <Button
                    size="sm" variant="outline" className="h-7 text-[11px]"
                    disabled={acknowledge.isPending}
                    onClick={() => acknowledge.mutate()}
                  >
                    {t('analyticsStorage.phase25.instances.acknowledge')}
                  </Button>
                </div>
              )
            )}
          </div>
        )}

        {/* ── Shared workspace selector for both tools ─────────── */}
        <div className="space-y-1.5 pt-1">
          <Label htmlFor="cutover-workspace" className="text-[11px]">
            {t('analyticsStorage.phase25.parityRun.workspaceId')}
          </Label>
          <Input
            id="cutover-workspace"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            className="h-8 text-[11px] font-mono"
          />
        </div>

        {/* ── Production parity runner ─────────────────────────── */}
        <div className="rounded-lg border border-border/60 p-3 space-y-2.5">
          <div>
            <h5 className="text-[11px] font-semibold text-foreground">
              {t('analyticsStorage.phase25.parityRun.title')}
            </h5>
            <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed max-w-2xl">
              {t('analyticsStorage.phase25.parityRun.desc')}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="parity-from" className="text-[10px]">
                {t('analyticsStorage.phase25.parityRun.from')}
              </Label>
              <Input
                id="parity-from" type="date" value={parityFrom}
                onChange={(e) => setParityFrom(e.target.value)}
                className="h-8 text-[11px]"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="parity-to" className="text-[10px]">
                {t('analyticsStorage.phase25.parityRun.to')}
              </Label>
              <Input
                id="parity-to" type="date" value={parityTo}
                onChange={(e) => setParityTo(e.target.value)}
                className="h-8 text-[11px]"
              />
            </div>
          </div>

          {parityRangeTooLong && (
            <p className="text-[10px] text-destructive">
              {t('analyticsStorage.phase25.parityRun.rangeTooLong', { max: MAX_PARITY_DAYS })}
            </p>
          )}

          <div className="flex items-center gap-2">
            <Checkbox
              id="parity-funnels"
              checked={includeFunnels}
              onCheckedChange={(v) => setIncludeFunnels(v === true)}
            />
            <Label htmlFor="parity-funnels" className="text-[10px] font-normal cursor-pointer">
              {t('analyticsStorage.phase25.parityRun.includeFunnels')}
            </Label>
          </div>

          <Button
            size="sm" variant="outline" className="h-7 text-[11px] gap-1"
            disabled={!canRunParity}
            onClick={() => runParity.mutate()}
          >
            <PlayCircle className={cn('h-3 w-3', runParity.isPending && 'animate-pulse')} />
            {runParity.isPending
              ? t('analyticsStorage.phase25.parityRun.running')
              : t('analyticsStorage.phase25.parityRun.run')}
          </Button>

          {paritySummary && (
            <>
              <div className="grid grid-cols-4 gap-2 text-[10px]">
                <div>
                  <div className="text-muted-foreground">{t('analyticsStorage.phase25.parityRun.matched')}</div>
                  <div className="tabular-nums text-emerald-600">{paritySummary.matched}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">{t('analyticsStorage.phase25.parityRun.mismatched')}</div>
                  <div className={cn('tabular-nums', paritySummary.mismatched > 0 ? 'text-destructive' : 'text-foreground')}>
                    {paritySummary.mismatched}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">{t('analyticsStorage.phase25.parityRun.skipped')}</div>
                  <div className="tabular-nums text-foreground">{paritySummary.skipped}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">{t('analyticsStorage.phase25.parityRun.errored')}</div>
                  <div className={cn('tabular-nums', paritySummary.error > 0 ? 'text-destructive' : 'text-foreground')}>
                    {paritySummary.error}
                  </div>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                {t('analyticsStorage.phase25.parityRun.redacted')}
              </p>
            </>
          )}
        </div>

        {/* ── Range backfill ───────────────────────────────────── */}
        <div className="rounded-lg border border-border/60 p-3 space-y-2.5">
          <div>
            <h5 className="text-[11px] font-semibold text-foreground">
              {t('analyticsStorage.phase25.backfill.title')}
            </h5>
            <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed max-w-2xl">
              {t('analyticsStorage.phase25.backfill.desc')}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="backfill-from" className="text-[10px]">
                {t('analyticsStorage.phase25.backfill.from')}
              </Label>
              <Input
                id="backfill-from" type="date" value={backfillFrom}
                onChange={(e) => setBackfillFrom(e.target.value)}
                className="h-8 text-[11px]"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="backfill-to" className="text-[10px]">
                {t('analyticsStorage.phase25.backfill.to')}
              </Label>
              <Input
                id="backfill-to" type="date" value={backfillTo}
                onChange={(e) => setBackfillTo(e.target.value)}
                className="h-8 text-[11px]"
              />
            </div>
          </div>

          <Button
            size="sm" variant="outline" className="h-7 text-[11px] gap-1"
            disabled={!canRunBackfill}
            onClick={() => runBackfill.mutate(backfillFrom)}
          >
            <RefreshCw className={cn('h-3 w-3', runBackfill.isPending && 'animate-spin')} />
            {runBackfill.isPending
              ? t('analyticsStorage.phase25.backfill.running')
              : t('analyticsStorage.phase25.backfill.run')}
          </Button>

          {backfillReport && (
            <div className="space-y-2">
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-[10px]">
                <div>
                  <div className="text-muted-foreground">{t('analyticsStorage.phase25.backfill.sourceRows')}</div>
                  <div className="tabular-nums text-foreground">{backfillReport.sourceRows}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">{t('analyticsStorage.phase25.backfill.writtenRows')}</div>
                  <div className="tabular-nums text-foreground">{backfillReport.writtenRows}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">{t('analyticsStorage.phase25.backfill.objects')}</div>
                  <div className="tabular-nums text-foreground">{backfillReport.objects}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">{t('analyticsStorage.phase25.backfill.bytes')}</div>
                  <div className="tabular-nums text-foreground">{formatBytes(backfillReport.bytes)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">{t('analyticsStorage.phase25.backfill.verifiedDays')}</div>
                  <div className="tabular-nums text-emerald-600">{backfillReport.verifiedDays}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">{t('analyticsStorage.phase25.backfill.failedDays')}</div>
                  <div className={cn('tabular-nums', backfillReport.failedDays.length > 0 ? 'text-destructive' : 'text-foreground')}>
                    {backfillReport.failedDays.length}
                  </div>
                </div>
              </div>

              {backfillReport.nextDay ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[10px] text-muted-foreground">
                    {t('analyticsStorage.phase25.backfill.resume', {
                      max: backfillReport.attempted, day: backfillReport.nextDay,
                    })}
                  </p>
                  <Button
                    size="sm" variant="outline" className="h-6 text-[10px]"
                    disabled={runBackfill.isPending}
                    onClick={() => {
                      const next = backfillReport.nextDay!;
                      setBackfillFrom(next);
                      runBackfill.mutate(next);
                    }}
                  >
                    {t('analyticsStorage.phase25.backfill.resumeAction')}
                  </Button>
                </div>
              ) : (
                <p className="text-[10px] text-emerald-600">
                  {t('analyticsStorage.phase25.backfill.done')}
                </p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
