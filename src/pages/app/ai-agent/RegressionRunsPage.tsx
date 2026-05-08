import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { aiAgentApi, type RegressionSchedule, type RegressionBatch } from '@/lib/ai-agent-api';
import { useCurrentWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useWorkspaceRole, isWorkspaceAdmin } from '@/hooks/useWorkspaceRole';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { toast } from '@/hooks/use-toast';
import { Download } from 'lucide-react';

function fmtDate(d: string | null | undefined) {
  return d ? new Date(d).toLocaleString() : '—';
}
function pct(n: number | null | undefined) {
  return n == null ? '—' : `${Math.round(n * 100)}%`;
}
function fmtDuration(ms: number | null | undefined) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60), mm = m % 60;
  return `${h}h ${mm}m`;
}

export default function RegressionRunsPage() {
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
      status: filters.status !== 'all' ? (filters.status as any) : null,
      triggerType: filters.triggerType !== 'all' ? (filters.triggerType as any) : null,
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
      toast({ title: 'Schedule saved' });
      qc.invalidateQueries({ queryKey: ['ai-agent', 'regression-schedules', wsId] });
    },
    onError: (e: any) => toast({ title: 'Save failed', description: e?.message, variant: 'destructive' }),
  });

  const runNowMut = useMutation({
    mutationFn: () => aiAgentApi.runRegressionNow(wsId!, schedule?.id || null),
    onSuccess: () => {
      toast({ title: 'Batch queued', description: 'The regression worker will run it shortly.' });
      qc.invalidateQueries({ queryKey: ['ai-agent', 'regression-batches', wsId] });
    },
    onError: (e: any) => toast({ title: 'Could not enqueue', description: e?.message, variant: 'destructive' }),
  });

  const batches = batchesQ.data?.items || [];
  const overview = overviewQ.data;
  const schedules = schedulesQ.data?.items || [];

  if (!wsId) return <div className="p-6 text-muted-foreground">Loading workspace…</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Regression Runs</h1>
        <p className="text-sm text-muted-foreground">
          Schedule automated re-runs of your AI test cases. Runs are dry-run only — no visitor messages, handoffs, or workflows are triggered.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>Schedule</CardTitle></CardHeader>
        <CardContent>
          {!schedule ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">No schedule configured yet.</p>
              <Button
                size="sm"
                disabled={!isOwnerOrAdmin || ensureMut.isPending}
                onClick={() => ensureMut.mutate()}
              >
                {ensureMut.isPending ? 'Creating…' : 'Create default schedule'}
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
            />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <SummaryCard
          label="Enabled schedules"
          value={`${overview?.enabled_schedules ?? 0}/${overview?.total_schedules ?? 0}`}
        />
        <SummaryCard
          label="Next run"
          value={fmtDate(overview?.next_due_schedule?.next_run_at || schedule?.next_run_at)}
          sub={overview?.next_due_schedule?.timezone}
        />
        <SummaryCard
          label="Last 24h pass rate"
          value={pct(overview?.last_24h_pass_rate ?? null)}
          sub={`${overview?.last_24h_batches ?? 0} batches`}
        />
        <SummaryCard
          label="Failed batches (7d)"
          value={String(overview?.failed_batches_count ?? 0)}
          sub={`${overview?.errored_runs_count ?? 0} errored runs`}
          tone={overview && overview.failed_batches_count > 0 ? 'red' : 'green'}
        />
        <SummaryCard
          label="Last batch"
          value={overview?.last_batch ? overview.last_batch.status : '—'}
          sub={overview?.last_batch ? `${overview.last_batch.passed}/${overview.last_batch.total_cases} passed` : undefined}
          tone={overview?.last_batch ? statusTone(overview.last_batch.status) : undefined}
        />
      </div>

      {overview && overview.top_failure_reasons.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Top failure reasons (7d)</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {overview.top_failure_reasons.map((r) => (
                <Badge key={r.reason} variant="outline" className="text-xs">
                  <span className="font-mono mr-1">{r.reason}</span>
                  <span className="text-muted-foreground">×{r.count}</span>
                </Badge>
              ))}
            </div>
            {overview.coverage_by_source_type.length > 0 && (
              <div className="mt-3 text-xs text-muted-foreground">
                Coverage by source type:{' '}
                {overview.coverage_by_source_type.map((c) => `${c.source_type} (${c.runs})`).join(' · ')}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Batch history</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-3">
            <div>
              <Label className="text-xs">Status</Label>
              <Select value={filters.status} onValueChange={(v) => setFilters((f) => ({ ...f, status: v }))}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="queued">Queued</SelectItem>
                  <SelectItem value="running">Running</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Trigger</Label>
              <Select value={filters.triggerType} onValueChange={(v) => setFilters((f) => ({ ...f, triggerType: v }))}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="scheduled">Scheduled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Schedule</Label>
              <Select value={filters.scheduleId} onValueChange={(v) => setFilters((f) => ({ ...f, scheduleId: v }))}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {schedules.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">From</Label>
              <Input type="date" className="h-8" value={filters.dateFrom}
                onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))} />
            </div>
            <div>
              <Label className="text-xs">To</Label>
              <Input type="date" className="h-8" value={filters.dateTo}
                onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))} />
            </div>
            <div className="flex items-end gap-2">
              <div className="flex items-center gap-2">
                <Switch checked={filters.onlyFailed}
                  onCheckedChange={(v) => setFilters((f) => ({ ...f, onlyFailed: v }))} />
                <Label className="text-xs">Only failed</Label>
              </div>
              <Button size="sm" variant="ghost" className="h-8"
                onClick={() => setFilters({ status: 'all', triggerType: 'all', scheduleId: 'all', dateFrom: '', dateTo: '', onlyFailed: false })}>
                Reset
              </Button>
            </div>
          </div>
          {batchesQ.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : !batches.length ? (
            <div className="text-sm text-muted-foreground">No batches yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border/40">
                    <th className="py-2 pr-2">Status</th>
                    <th className="py-2 pr-2">Trigger</th>
                    <th className="py-2 pr-2">Total</th>
                    <th className="py-2 pr-2">Passed</th>
                    <th className="py-2 pr-2">Failed</th>
                    <th className="py-2 pr-2">Errored</th>
                    <th className="py-2 pr-2">Pass rate</th>
                    <th className="py-2 pr-2">Started</th>
                    <th className="py-2 pr-2">Finished</th>
                    <th className="py-2 pr-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => {
                    const meta = (b.metadata || {}) as Record<string, any>;
                    const idx = typeof meta.current_case_index === 'number' ? meta.current_case_index : 0;
                    const total = b.total_cases || 0;
                    const showProgress = b.status === 'running' || b.status === 'queued';
                    return (
                      <tr key={b.id} className="border-b border-border/30">
                        <td className="py-1 pr-2">
                          <BatchStatusBadge status={b.status} />
                          {showProgress && total > 0 && (
                            <div className="mt-1 w-32">
                              <Progress value={(idx / total) * 100} className="h-1" />
                              <div className="text-[10px] text-muted-foreground">{idx}/{total}</div>
                            </div>
                          )}
                        </td>
                        <td className="py-1 pr-2"><Badge variant="outline">{b.trigger_type}</Badge></td>
                        <td className="py-1 pr-2">{b.total_cases}</td>
                        <td className="py-1 pr-2 text-emerald-600">{b.passed}</td>
                        <td className="py-1 pr-2 text-destructive">{b.failed}</td>
                        <td className="py-1 pr-2 text-amber-600">{b.errored}</td>
                        <td className="py-1 pr-2">{pct(b.pass_rate)}</td>
                        <td className="py-1 pr-2">{fmtDate(b.started_at)}</td>
                        <td className="py-1 pr-2">{fmtDate(b.finished_at)}</td>
                        <td className="py-1 pr-2">
                          <Button size="sm" variant="ghost" onClick={() => setOpenBatch(b.id)}>Open</Button>
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
function statusTone(status: RegressionBatch['status']): Tone {
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

function BatchStatusBadge({ status }: { status: RegressionBatch['status'] }) {
  const variant: any =
    status === 'completed' ? 'default' :
    status === 'failed' ? 'destructive' :
    status === 'cancelled' ? 'destructive' :
    status === 'running' ? 'secondary' :
    'outline';
  return <Badge variant={variant}>{status}</Badge>;
}

function ScheduleEditor({
  schedule, canEdit, saving, onSave, onRunNow, runningNow,
}: {
  schedule: RegressionSchedule;
  canEdit: boolean;
  saving: boolean;
  onSave: (p: Partial<RegressionSchedule>) => void;
  onRunNow: () => void;
  runningNow: boolean;
}) {
  const [draft, setDraft] = useState<Partial<RegressionSchedule>>(schedule);
  const set = (k: keyof RegressionSchedule, v: any) => setDraft((d) => ({ ...d, [k]: v }));
  const merged = { ...schedule, ...draft };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex items-center justify-between rounded border border-border/40 p-3">
          <div>
            <Label className="text-sm">Enabled</Label>
            <p className="text-xs text-muted-foreground">Worker will run this schedule automatically.</p>
          </div>
          <Switch checked={!!merged.enabled} disabled={!canEdit} onCheckedChange={(v) => set('enabled', v)} />
        </div>
        <div>
          <Label>Frequency</Label>
          <Select value={merged.frequency} onValueChange={(v) => set('frequency', v)} disabled={!canEdit}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="hourly">Hourly</SelectItem>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="manual">Manual only</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Time of day (HH:mm)</Label>
          <Input
            value={merged.time_of_day || ''}
            placeholder="03:00"
            disabled={!canEdit}
            onChange={(e) => set('time_of_day', e.target.value || null)}
          />
        </div>
        <div>
          <Label>Timezone</Label>
          <Input
            value={merged.timezone || 'UTC'}
            disabled={!canEdit}
            onChange={(e) => set('timezone', e.target.value)}
          />
        </div>
        <div>
          <Label>Max cases per run (≤ 100)</Label>
          <Input
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
            <Label className="text-sm">Enabled cases only</Label>
            <p className="text-xs text-muted-foreground">Skip disabled test cases.</p>
          </div>
          <Switch checked={!!merged.include_enabled_cases_only} disabled={!canEdit}
            onCheckedChange={(v) => set('include_enabled_cases_only', v)} />
        </div>
        <div className="flex items-center justify-between rounded border border-border/40 p-3">
          <div>
            <Label className="text-sm">Call LLM</Label>
            <p className="text-xs text-muted-foreground">Off uses retrieval/strategy only (cheaper).</p>
          </div>
          <Switch checked={!!merged.call_llm} disabled={!canEdit}
            onCheckedChange={(v) => set('call_llm', v)} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!canEdit || saving} onClick={() => onSave(draft)}>
          {saving ? 'Saving…' : 'Save schedule'}
        </Button>
        <Button size="sm" variant="outline" disabled={!canEdit || runningNow} onClick={onRunNow}>
          {runningNow ? 'Queuing…' : 'Run now'}
        </Button>
        <ScheduleMeta schedule={schedule} />
      </div>
    </div>
  );
}

function ScheduleMeta({ schedule }: { schedule: RegressionSchedule }) {
  const meta = (schedule.metadata || {}) as Record<string, any>;
  const resolvedTz = meta.resolved_timezone || schedule.timezone || 'UTC';
  const warning = meta.warning as string | undefined;
  return (
    <div className="flex flex-col text-xs text-muted-foreground gap-0.5">
      <span>
        Last run: {fmtDate(schedule.last_run_at)} · Next run:{' '}
        <span title={schedule.next_run_at ? `UTC: ${schedule.next_run_at}` : ''}>
          {fmtDate(schedule.next_run_at)}
        </span>
      </span>
      <span>Resolved timezone: <code>{resolvedTz}</code></span>
      {warning && (
        <span className="text-amber-600">
          Warning: {warning === 'timezone_invalid_fallback_utc'
            ? 'Timezone invalid — falling back.'
            : warning === 'time_of_day_invalid_interval_fallback'
              ? 'Time-of-day invalid — using interval math.'
              : warning}
        </span>
      )}
    </div>
  );
}

function BatchDetailDialog({
  batchId, onClose, wsPath, canManage, onChanged,
}: { batchId: string | null; onClose: () => void; wsPath: (p: string) => string; canManage: boolean; onChanged: () => void }) {
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
      toast({ title: r.idempotent ? `Already ${r.status}` : 'Batch cancelled' });
      qc.invalidateQueries({ queryKey: ['ai-agent', 'regression-batch', batchId] });
      onChanged();
    },
    onError: (e: any) => toast({ title: 'Cancel failed', description: e?.message, variant: 'destructive' }),
  });
  const retryMut = useMutation({
    mutationFn: () => aiAgentApi.retryFailedRegressionBatch(batchId!),
    onSuccess: () => {
      toast({ title: 'Retry batch queued' });
      onChanged();
      onClose();
    },
    onError: (e: any) => toast({
      title: 'Retry failed',
      description: e?.message?.includes('no_failed_cases') ? 'No failed/errored cases to retry.' : (e?.message || 'Failed'),
      variant: 'destructive',
    }),
  });
  const suggestMut = useMutation({
    mutationFn: (runId: string) => aiAgentApi.suggestTestCaseFromTestRun(runId),
    onSuccess: () => toast({ title: 'Suggested test created', description: 'Open Suggested Tests to review.' }),
    onError: (e: any) => toast({
      title: 'Could not create suggestion',
      description: e?.message?.includes('duplicate') ? 'A suggestion for this run already exists.' : (e?.message || 'Failed'),
      variant: 'destructive',
    }),
  });
  return (
    <Dialog open={!!batchId} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Regression batch</DialogTitle></DialogHeader>
        {q.isLoading || !q.data ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (() => {
          const batch = q.data.batch;
          const meta = (batch.metadata || {}) as Record<string, any>;
          const idx = typeof meta.current_case_index === 'number' ? meta.current_case_index : 0;
          const total = batch.total_cases || 0;
          const isActive = batch.status === 'queued' || batch.status === 'running';
          const hasFailures = batch.status === 'completed' && (batch.failed + batch.errored) > 0;
          return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
              <div><div className="text-xs text-muted-foreground">Status</div><BatchStatusBadge status={q.data.batch.status} /></div>
              <div><div className="text-xs text-muted-foreground">Total</div>{q.data.summary.total}</div>
              <div><div className="text-xs text-muted-foreground">Passed</div><span className="text-emerald-600">{q.data.summary.passed}</span></div>
              <div><div className="text-xs text-muted-foreground">Failed</div><span className="text-destructive">{q.data.summary.failed}</span></div>
              <div><div className="text-xs text-muted-foreground">Errored</div><span className="text-amber-600">{q.data.summary.errored}</span></div>
            </div>
            {isActive && total > 0 && (
              <div className="space-y-1">
                <Progress value={(idx / total) * 100} />
                <div className="text-xs text-muted-foreground">
                  Processed {idx} / {total}
                  {meta.current_test_case_name ? ` · current: ${meta.current_test_case_name}` : ''}
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>Duration: {fmtDuration(meta.duration_ms)}</span>
              <span>Avg/case: {fmtDuration(meta.avg_case_duration_ms)}</span>
              {meta.cancelled_at && <span>Cancelled: {fmtDate(meta.cancelled_at)}</span>}
              {meta.retry_of_batch_id && <span>Retry of: <code className="text-[10px]">{String(meta.retry_of_batch_id).slice(0,8)}</code></span>}
            </div>
            <div className="flex flex-wrap gap-2">
              {isActive && canManage && (
                <Button size="sm" variant="destructive" disabled={cancelMut.isPending}
                  onClick={() => cancelMut.mutate()}>
                  {cancelMut.isPending ? 'Cancelling…' : 'Cancel batch'}
                </Button>
              )}
              {hasFailures && canManage && (
                <Button size="sm" variant="outline" disabled={retryMut.isPending}
                  onClick={() => retryMut.mutate()}>
                  {retryMut.isPending ? 'Queuing…' : 'Retry failed'}
                </Button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border/40">
                    <th className="py-2 pr-2">Status</th>
                    <th className="py-2 pr-2">Input</th>
                    <th className="py-2 pr-2">Failure reasons</th>
                    <th className="py-2 pr-2">Sources</th>
                    <th className="py-2 pr-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.runs.map((r: any) => {
                    const sourceTypes = Array.from(new Set((r.selected_sources || []).map((s: any) => s.source_type)));
                    const canSuggest = r.status === 'failed' || r.status === 'errored';
                    return (
                      <tr key={r.id} className="border-b border-border/30 align-top">
                        <td className="py-1 pr-2"><Badge variant={r.status === 'passed' ? 'default' : r.status === 'failed' ? 'destructive' : 'secondary'}>{r.status}</Badge></td>
                        <td className="py-1 pr-2 max-w-[280px] truncate" title={r.input_message}>{r.input_message}</td>
                        <td className="py-1 pr-2 max-w-[260px]">{(r.failure_reasons || []).slice(0, 3).join(', ') || '—'}</td>
                        <td className="py-1 pr-2">{sourceTypes.join(', ') || '—'}</td>
                        <td className="py-1 pr-2 whitespace-nowrap">
                          <Link className="text-primary hover:underline mr-2" to={wsPath(`/ai-agent/test-runs/${r.id}`)}>Detail</Link>
                          {canSuggest && (
                            <Button size="sm" variant="outline" disabled={suggestMut.isPending}
                              onClick={() => suggestMut.mutate(r.id)}>
                              Suggest test
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