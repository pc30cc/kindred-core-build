import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { aiAgentApi, type RegressionSchedule, type RegressionBatch } from '@/lib/ai-agent-api';
import { useWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';

function fmtDate(d: string | null | undefined) {
  return d ? new Date(d).toLocaleString() : '—';
}
function pct(n: number | null | undefined) {
  return n == null ? '—' : `${Math.round(n * 100)}%`;
}

export default function RegressionRunsPage() {
  const ws = useWorkspace();
  const wsId = ws?.id;
  const wsPath = useWorkspacePath();
  const { isOwnerOrAdmin } = useWorkspaceRole(wsId);
  const qc = useQueryClient();
  const [openBatch, setOpenBatch] = useState<string | null>(null);

  const schedulesQ = useQuery({
    queryKey: ['ai-agent', 'regression-schedules', wsId],
    queryFn: () => aiAgentApi.listRegressionSchedules(wsId!),
    enabled: !!wsId,
  });
  const batchesQ = useQuery({
    queryKey: ['ai-agent', 'regression-batches', wsId],
    queryFn: () => aiAgentApi.listRegressionBatches(wsId!, 50),
    enabled: !!wsId,
    refetchInterval: 10_000,
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
  const latest = batches[0];
  const last24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return batches.filter((b) => new Date(b.created_at).getTime() >= cutoff);
  }, [batches]);
  const last7d = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return batches.filter((b) => new Date(b.created_at).getTime() >= cutoff);
  }, [batches]);

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

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <SummaryCard label="Latest pass rate" value={pct(latest?.pass_rate ?? null)} />
        <SummaryCard label="Latest result" value={latest ? `${latest.passed}/${latest.total_cases}` : '—'} sub={latest ? `${latest.failed} failed · ${latest.errored} errored` : undefined} />
        <SummaryCard label="Last run" value={fmtDate(latest?.finished_at || latest?.started_at || latest?.created_at)} />
        <SummaryCard label="Next run" value={fmtDate(schedule?.next_run_at)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <SummaryCard label="Last 24h batches" value={String(last24h.length)} sub={`${last24h.reduce((a,b)=>a+b.passed,0)} passed · ${last24h.reduce((a,b)=>a+b.failed,0)} failed`} />
        <SummaryCard label="Last 7d batches" value={String(last7d.length)} sub={`${last7d.reduce((a,b)=>a+b.passed,0)} passed · ${last7d.reduce((a,b)=>a+b.failed,0)} failed`} />
      </div>

      <Card>
        <CardHeader><CardTitle>Batch history</CardTitle></CardHeader>
        <CardContent>
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
                  {batches.map((b) => (
                    <tr key={b.id} className="border-b border-border/30">
                      <td className="py-1 pr-2"><BatchStatusBadge status={b.status} /></td>
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
                  ))}
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
      />
    </div>
  );
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function BatchStatusBadge({ status }: { status: RegressionBatch['status'] }) {
  const variant: any =
    status === 'completed' ? 'default' :
    status === 'failed' ? 'destructive' :
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
        <span className="text-xs text-muted-foreground">
          Last run: {fmtDate(schedule.last_run_at)} · Next run: {fmtDate(schedule.next_run_at)}
        </span>
      </div>
    </div>
  );
}

function BatchDetailDialog({
  batchId, onClose, wsPath,
}: { batchId: string | null; onClose: () => void; wsPath: (p: string) => string }) {
  const q = useQuery({
    queryKey: ['ai-agent', 'regression-batch', batchId],
    queryFn: () => aiAgentApi.getRegressionBatch(batchId!),
    enabled: !!batchId,
    refetchInterval: 5_000,
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
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
              <div><div className="text-xs text-muted-foreground">Status</div><BatchStatusBadge status={q.data.batch.status} /></div>
              <div><div className="text-xs text-muted-foreground">Total</div>{q.data.summary.total}</div>
              <div><div className="text-xs text-muted-foreground">Passed</div><span className="text-emerald-600">{q.data.summary.passed}</span></div>
              <div><div className="text-xs text-muted-foreground">Failed</div><span className="text-destructive">{q.data.summary.failed}</span></div>
              <div><div className="text-xs text-muted-foreground">Errored</div><span className="text-amber-600">{q.data.summary.errored}</span></div>
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
        )}
      </DialogContent>
    </Dialog>
  );
}