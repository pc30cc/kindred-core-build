import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { aiAgentApi, type TestCase, type TestRun } from '@/lib/ai-agent-api';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/hooks/use-toast';
import { Play, Plus, Trash2, Pencil, Sparkles, ChevronDown, ChevronRight } from 'lucide-react';

const BEHAVIORS = ['answer','no_answer','handoff','clarification'] as const;
const SOURCE_TYPES = ['','qna','learned_qna','kb_article','web_page','file','business_profile'] as const;

interface FormState {
  id?: string;
  name: string;
  input_message: string;
  locale: string;
  expected_behavior: typeof BEHAVIORS[number];
  expected_source_type: string;
  expected_source_url: string;
  expected_source_id: string;
  expected_contains: string;
  expected_not_contains: string;
  min_confidence: string;
  enabled: boolean;
  page_currentPageUrl: string;
  page_currentPagePath: string;
  page_currentPageTitle: string;
}

const emptyForm: FormState = {
  name: '', input_message: '', locale: '',
  expected_behavior: 'answer', expected_source_type: '',
  expected_source_url: '', expected_source_id: '',
  expected_contains: '', expected_not_contains: '',
  min_confidence: '', enabled: true,
  page_currentPageUrl: '', page_currentPagePath: '', page_currentPageTitle: '',
};

function formFromCase(c: TestCase): FormState {
  const pc = (c.page_context || {}) as any;
  return {
    id: c.id,
    name: c.name, input_message: c.input_message, locale: c.locale || '',
    expected_behavior: c.expected_behavior,
    expected_source_type: c.expected_source_type || '',
    expected_source_url: c.expected_source_url || '',
    expected_source_id: c.expected_source_id || '',
    expected_contains: (c.expected_contains || []).join('\n'),
    expected_not_contains: (c.expected_not_contains || []).join('\n'),
    min_confidence: c.min_confidence != null ? String(c.min_confidence) : '',
    enabled: c.enabled,
    page_currentPageUrl: pc.currentPageUrl || '',
    page_currentPagePath: pc.currentPagePath || '',
    page_currentPageTitle: pc.currentPageTitle || '',
  };
}

function formToPayload(f: FormState) {
  const splitLines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const pc: any = {};
  if (f.page_currentPageUrl) pc.currentPageUrl = f.page_currentPageUrl;
  if (f.page_currentPagePath) pc.currentPagePath = f.page_currentPagePath;
  if (f.page_currentPageTitle) pc.currentPageTitle = f.page_currentPageTitle;
  return {
    name: f.name,
    input_message: f.input_message,
    locale: f.locale || null,
    page_context: Object.keys(pc).length ? pc : null,
    expected_behavior: f.expected_behavior,
    expected_source_type: f.expected_source_type || null,
    expected_source_url: f.expected_source_url || null,
    expected_source_id: f.expected_source_id || null,
    expected_contains: splitLines(f.expected_contains),
    expected_not_contains: splitLines(f.expected_not_contains),
    min_confidence: f.min_confidence ? Number(f.min_confidence) : null,
    enabled: f.enabled,
  };
}

function StatusBadge({ s }: { s?: string }) {
  if (!s) return <Badge variant="outline">—</Badge>;
  const v = s === 'passed' ? 'default' : s === 'failed' ? 'destructive' : 'secondary';
  return <Badge variant={v as any}>{s}</Badge>;
}

export default function TestCasesPage() {
  const { workspace } = useActiveWorkspace();
  const wsPath = useWorkspacePath();
  const wsId = workspace?.id;
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const casesQ = useQuery({
    queryKey: ['ai-agent', 'test-cases', wsId],
    queryFn: () => (aiAgentApi as any).listTestCases(wsId!),
    enabled: !!wsId,
  });
  const runsQ = useQuery({
    queryKey: ['ai-agent', 'test-runs', wsId],
    queryFn: () => (aiAgentApi as any).listTestRuns(wsId!),
    enabled: !!wsId,
  });
  const summaryQ = useQuery({
    queryKey: ['ai-agent', 'test-summary', wsId],
    queryFn: () => (aiAgentApi as any).getTestSummary(wsId!),
    enabled: !!wsId,
  });

  const latestByCase = useMemo(() => {
    const map = new Map<string, TestRun>();
    for (const r of runsQ.data?.items || []) {
      if (r.test_case_id && !map.has(r.test_case_id)) map.set(r.test_case_id, r);
    }
    return map;
  }, [runsQ.data]);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['ai-agent', 'test-cases', wsId] });
    qc.invalidateQueries({ queryKey: ['ai-agent', 'test-runs', wsId] });
    qc.invalidateQueries({ queryKey: ['ai-agent', 'test-summary', wsId] });
  };

  const saveMut = useMutation({
    mutationFn: async (f: FormState) => {
      if (f.id) return (aiAgentApi as any).updateTestCase(f.id, formToPayload(f));
      return (aiAgentApi as any).createTestCase(wsId!, formToPayload(f));
    },
    onSuccess: () => { setForm(null); invalidateAll(); toast({ title: 'Saved' }); },
    onError: (e: any) => toast({ title: 'Save failed', description: e?.message, variant: 'destructive' }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => (aiAgentApi as any).deleteTestCase(id),
    onSuccess: () => { invalidateAll(); toast({ title: 'Deleted' }); },
  });
  const runMut = useMutation({
    mutationFn: (id: string) => (aiAgentApi as any).runTestCase(id),
    onSuccess: (data: any) => {
      invalidateAll();
      toast({
        title: data.run?.status === 'passed' ? 'Test passed' : `Test ${data.run?.status}`,
        description: (data.run?.failure_reasons || []).join(', ') || undefined,
        variant: data.run?.status === 'passed' ? 'default' : 'destructive',
      });
    },
  });
  const bulkMut = useMutation({
    mutationFn: () => (aiAgentApi as any).runBulkTests(wsId!),
    onSuccess: (s: any) => {
      invalidateAll();
      toast({ title: `Bulk: ${s.passed}/${s.total} passed`, description: `${s.failed} failed, ${s.errored} errored` });
    },
  });
  const seedMut = useMutation({
    mutationFn: () => (aiAgentApi as any).seedRecommendedTests(wsId!),
    onSuccess: (r: any) => { invalidateAll(); toast({ title: `Seeded ${r.inserted}`, description: `Skipped ${r.skipped} duplicates.` }); },
  });

  const summary = summaryQ.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Test Cases</h1>
          <p className="text-sm text-muted-foreground">
            Production QA — dry-run real retrieval + answer strategy. No conversations created.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => seedMut.mutate()} disabled={seedMut.isPending}>
            <Sparkles className="h-4 w-4 mr-1" /> Seed recommended
          </Button>
          <Button variant="outline" onClick={() => bulkMut.mutate()} disabled={bulkMut.isPending}>
            <Play className="h-4 w-4 mr-1" /> Run all enabled
          </Button>
          <Button onClick={() => setForm({ ...emptyForm })}>
            <Plus className="h-4 w-4 mr-1" /> New test
          </Button>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="Total" value={summary.total_cases} />
          <Stat label="Enabled" value={summary.enabled_cases} />
          <Stat label="24h runs" value={summary.last_24h_runs} />
          <Stat label="24h passed" value={summary.last_24h_passed} tone="ok" />
          <Stat label="Pass rate" value={summary.pass_rate != null ? `${(summary.pass_rate * 100).toFixed(0)}%` : '—'} />
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>Cases</CardTitle></CardHeader>
        <CardContent className="p-0">
          {casesQ.isLoading ? (
            <div className="p-6 text-muted-foreground">Loading…</div>
          ) : !casesQ.data?.items?.length ? (
            <div className="p-6 text-sm text-muted-foreground">No test cases yet. Try “Seed recommended”.</div>
          ) : (
            <div className="divide-y divide-border/50">
              {casesQ.data.items.map((c: TestCase) => {
                const latest = latestByCase.get(c.id);
                const isOpen = !!expanded[c.id];
                return (
                  <div key={c.id} className="p-4">
                    <div className="flex items-start gap-3">
                      <button onClick={() => setExpanded((e) => ({ ...e, [c.id]: !e[c.id] }))} className="mt-1 text-muted-foreground">
                        {isOpen ? <ChevronDown className="h-4 w-4"/> : <ChevronRight className="h-4 w-4"/>}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{c.name}</span>
                          <Badge variant="outline">{c.expected_behavior}</Badge>
                          {c.expected_source_type && <Badge variant="secondary">{c.expected_source_type}</Badge>}
                          {!c.enabled && <Badge variant="outline">disabled</Badge>}
                          <StatusBadge s={latest?.status} />
                          {latest?.confidence != null && (
                            <span className="text-xs text-muted-foreground">conf {Number(latest.confidence).toFixed(2)}</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{c.input_message}</p>
                        {latest?.failure_reasons?.length ? (
                          <p className="text-xs text-destructive mt-1">{latest.failure_reasons.join(', ')}</p>
                        ) : null}
                      </div>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => runMut.mutate(c.id)} disabled={runMut.isPending}>
                          <Play className="h-3.5 w-3.5"/>
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setForm(formFromCase(c))}>
                          <Pencil className="h-3.5 w-3.5"/>
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => { if (confirm('Delete this test?')) deleteMut.mutate(c.id); }}>
                          <Trash2 className="h-3.5 w-3.5"/>
                        </Button>
                      </div>
                    </div>
                    {isOpen && latest && (
                      <div className="mt-3 ml-7 space-y-2 text-xs">
                        <div><span className="text-muted-foreground">Actual output: </span>{latest.actual_output || '—'}</div>
                        <div><span className="text-muted-foreground">Strategy: </span>{(latest.answer_strategy as any)?.action} / {(latest.answer_strategy as any)?.reason}</div>
                        <div><span className="text-muted-foreground">Selected sources: </span>{(latest.selected_sources || []).map((s: any, i: number) => (
                          <Badge key={i} variant="outline" className="mr-1">{s.source_type}: {String(s.title || '').slice(0, 40)}</Badge>
                        ))}</div>
                        <div className="flex gap-3 pt-1">
                          <Link className="text-primary hover:underline" to={wsPath(`/ai-agent/debug/retrieval`)}>Open Retrieval Debugger</Link>
                          {(latest as any).ai_agent_run_id && (
                            <Link className="text-primary hover:underline" to={wsPath(`/ai-agent/runs/${(latest as any).ai_agent_run_id}`)}>Open Inspector</Link>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form?.id ? 'Edit test case' : 'New test case'}</DialogTitle>
          </DialogHeader>
          {form && (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Input message">
                <Textarea value={form.input_message} onChange={(e) => setForm({ ...form, input_message: e.target.value })} rows={3} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Locale (optional)"><Input value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })} placeholder="en, fa, tr" /></Field>
                <Field label="Min confidence (0–1)"><Input value={form.min_confidence} onChange={(e) => setForm({ ...form, min_confidence: e.target.value })} placeholder="0.6" /></Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Expected behavior">
                  <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.expected_behavior} onChange={(e) => setForm({ ...form, expected_behavior: e.target.value as any })}>
                    {BEHAVIORS.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </Field>
                <Field label="Expected source type">
                  <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.expected_source_type} onChange={(e) => setForm({ ...form, expected_source_type: e.target.value })}>
                    {SOURCE_TYPES.map((s) => <option key={s} value={s}>{s || '(any)'}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Expected source URL"><Input value={form.expected_source_url} onChange={(e) => setForm({ ...form, expected_source_url: e.target.value })} placeholder="https://…" /></Field>
              <Field label="Expected source ID"><Input value={form.expected_source_id} onChange={(e) => setForm({ ...form, expected_source_id: e.target.value })} /></Field>
              <Field label="Expected output contains (one per line)">
                <Textarea value={form.expected_contains} onChange={(e) => setForm({ ...form, expected_contains: e.target.value })} rows={3} />
              </Field>
              <Field label="Expected output does NOT contain (one per line)">
                <Textarea value={form.expected_not_contains} onChange={(e) => setForm({ ...form, expected_not_contains: e.target.value })} rows={2} />
              </Field>
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Page context (optional)</p>
                <div className="grid grid-cols-3 gap-2">
                  <Input placeholder="currentPageUrl" value={form.page_currentPageUrl} onChange={(e) => setForm({ ...form, page_currentPageUrl: e.target.value })} />
                  <Input placeholder="currentPagePath" value={form.page_currentPagePath} onChange={(e) => setForm({ ...form, page_currentPagePath: e.target.value })} />
                  <Input placeholder="currentPageTitle" value={form.page_currentPageTitle} onChange={(e) => setForm({ ...form, page_currentPageTitle: e.target.value })} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
                <span className="text-sm">Enabled</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            <Button onClick={() => form && saveMut.mutate(form)} disabled={!form?.name || !form?.input_message || saveMut.isPending}>
              {saveMut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: any; tone?: 'ok' }) {
  return (
    <div className="rounded-md border border-border/50 bg-card/50 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold ${tone === 'ok' ? 'text-emerald-500' : ''}`}>{value ?? '—'}</div>
    </div>
  );
}
