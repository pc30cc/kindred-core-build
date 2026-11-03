import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { aiAgentApi, type RegressionSchedule, type RegressionBatch, type TestRun } from '@/lib/ai-agent-api';
import { useCurrentWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useWorkspaceRole, isWorkspaceAdmin } from '@/hooks/useWorkspaceRole';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatDateTime } from '@/lib/date';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { toast } from '@/hooks/use-toast';
import { Download } from 'lucide-react';
import { isolate, useTestRunLabels, type TestRunLabels } from './testRunLabels';
import { pickErrorText } from './apiErrorCode';
import { regressionFailureReason } from './regressionReasons';

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;
type BatchStatus = RegressionBatch['status'];
type BatchTrigger = RegressionBatch['trigger_type'];

/** The name the database gives a workspace's first schedule (ai_agent_regression_schedules.name default). */
const DEFAULT_SCHEDULE_NAME = 'Default regression schedule';

const BATCH_STATUSES: BatchStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled'];
const TRIGGERS: BatchTrigger[] = ['manual', 'scheduled'];
const FREQUENCIES: RegressionSchedule['frequency'][] = ['hourly', 'daily', 'weekly', 'manual'];

/** A run of a batch as GET /regression/batches/:id returns it: the test run and its case. */
type BatchRun = TestRun & {
  test_case?: { name?: string | null; expected_behavior?: string | null; locale?: string | null } | null;
};

/** The next run in UTC (the tooltip beside the schedule's own clock). */
const UTC_DATE_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
};

function pct(n: number | null | undefined) {
  return n == null ? '—' : `${Math.round(n * 100)}%`;
}

function regressionWords(t: Translate) {
  const statusMap: Record<string, string> = {
    queued: t('aiAgent.adv.regression.status.queued'),
    running: t('aiAgent.adv.regression.status.running'),
    completed: t('aiAgent.adv.regression.status.completed'),
    failed: t('aiAgent.adv.regression.status.failed'),
    cancelled: t('aiAgent.adv.regression.status.cancelled'),
  };
  const triggerMap: Record<string, string> = {
    manual: t('aiAgent.adv.regression.trigger.manual'),
    scheduled: t('aiAgent.adv.regression.trigger.scheduled'),
  };
  const frequencyMap: Record<string, string> = {
    hourly: t('aiAgent.adv.regression.frequency.hourly'),
    daily: t('aiAgent.adv.regression.frequency.daily'),
    weekly: t('aiAgent.adv.regression.frequency.weekly'),
    manual: t('aiAgent.adv.regression.frequency.manual'),
  };
  const warningMap: Record<string, string> = {
    timezone_invalid_fallback_utc: t('aiAgent.adv.regression.schedule.warnings.timezone_invalid_fallback_utc'),
    time_of_day_invalid_interval_fallback: t('aiAgent.adv.regression.schedule.warnings.time_of_day_invalid_interval_fallback'),
  };
  const pick = (map: Record<string, string>, code: string | null | undefined) =>
    code ? (Object.prototype.hasOwnProperty.call(map, code) ? map[code] : isolate(code)) : '—';
  return {
    status: (code: string | null | undefined) => pick(statusMap, code),
    trigger: (code: string | null | undefined) => pick(triggerMap, code),
    frequency: (code: string) => pick(frequencyMap, code),
    warning: (code: string) => pick(warningMap, code),
    scheduleName: (name: string | null | undefined) =>
      name === DEFAULT_SCHEDULE_NAME ? t('aiAgent.adv.regression.schedule.defaultName') : (name || '—'),
    duration: (ms: number | null | undefined) => {
      if (!ms || ms < 0) return '—';
      const s = Math.round(ms / 1000);
      if (s < 60) return t('aiAgent.adv.regression.duration.seconds', { s });
      const m = Math.floor(s / 60), rem = s % 60;
      if (m < 60) return t('aiAgent.adv.regression.duration.minutes', { m, s: rem });
      const h = Math.floor(m / 60), mm = m % 60;
      return t('aiAgent.adv.regression.duration.hours', { h, m: mm });
    },
  };
}

type RegressionWords = ReturnType<typeof regressionWords>;

/** A refused request of this page as a sentence; codes it does not know go to the test tools' shared messages. */
function regressionError(t: Translate, labels: TestRunLabels) {
  const own: Record<string, string> = {
    update_failed: t('aiAgent.adv.regression.errors.update_failed'),
    enqueue_failed: t('aiAgent.adv.regression.errors.enqueue_failed'),
    cancel_failed: t('aiAgent.adv.regression.errors.cancel_failed'),
    retry_failed: t('aiAgent.adv.regression.errors.retry_failed'),
    no_failed_cases: t('aiAgent.adv.regression.toast.noFailedCases'),
    duplicate: t('aiAgent.adv.regression.toast.duplicate'),
  };
  return (e: unknown) => pickErrorText(e, own, labels.error);
}

export default function RegressionRunsPage() {
  const { t } = useTranslation();
  const labels = useTestRunLabels();
  const words = regressionWords(t);
  const errorText = regressionError(t, labels);
  const failureReason = regressionFailureReason(t, labels);
  const ws = useCurrentWorkspace();
  const wsId = ws?.id;
  const wsPath = useWorkspacePath();
  const roleQ = useWorkspaceRole(wsId);
  const isOwnerOrAdmin = isWorkspaceAdmin(roleQ.data);
  const qc = useQueryClient();
  const [openBatch, setOpenBatch] = useState<string | null>(null);
  const [filters, setFilters] = useState<{
    status: string; triggerType: string; scheduleId: string;
    dateFrom: string; dateTo: string; onlyFailed: boolean;
  }>({ status: 'all', triggerType: 'all', scheduleId: 'all', dateFrom: '', dateTo: '', onlyFailed: false });

  const schedulesQ = useQuery({
    queryKey: ['ai-agent', 'regression-schedules', wsId],
    queryFn: () => aiAgentApi.listRegressionSchedules(wsId!),
    enabled: !!wsId,
  });
  const batchesQ = useQuery({
    queryKey: ['ai-agent', 'regression-batches', wsId, filters],
    queryFn: () => aiAgentApi.listRegressionBatches(wsId!, {
      limit: 50,
      status: filters.status !== 'all' ? (filters.status as BatchStatus) : null,
      triggerType: filters.triggerType !== 'all' ? (filters.triggerType as BatchTrigger) : null,
      scheduleId: filters.scheduleId !== 'all' ? filters.scheduleId : null,
      dateFrom: filters.dateFrom ? new Date(filters.dateFrom).toISOString() : null,
      dateTo: filters.dateTo ? new Date(filters.dateTo + 'T23:59:59').toISOString() : null,
      onlyFailed: filters.onlyFailed,
    }),
    enabled: !!wsId,
    refetchInterval: 10_000,
  });

  const overviewQ = useQuery({
    queryKey: ['ai-agent', 'regression-overview', wsId],
    queryFn: () => aiAgentApi.getRegressionOverview(wsId!),
    enabled: !!wsId,
    refetchInterval: 30_000,
  });

  const schedule: RegressionSchedule | null = schedulesQ.data?.items?.[0] || null;

  const ensureMut = useMutation({
    mutationFn: () => aiAgentApi.getOrCreateRegressionSchedule(wsId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-agent', 'regression-schedules', wsId] }),
  });

  const updateMut = useMutation({
    mutationFn: (patch: Partial<RegressionSchedule>) => aiAgentApi.updateRegressionSchedule(schedule!.id, patch),
    onSuccess: () => {
      toast({ title: t('aiAgent.adv.regression.toast.scheduleSaved') });
      qc.invalidateQueries({ queryKey: ['ai-agent', 'regression-schedules', wsId] });
    },
    onError: (e: unknown) => toast({ title: t('aiAgent.adv.regression.toast.saveFailed'), description: errorText(e), variant: 'destructive' }),
  });

  const runNowMut = useMutation({
    mutationFn: () => aiAgentApi.runRegressionNow(wsId!, schedule?.id || null),
    onSuccess: () => {
      toast({ title: t('aiAgent.adv.regression.toast.batchQueued'), description: t('aiAgent.adv.regression.toast.batchQueuedDesc') });
      qc.invalidateQueries({ queryKey: ['ai-agent', 'regression-batches', wsId] });
    },
    onError: (e: unknown) => toast({ title: t('aiAgent.adv.regression.toast.enqueueFailed'), description: errorText(e), variant: 'destructive' }),
  });

  const batches = batchesQ.data?.items || [];
  const overview = overviewQ.data;
  const schedules = schedulesQ.data?.items || [];

  if (!wsId) return <div className="p-6 text-muted-foreground">{t('aiAgent.adv.regression.loadingWorkspace')}</div>;

  const nextDueTimezone = overview?.next_due_schedule?.timezone;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('aiAgent.adv.regression.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('aiAgent.adv.regression.subtitle')}
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>{t('aiAgent.adv.regression.schedule.title')}</CardTitle></CardHeader>
        <CardContent>
          {!schedule ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{t('aiAgent.adv.regression.schedule.none')}</p>
              <Button
                size="sm"
                disabled={!isOwnerOrAdmin || ensureMut.isPending}
                onClick={() => ensureMut.mutate()}
              >
                {ensureMut.isPending ? t('aiAgent.adv.regression.schedule.creating') : t('aiAgent.adv.regression.schedule.create')}
              </Button>
            </div>
          ) : (
            <ScheduleEditor
              schedule={schedule}
              canEdit={isOwnerOrAdmin}
              saving={updateMut.isPending}
              onSave={(p) => updateMut.mutate(p)}
              onRunNow={() => runNowMut.mutate()}
              runningNow={runNowMut.isPending}
              words={words}
            />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <SummaryCard
          label={t('aiAgent.adv.regression.summary.enabledSchedules')}
          value={t('aiAgent.adv.regression.summary.ofTotal', { count: overview?.enabled_schedules ?? 0, total: overview?.total_schedules ?? 0 })}
        />
        <SummaryCard
          label={t('aiAgent.adv.regression.summary.nextRun')}
          value={formatDateTime(overview?.next_due_schedule?.next_run_at || schedule?.next_run_at)}
          sub={nextDueTimezone ? isolate(nextDueTimezone) : undefined}
        />
        <SummaryCard
          label={t('aiAgent.adv.regression.summary.passRate24h')}
          value={pct(overview?.last_24h_pass_rate ?? null)}
          sub={t('aiAgent.adv.regression.summary.batches', { count: overview?.last_24h_batches ?? 0 })}
        />
        <SummaryCard
          label={t('aiAgent.adv.regression.summary.failedBatches7d')}
          value={String(overview?.failed_batches_count ?? 0)}
          sub={t('aiAgent.adv.regression.summary.erroredRuns', { count: overview?.errored_runs_count ?? 0 })}
          tone={overview && overview.failed_batches_count > 0 ? 'red' : 'green'}
        />
        <SummaryCard
          label={t('aiAgent.adv.regression.summary.lastBatch')}
          value={overview?.last_batch ? words.status(overview.last_batch.status) : '—'}
          sub={overview?.last_batch
            ? t('aiAgent.adv.regression.summary.lastBatchPassed', { passed: overview.last_batch.passed, total: overview.last_batch.total_cases })
            : undefined}
          tone={overview?.last_batch ? statusTone(overview.last_batch.status) : undefined}
        />
      </div>

      {overview && overview.top_failure_reasons.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{t('aiAgent.adv.regression.topFailures.title')}</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {overview.top_failure_reasons.map((r) => (
                <Badge key={r.reason} variant="outline" className="text-xs">
                  <span className="me-1">{failureReason(r.reason)}</span>
                  <span className="text-muted-foreground">{t('aiAgent.adv.regression.topFailures.count', { count: r.count })}</span>
                </Badge>
              ))}
            </div>
            {overview.coverage_by_source_type.length > 0 && (
              <div className="mt-3 text-xs text-muted-foreground">
                {t('aiAgent.adv.regression.topFailures.coverage')}{' '}
                {overview.coverage_by_source_type
                  .map((c) => t('aiAgent.adv.regression.topFailures.coverageItem', { type: labels.sourceType(c.source_type), count: c.runs }))
                  .join(' · ')}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>{t('aiAgent.adv.regression.history.title')}</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-3">
            <div>
              <Label className="text-xs" htmlFor="regression-filter-status">{t('aiAgent.adv.regression.history.filters.status')}</Label>
              <Select value={filters.status} onValueChange={(v) => setFilters((f) => ({ ...f, status: v }))}>
                <SelectTrigger id="regression-filter-status" className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('aiAgent.adv.regression.history.filters.all')}</SelectItem>
                  {BATCH_STATUSES.map((s) => <SelectItem key={s} value={s}>{words.status(s)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs" htmlFor="regression-filter-trigger">{t('aiAgent.adv.regression.history.filters.trigger')}</Label>
              <Select value={filters.triggerType} onValueChange={(v) => setFilters((f) => ({ ...f, triggerType: v }))}>
                <SelectTrigger id="regression-filter-trigger" className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('aiAgent.adv.regression.history.filters.all')}</SelectItem>
                  {TRIGGERS.map((tr) => <SelectItem key={tr} value={tr}>{words.trigger(tr)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs" htmlFor="regression-filter-schedule">{t('aiAgent.adv.regression.history.filters.schedule')}</Label>
              <Select value={filters.scheduleId} onValueChange={(v) => setFilters((f) => ({ ...f, scheduleId: v }))}>
                <SelectTrigger id="regression-filter-schedule" className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('aiAgent.adv.regression.history.filters.all')}</SelectItem>
                  {schedules.map((s) => <SelectItem key={s.id} value={s.id}>{words.scheduleName(s.name)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs" htmlFor="regression-filter-from">{t('aiAgent.adv.regression.history.filters.from')}</Label>
              <Input id="regression-filter-from" type="date" className="h-8" value={filters.dateFrom}
                onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))} />
            </div>
            <div>
              <Label className="text-xs" htmlFor="regression-filter-to">{t('aiAgent.adv.regression.history.filters.to')}</Label>
              <Input id="regression-filter-to" type="date" className="h-8" value={filters.dateTo}
                onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))} />
            </div>
            <div className="flex items-end gap-2">
              <div className="flex items-center gap-2">
                <Switch id="regression-filter-only-failed" checked={filters.onlyFailed}
                  onCheckedChange={(v) => setFilters((f) => ({ ...f, onlyFailed: v }))} />
                <Label className="text-xs" htmlFor="regression-filter-only-failed">{t('aiAgent.adv.regression.history.filters.onlyFailed')}</Label>
              </div>
              <Button size="sm" variant="ghost" className="h-8"
                onClick={() => setFilters({ status: 'all', triggerType: 'all', scheduleId: 'all', dateFrom: '', dateTo: '', onlyFailed: false })}>
                {t('aiAgent.adv.regression.history.filters.reset')}
              </Button>
            </div>
          </div>
          {batchesQ.isLoading ? (
            <div className="text-sm text-muted-foreground">{t('aiAgent.adv.regression.loading')}</div>
          ) : !batches.length ? (
            <div className="text-sm text-muted-foreground">{t('aiAgent.adv.regression.history.empty')}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr className="text-start text-muted-foreground border-b border-border/40">
                    <th className="py-2 pe-2 text-start">{t('aiAgent.adv.regression.history.cols.status')}</th>
                    <th className="py-2 pe-2 text-start">{t('aiAgent.adv.regression.history.cols.trigger')}</th>
                    <th className="py-2 pe-2 text-start">{t('aiAgent.adv.regression.history.cols.total')}</th>
                    <th className="py-2 pe-2 text-start">{t('aiAgent.adv.regression.history.cols.passed')}</th>
                    <th className="py-2 pe-2 text-start">{t('aiAgent.adv.regression.history.cols.failed')}</th>
                    <th className="py-2 pe-2 text-start">{t('aiAgent.adv.regression.history.cols.errored')}</th>
                    <th className="py-2 pe-2 text-start">{t('aiAgent.adv.regression.history.cols.passRate')}</th>
                    <th className="py-2 pe-2 text-start">{t('aiAgent.adv.regression.history.cols.started')}</th>
                    <th className="py-2 pe-2 text-start">{t('aiAgent.adv.regression.history.cols.finished')}</th>
                    <th className="py-2 pe-2"><span className="sr-only">{t('aiAgent.adv.regression.history.cols.actions')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => {
                    const meta = (b.metadata || {}) as Record<string, unknown>;
                    const idx = typeof meta.current_case_index === 'number' ? meta.current_case_index : 0;
                    const total = b.total_cases || 0;
                    const showProgress = b.status === 'running' || b.status === 'queued';
                    return (
                      <tr key={b.id} className="border-b border-border/30">
                        <td className="py-1 pe-2">
                          <BatchStatusBadge status={b.status} words={words} />
                          {showProgress && total > 0 && (
                            <div className="mt-1 w-32">
                              <Progress value={(idx / total) * 100} className="h-1" />
                              <div className="text-[10px] text-muted-foreground">{t('aiAgent.adv.regression.history.progress', { done: idx, total })}</div>
                            </div>
                          )}
                        </td>
                        <td className="py-1 pe-2"><Badge variant="outline">{words.trigger(b.trigger_type)}</Badge></td>
                        <td className="py-1 pe-2">{b.total_cases}</td>
                        <td className="py-1 pe-2 text-emerald-600">{b.passed}</td>
                        <td className="py-1 pe-2 text-destructive">{b.failed}</td>
                        <td className="py-1 pe-2 text-amber-600">{b.errored}</td>
                        <td className="py-1 pe-2">{pct(b.pass_rate)}</td>
                        <td className="py-1 pe-2">{formatDateTime(b.started_at)}</td>
                        <td className="py-1 pe-2">{formatDateTime(b.finished_at)}</td>
                        <td className="py-1 pe-2">
                          <Button size="sm" variant="ghost" onClick={() => setOpenBatch(b.id)}>{t('aiAgent.adv.regression.history.open')}</Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <BatchDetailDialog
        batchId={openBatch}
        onClose={() => setOpenBatch(null)}
        wsPath={wsPath}
        canManage={isOwnerOrAdmin}
        onChanged={() => qc.invalidateQueries({ queryKey: ['ai-agent', 'regression-batches', wsId] })}
        onOpenChild={(id) => setOpenBatch(id)}
        words={words}
        labels={labels}
        errorText={errorText}
      />
    </div>
  );
}

type Tone = 'green' | 'red' | 'yellow' | 'blue' | undefined;
const TONE_CLASS: Record<string, string> = {
  green: 'text-emerald-600',
  red: 'text-destructive',
  yellow: 'text-amber-600',
  blue: 'text-primary',
};
function statusTone(status: BatchStatus): Tone {
  if (status === 'completed') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'cancelled') return 'yellow';
  if (status === 'running') return 'blue';
  return undefined;
}
function SummaryCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: Tone }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-xl font-semibold ${tone ? TONE_CLASS[tone] : ''}`}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function BatchStatusBadge({ status, words }: { status: BatchStatus; words: RegressionWords }) {
  const variant: BadgeProps['variant'] =
    status === 'completed' ? 'default' :
    status === 'failed' ? 'destructive' :
    status === 'cancelled' ? 'destructive' :
    status === 'running' ? 'secondary' :
    'outline';
  return <Badge variant={variant}>{words.status(status)}</Badge>;
}

function ScheduleEditor({
  schedule, canEdit, saving, onSave, onRunNow, runningNow, words,
}: {
  schedule: RegressionSchedule;
  canEdit: boolean;
  saving: boolean;
  onSave: (p: Partial<RegressionSchedule>) => void;
  onRunNow: () => void;
  runningNow: boolean;
  words: RegressionWords;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Partial<RegressionSchedule>>(schedule);
  const set = <K extends keyof RegressionSchedule>(k: K, v: RegressionSchedule[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const merged = { ...schedule, ...draft };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex items-center justify-between rounded border border-border/40 p-3">
          <div>
            <Label className="text-sm" htmlFor="regression-schedule-enabled">{t('aiAgent.adv.regression.schedule.enabled')}</Label>
            <p className="text-xs text-muted-foreground">{t('aiAgent.adv.regression.schedule.enabledHint')}</p>
          </div>
          <Switch id="regression-schedule-enabled" checked={!!merged.enabled} disabled={!canEdit} onCheckedChange={(v) => set('enabled', v)} />
        </div>
        <div>
          <Label htmlFor="regression-schedule-frequency">{t('aiAgent.adv.regression.schedule.frequency')}</Label>
          <Select value={merged.frequency} onValueChange={(v) => set('frequency', v as RegressionSchedule['frequency'])} disabled={!canEdit}>
            <SelectTrigger id="regression-schedule-frequency"><SelectValue /></SelectTrigger>
            <SelectContent>
              {FREQUENCIES.map((f) => <SelectItem key={f} value={f}>{words.frequency(f)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="regression-schedule-time">{t('aiAgent.adv.regression.schedule.timeOfDay')}</Label>
          <Input
            id="regression-schedule-time"
            dir="ltr"
            value={merged.time_of_day || ''}
            placeholder="03:00"
            disabled={!canEdit}
            onChange={(e) => set('time_of_day', e.target.value || null)}
          />
        </div>
        <div>
          <Label htmlFor="regression-schedule-timezone">{t('aiAgent.adv.regression.schedule.timezone')}</Label>
          <Input
            id="regression-schedule-timezone"
            dir="ltr"
            value={merged.timezone || 'UTC'}
            disabled={!canEdit}
            onChange={(e) => set('timezone', e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="regression-schedule-max">{t('aiAgent.adv.regression.schedule.maxCases')}</Label>
          <Input
            id="regression-schedule-max"
            type="number"
            min={1}
            max={100}
            value={merged.max_cases_per_run}
            disabled={!canEdit}
            onChange={(e) => set('max_cases_per_run', parseInt(e.target.value || '0', 10))}
          />
        </div>
        <div className="flex items-center justify-between rounded border border-border/40 p-3">
          <div>
            <Label className="text-sm" htmlFor="regression-schedule-enabled-only">{t('aiAgent.adv.regression.schedule.enabledOnly')}</Label>
            <p className="text-xs text-muted-foreground">{t('aiAgent.adv.regression.schedule.enabledOnlyHint')}</p>
          </div>
          <Switch id="regression-schedule-enabled-only" checked={!!merged.include_enabled_cases_only} disabled={!canEdit}
            onCheckedChange={(v) => set('include_enabled_cases_only', v)} />
        </div>
        <div className="flex items-center justify-between rounded border border-border/40 p-3">
          <div>
            <Label className="text-sm" htmlFor="regression-schedule-call-llm">{t('aiAgent.adv.regression.schedule.callLlm')}</Label>
            <p className="text-xs text-muted-foreground">{t('aiAgent.adv.regression.schedule.callLlmHint')}</p>
          </div>
          <Switch id="regression-schedule-call-llm" checked={!!merged.call_llm} disabled={!canEdit}
            onCheckedChange={(v) => set('call_llm', v)} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!canEdit || saving} onClick={() => onSave(draft)}>
          {saving ? t('aiAgent.adv.regression.schedule.saving') : t('aiAgent.adv.regression.schedule.save')}
        </Button>
        <Button size="sm" variant="outline" disabled={!canEdit || runningNow} onClick={onRunNow}>
          {runningNow ? t('aiAgent.adv.regression.schedule.queuing') : t('aiAgent.adv.regression.schedule.runNow')}
        </Button>
        <ScheduleMeta schedule={schedule} words={words} />
      </div>
    </div>
  );
}

function ScheduleMeta({ schedule, words }: { schedule: RegressionSchedule; words: RegressionWords }) {
  const { t } = useTranslation();
  const meta = (schedule.metadata || {}) as Record<string, unknown>;
  const resolvedTz = (typeof meta.resolved_timezone === 'string' && meta.resolved_timezone) || schedule.timezone || 'UTC';
  const warning = typeof meta.warning === 'string' ? meta.warning : undefined;
  return (
    <div className="flex flex-col text-xs text-muted-foreground gap-0.5">
      <span>
        {t('aiAgent.adv.regression.schedule.lastRun', { date: formatDateTime(schedule.last_run_at) })} · {t('aiAgent.adv.regression.schedule.nextRun')}{' '}
        <span title={schedule.next_run_at ? t('aiAgent.adv.regression.schedule.nextRunUtc', { date: formatDateTime(schedule.next_run_at, UTC_DATE_TIME) }) : ''}>
          {formatDateTime(schedule.next_run_at)}
        </span>
      </span>
      <span>{t('aiAgent.adv.regression.schedule.resolvedTimezone')} <code dir="ltr">{resolvedTz}</code></span>
      {warning && (
        <span className="text-amber-600">
          {t('aiAgent.adv.regression.schedule.warning', { text: words.warning(warning) })}
        </span>
      )}
    </div>
  );
}

function BatchDetailDialog({
  batchId, onClose, wsPath, canManage, onChanged, onOpenChild, words, labels, errorText,
}: {
  batchId: string | null;
  onClose: () => void;
  wsPath: (p: string) => string;
  canManage: boolean;
  onChanged: () => void;
  onOpenChild?: (id: string) => void;
  words: RegressionWords;
  labels: TestRunLabels;
  errorText: (e: unknown) => string;
}) {
  const { t } = useTranslation();
  const failureReason = regressionFailureReason(t, labels);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['ai-agent', 'regression-batch', batchId],
    queryFn: () => aiAgentApi.getRegressionBatch(batchId!),
    enabled: !!batchId,
    refetchInterval: 5_000,
  });
  const cancelMut = useMutation({
    mutationFn: () => aiAgentApi.cancelRegressionBatch(batchId!),
    onSuccess: (r) => {
      toast({
        title: r.idempotent
          ? t('aiAgent.adv.regression.toast.alreadyStatus', { status: words.status(r.status) })
          : t('aiAgent.adv.regression.toast.cancelled'),
      });
      qc.invalidateQueries({ queryKey: ['ai-agent', 'regression-batch', batchId] });
      onChanged();
    },
    onError: (e: unknown) => toast({ title: t('aiAgent.adv.regression.toast.cancelFailed'), description: errorText(e), variant: 'destructive' }),
  });
  const retryMut = useMutation({
    mutationFn: () => aiAgentApi.retryFailedRegressionBatch(batchId!),
    onSuccess: () => {
      toast({ title: t('aiAgent.adv.regression.toast.retryQueued') });
      onChanged();
      onClose();
    },
    onError: (e: unknown) => toast({
      title: t('aiAgent.adv.regression.toast.retryFailed'),
      description: errorText(e),
      variant: 'destructive',
    }),
  });
  const suggestMut = useMutation({
    mutationFn: (runId: string) => aiAgentApi.suggestTestCaseFromTestRun(runId),
    onSuccess: () => toast({ title: t('aiAgent.adv.regression.toast.suggestedTitle'), description: t('aiAgent.adv.regression.toast.suggestedDesc') }),
    onError: (e: unknown) => toast({
      title: t('aiAgent.adv.regression.toast.suggestFailed'),
      description: errorText(e),
      variant: 'destructive',
    }),
  });
  return (
    <Dialog open={!!batchId} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t('aiAgent.adv.regression.batch.title')}</DialogTitle></DialogHeader>
        {q.isLoading || !q.data ? (
          <div className="text-sm text-muted-foreground">{t('aiAgent.adv.regression.loading')}</div>
        ) : (() => {
          const batch = q.data.batch;
          const meta = (batch.metadata || {}) as Record<string, unknown>;
          const idx = typeof meta.current_case_index === 'number' ? meta.current_case_index : 0;
          const total = batch.total_cases || 0;
          const isActive = batch.status === 'queued' || batch.status === 'running';
          const hasFailures = batch.status === 'completed' && (batch.failed + batch.errored) > 0;
          const durationMs = typeof meta.duration_ms === 'number' ? meta.duration_ms : null;
          const avgMs = typeof meta.avg_case_duration_ms === 'number' ? meta.avg_case_duration_ms : null;
          const cancelledAt = typeof meta.cancelled_at === 'string' ? meta.cancelled_at : null;
          const retryOf = meta.retry_of_batch_id ? String(meta.retry_of_batch_id) : null;
          const currentName = meta.current_test_case_name ? String(meta.current_test_case_name) : '';
          const retryChildren = Array.isArray(q.data.retryChildren) ? q.data.retryChildren : [];
          return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
              <div><div className="text-xs text-muted-foreground">{t('aiAgent.adv.regression.history.cols.status')}</div><BatchStatusBadge status={q.data.batch.status} words={words} /></div>
              <div><div className="text-xs text-muted-foreground">{t('aiAgent.adv.regression.history.cols.total')}</div>{q.data.summary.total}</div>
              <div><div className="text-xs text-muted-foreground">{t('aiAgent.adv.regression.history.cols.passed')}</div><span className="text-emerald-600">{q.data.summary.passed}</span></div>
              <div><div className="text-xs text-muted-foreground">{t('aiAgent.adv.regression.history.cols.failed')}</div><span className="text-destructive">{q.data.summary.failed}</span></div>
              <div><div className="text-xs text-muted-foreground">{t('aiAgent.adv.regression.history.cols.errored')}</div><span className="text-amber-600">{q.data.summary.errored}</span></div>
            </div>
            {isActive && total > 0 && (
              <div className="space-y-1">
                <Progress value={(idx / total) * 100} />
                <div className="text-xs text-muted-foreground">
                  {t('aiAgent.adv.regression.batch.processed', { done: idx, total })}
                  {currentName ? <> · {t('aiAgent.adv.regression.batch.current', { name: isolate(labels.caseName(currentName)) })}</> : null}
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>{t('aiAgent.adv.regression.batch.duration', { value: words.duration(durationMs) })}</span>
              <span>{t('aiAgent.adv.regression.batch.avgPerCase', { value: words.duration(avgMs) })}</span>
              {cancelledAt && <span>{t('aiAgent.adv.regression.batch.cancelledAt', { date: formatDateTime(cancelledAt) })}</span>}
              {retryOf && <span>{t('aiAgent.adv.regression.batch.retryOf')} <code className="text-[10px]" dir="ltr">{retryOf.slice(0, 8)}</code></span>}
            </div>
            <div className="flex flex-wrap gap-2">
              {isActive && canManage && (
                <Button size="sm" variant="destructive" disabled={cancelMut.isPending}
                  onClick={() => cancelMut.mutate()}>
                  {cancelMut.isPending ? t('aiAgent.adv.regression.batch.cancelling') : t('aiAgent.adv.regression.batch.cancel')}
                </Button>
              )}
              {hasFailures && canManage && (
                <Button size="sm" variant="outline" disabled={retryMut.isPending}
                  onClick={() => retryMut.mutate()}>
                  {retryMut.isPending ? t('aiAgent.adv.regression.batch.retrying') : t('aiAgent.adv.regression.batch.retry')}
                </Button>
              )}
              <a href={aiAgentApi.regressionBatchCsvUrl(batch.id)} target="_blank" rel="noreferrer">
                <Button size="sm" variant="outline">
                  <Download className="h-3 w-3 me-1" /> {t('aiAgent.adv.regression.batch.exportCsv')}
                </Button>
              </a>
            </div>
            {retryChildren.length > 0 && (
              <div className="rounded border border-border/40 p-2 text-xs">
                <div className="font-medium mb-1">{t('aiAgent.adv.regression.batch.retryChildren')}</div>
                <ul className="space-y-1">
                  {retryChildren.map((c) => (
                    <li key={c.id} className="flex items-center gap-2">
                      <BatchStatusBadge status={c.status} words={words} />
                      <span className="text-muted-foreground">{formatDateTime(c.created_at)}</span>
                      <span>{t('aiAgent.adv.regression.batch.childCounts', { passed: c.passed, failed: c.failed, errored: c.errored })}</span>
                      <Button
                        size="sm" variant="ghost" className="ms-auto h-6"
                        onClick={() => onOpenChild?.(c.id)}
                      >
                        {t('aiAgent.adv.regression.batch.open')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr className="text-start text-muted-foreground border-b border-border/40">
                    <th className="py-2 pe-2 text-start">{t('aiAgent.adv.regression.batch.cols.status')}</th>
                    <th className="py-2 pe-2 text-start">{t('aiAgent.adv.regression.batch.cols.test')}</th>
                    <th className="py-2 pe-2 text-start">{t('aiAgent.adv.regression.batch.cols.compare')}</th>
                    <th className="py-2 pe-2 text-start">{t('aiAgent.adv.regression.batch.cols.failureReasons')}</th>
                    <th className="py-2 pe-2 text-start">{t('aiAgent.adv.regression.batch.cols.sources')}</th>
                    <th className="py-2 pe-2"><span className="sr-only">{t('aiAgent.adv.regression.batch.cols.actions')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {(q.data.runs as BatchRun[]).map((r) => {
                    const selected: Array<{ source_type?: unknown } | null> = Array.isArray(r.selected_sources) ? r.selected_sources : [];
                    const sourceTypes = Array.from(new Set(
                      selected.map((s) => (typeof s?.source_type === 'string' ? s.source_type : '')).filter(Boolean),
                    ));
                    const canSuggest = r.status === 'failed' || r.status === 'errored';
                    const tc: NonNullable<BatchRun['test_case']> = r.test_case || {};
                    const runMeta = (r.metadata || {}) as Record<string, unknown>;
                    const aiRunId = r.ai_agent_run_id || (typeof runMeta.ai_agent_run_id === 'string' ? runMeta.ai_agent_run_id : null) || null;
                    const params = new URLSearchParams({
                      message: r.input_message || '',
                      locale: tc.locale || '',
                    });
                    const reasons = r.failure_reasons || [];
                    return (
                      <tr key={r.id} className="border-b border-border/30 align-top">
                        <td className="py-1 pe-2"><Badge variant={r.status === 'passed' ? 'default' : r.status === 'failed' ? 'destructive' : 'secondary'}>{labels.status(r.status)}</Badge></td>
                        <td className="py-1 pe-2 max-w-[260px]">
                          {tc.name && <div className="font-medium truncate" title={labels.caseName(tc.name)} dir="auto">{labels.caseName(tc.name)}</div>}
                          <div className="text-muted-foreground truncate" title={r.input_message} dir="auto">{r.input_message}</div>
                        </td>
                        <td className="py-1 pe-2 max-w-[200px] text-[11px]">
                          <div><span className="text-muted-foreground">{t('aiAgent.adv.regression.batch.expected')}</span> <span>{tc.expected_behavior ? labels.behavior(tc.expected_behavior) : '—'}</span></div>
                          <div><span className="text-muted-foreground">{t('aiAgent.adv.regression.batch.actual')}</span> <span>{r.actual_status ? labels.actualStatus(r.actual_status) : '—'}</span></div>
                        </td>
                        <td className="py-1 pe-2 max-w-[260px]">
                          <div className="flex flex-wrap gap-1">
                            {reasons.slice(0, 4).map((reason, i) => (
                              <Badge key={i} variant="outline" className="text-[10px]">{failureReason(reason)}</Badge>
                            ))}
                            {!reasons.length && <span className="text-muted-foreground">—</span>}
                          </div>
                        </td>
                        <td className="py-1 pe-2">{sourceTypes.length ? labels.list(sourceTypes.map((s) => labels.sourceType(s))) : '—'}</td>
                        <td className="py-1 pe-2 whitespace-nowrap space-x-2 rtl:space-x-reverse">
                          <Link className="text-primary hover:underline" to={wsPath(`/ai-agent/test-runs/${r.id}`)}>{t('aiAgent.adv.regression.batch.links.detail')}</Link>
                          <Link className="text-primary hover:underline" to={wsPath(`/ai-agent/debug/retrieval?${params.toString()}`)}>{t('aiAgent.adv.regression.batch.links.retrieval')}</Link>
                          {aiRunId && (
                            <Link className="text-primary hover:underline" to={wsPath(`/ai-agent/runs/${aiRunId}`)}>{t('aiAgent.adv.regression.batch.links.inspector')}</Link>
                          )}
                          {canSuggest && canManage && (
                            <Button size="sm" variant="outline" disabled={suggestMut.isPending}
                              onClick={() => suggestMut.mutate(r.id)}>
                              {t('aiAgent.adv.regression.batch.suggest')}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          );
        })()}
      </DialogContent>
    </Dialog>
  );
}
