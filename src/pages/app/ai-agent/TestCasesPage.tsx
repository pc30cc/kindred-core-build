import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { aiAgentApi, type TestCase, type TestRun } from '@/lib/ai-agent-api';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/hooks/use-toast';
import { Play, Plus, Trash2, Pencil, Sparkles, ChevronDown, ChevronRight } from 'lucide-react';
import { isolate, useTestRunLabels, type TestRunLabels } from './testRunLabels';

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

/** A selected source as a test run records it (server/services/ai-agent/testHarness.ts DryRunSelectedSource). */
interface SelectedSource {
  source_type?: string;
  title?: string | null;
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
  const pc = (c.page_context || {}) as Record<string, string | undefined>;
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

function formToPayload(f: FormState): Partial<TestCase> {
  const splitLines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const pc: Record<string, string> = {};
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

function statusVariant(s: string): BadgeProps['variant'] {
  return s === 'passed' ? 'default' : s === 'failed' ? 'destructive' : 'secondary';
}

function StatusBadge({ s, labels }: { s?: string; labels: TestRunLabels }) {
  if (!s) return <Badge variant="outline">—</Badge>;
  return <Badge variant={statusVariant(s)}>{labels.status(s)}</Badge>;
}

export default function TestCasesPage() {
  const { workspace } = useActiveWorkspace();
  const wsPath = useWorkspacePath();
  const { t } = useTranslation();
  const labels = useTestRunLabels();
  const wsId = workspace?.id;
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const casesQ = useQuery({
    queryKey: ['ai-agent', 'test-cases', wsId],
    queryFn: () => aiAgentApi.listTestCases(wsId!),
    enabled: !!wsId,
  });
  const runsQ = useQuery({
    queryKey: ['ai-agent', 'test-runs', wsId],
    queryFn: () => aiAgentApi.listTestRuns(wsId!),
    enabled: !!wsId,
  });
  const summaryQ = useQuery({
    queryKey: ['ai-agent', 'test-summary', wsId],
    queryFn: () => aiAgentApi.getTestSummary(wsId!),
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
      if (f.id) return aiAgentApi.updateTestCase(f.id, formToPayload(f));
      return aiAgentApi.createTestCase(wsId!, formToPayload(f));
    },
    onSuccess: () => { setForm(null); invalidateAll(); toast({ title: t('aiAgent.adv.testCases.toast.saved') }); },
    onError: (e: unknown) => toast({ title: t('aiAgent.adv.testCases.toast.saveFailed'), description: labels.error(e), variant: 'destructive' }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => aiAgentApi.deleteTestCase(id),
    onSuccess: () => { invalidateAll(); toast({ title: t('aiAgent.adv.testCases.toast.deleted') }); },
  });
  const runMut = useMutation({
    mutationFn: (id: string) => aiAgentApi.runTestCase(id),
    onSuccess: (data) => {
      invalidateAll();
      const status = data.run?.status;
      toast({
        title: status === 'passed'
          ? t('aiAgent.adv.testCases.toast.passed')
          : status === 'errored'
            ? t('aiAgent.adv.testCases.toast.errored')
            : t('aiAgent.adv.testCases.toast.failed'),
        description: labels.failureReasons(data.run?.failure_reasons) || undefined,
        variant: status === 'passed' ? 'default' : 'destructive',
      });
    },
  });
  const bulkMut = useMutation({
    mutationFn: () => aiAgentApi.runBulkTests(wsId!),
    onSuccess: (s) => {
      invalidateAll();
      const counts = t('aiAgent.adv.testCases.toast.bulkDesc', { failed: s.failed, errored: s.errored });
      const capped = s.capped
        ? t('aiAgent.adv.testCases.toast.bulkCapped', { max: s.max, enabled: s.total_enabled ?? '?' })
        : '';
      toast({
        title: t('aiAgent.adv.testCases.toast.bulkTitle', { passed: s.passed, total: s.total }),
        description: capped ? `${counts} ${capped}` : counts,
      });
    },
  });
  const seedMut = useMutation({
    mutationFn: () => aiAgentApi.seedRecommendedTests(wsId!),
    onSuccess: (r) => {
      invalidateAll();
      const reasons = (r.skipped_reasons || []).slice(0, 3).map(labels.seedSkip);
      const skipped = t('aiAgent.adv.testCases.toast.seedSkipped', { count: r.skipped });
      toast({
        title: t('aiAgent.adv.testCases.toast.seeded', { count: r.inserted }),
        description: reasons.length ? `${skipped} ${labels.list(reasons)}` : skipped,
      });
    },
  });

  const summary = summaryQ.data;
  const seedLabel = t('aiAgent.adv.testCases.seed');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">{t('aiAgent.adv.testCases.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('aiAgent.adv.testCases.subtitle')}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={() => seedMut.mutate()} disabled={seedMut.isPending}>
            <Sparkles className="h-4 w-4 me-1" /> {seedLabel}
          </Button>
          <Button variant="outline" onClick={() => bulkMut.mutate()} disabled={bulkMut.isPending}>
            <Play className="h-4 w-4 me-1" /> {t('aiAgent.adv.testCases.runAll')}
          </Button>
          <Button onClick={() => setForm({ ...emptyForm })}>
            <Plus className="h-4 w-4 me-1" /> {t('aiAgent.adv.testCases.newTest')}
          </Button>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label={t('aiAgent.adv.testCases.stats.total')} value={summary.total_cases} />
          <Stat label={t('aiAgent.adv.testCases.stats.enabled')} value={summary.enabled_cases} />
          <Stat label={t('aiAgent.adv.testCases.stats.runs24h')} value={summary.last_24h_runs} />
          <Stat label={t('aiAgent.adv.testCases.stats.passed24h')} value={summary.last_24h_passed} tone="ok" />
          <Stat label={t('aiAgent.adv.testCases.stats.passRate')} value={summary.pass_rate != null ? `${(summary.pass_rate * 100).toFixed(0)}%` : '—'} />
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>{t('aiAgent.adv.testCases.listTitle')}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {casesQ.isLoading ? (
            <div className="p-6 text-muted-foreground">{t('aiAgent.adv.testCases.loading')}</div>
          ) : !casesQ.data?.items?.length ? (
            <div className="p-6 text-sm text-muted-foreground">{t('aiAgent.adv.testCases.empty', { seed: seedLabel })}</div>
          ) : (
            <div className="divide-y divide-border/50">
              {casesQ.data.items.map((c: TestCase) => {
                const latest = latestByCase.get(c.id);
                const isOpen = !!expanded[c.id];
                const toggleLabel = isOpen ? t('aiAgent.adv.testCases.actions.collapse') : t('aiAgent.adv.testCases.actions.expand');
                return (
                  <div key={c.id} className="p-4">
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => setExpanded((e) => ({ ...e, [c.id]: !e[c.id] }))}
                        className="mt-1 text-muted-foreground"
                        aria-label={toggleLabel}
                        aria-expanded={isOpen}
                        title={toggleLabel}
                      >
                        {isOpen ? <ChevronDown className="h-4 w-4"/> : <ChevronRight className="h-4 w-4 rtl:rotate-180"/>}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium" dir="auto">{labels.caseName(c.name)}</span>
                          <Badge variant="outline">{labels.behavior(c.expected_behavior)}</Badge>
                          {c.expected_source_type && <Badge variant="secondary">{labels.sourceType(c.expected_source_type)}</Badge>}
                          {!c.enabled && <Badge variant="outline">{t('aiAgent.adv.testCases.disabled')}</Badge>}
                          <StatusBadge s={latest?.status} labels={labels} />
                          {latest?.confidence != null && (
                            <span className="text-xs text-muted-foreground">
                              {t('aiAgent.adv.testCases.confidence', { value: Number(latest.confidence).toFixed(2) })}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate mt-0.5" dir="auto">{c.input_message}</p>
                        {latest?.failure_reasons?.length ? (
                          <p className="text-xs text-destructive mt-1">{labels.failureReasons(latest.failure_reasons)}</p>
                        ) : null}
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => runMut.mutate(c.id)}
                          disabled={runMut.isPending}
                          aria-label={t('aiAgent.adv.testCases.actions.run')}
                          title={t('aiAgent.adv.testCases.actions.run')}
                        >
                          <Play className="h-3.5 w-3.5"/>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setForm({ ...formFromCase(c), name: labels.caseNameForEdit(c.name) })}
                          aria-label={t('aiAgent.adv.testCases.actions.edit')}
                          title={t('aiAgent.adv.testCases.actions.edit')}
                        >
                          <Pencil className="h-3.5 w-3.5"/>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => { if (confirm(t('aiAgent.adv.testCases.confirmDelete'))) deleteMut.mutate(c.id); }}
                          aria-label={t('aiAgent.adv.testCases.actions.delete')}
                          title={t('aiAgent.adv.testCases.actions.delete')}
                        >
                          <Trash2 className="h-3.5 w-3.5"/>
                        </Button>
                      </div>
                    </div>
                    {isOpen && latest && (
                      <div className="mt-3 ms-7 space-y-2 text-xs">
                        <div>
                          <span className="text-muted-foreground">{t('aiAgent.adv.testCases.latest.actualOutput')} </span>
                          <span dir="auto">{latest.actual_output || '—'}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">{t('aiAgent.adv.testCases.latest.strategy')} </span>
                          {labels.behavior(latest.answer_strategy?.action)} / {labels.reason(latest.answer_strategy?.reason)}
                        </div>
                        <div>
                          <span className="text-muted-foreground">{t('aiAgent.adv.testCases.latest.selectedSources')} </span>
                          {(latest.selected_sources || []).length === 0
                            ? '—'
                            : (latest.selected_sources as SelectedSource[]).map((s, i) => (
                              <Badge key={i} variant="outline" className="me-1">
                                {labels.sourceType(s.source_type)}: {isolate(String(s.title || '').slice(0, 40))}
                              </Badge>
                            ))}
                        </div>
                        <div className="flex gap-3 pt-1 flex-wrap">
                          <Link className="text-primary hover:underline" to={wsPath(`/ai-agent/debug/retrieval`)}>{t('aiAgent.adv.testCases.latest.openDebugger')}</Link>
                          <Link className="text-primary hover:underline" to={wsPath(`/ai-agent/test-runs/${latest.id}`)}>{t('aiAgent.adv.testCases.latest.openRun')}</Link>
                          {latest.ai_agent_run_id && (
                            <Link className="text-primary hover:underline" to={wsPath(`/ai-agent/runs/${latest.ai_agent_run_id}`)}>{t('aiAgent.adv.testCases.latest.openInspector')}</Link>
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
            <DialogTitle>{form?.id ? t('aiAgent.adv.testCases.form.editTitle') : t('aiAgent.adv.testCases.form.newTitle')}</DialogTitle>
          </DialogHeader>
          {form && (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pe-1">
              <Field id="tc-name" label={t('aiAgent.adv.testCases.form.name')}>
                <Input id="tc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field id="tc-input" label={t('aiAgent.adv.testCases.form.inputMessage')}>
                <Textarea id="tc-input" dir="auto" value={form.input_message} onChange={(e) => setForm({ ...form, input_message: e.target.value })} rows={3} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field id="tc-locale" label={t('aiAgent.adv.testCases.form.locale')}>
                  <Input id="tc-locale" dir="ltr" value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })} placeholder="en, fa, tr" />
                </Field>
                <Field id="tc-min-confidence" label={t('aiAgent.adv.testCases.form.minConfidence')}>
                  <Input id="tc-min-confidence" dir="ltr" value={form.min_confidence} onChange={(e) => setForm({ ...form, min_confidence: e.target.value })} placeholder="0.6" />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field id="tc-behavior" label={t('aiAgent.adv.testCases.form.expectedBehavior')}>
                  <select id="tc-behavior" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.expected_behavior} onChange={(e) => setForm({ ...form, expected_behavior: e.target.value as FormState['expected_behavior'] })}>
                    {BEHAVIORS.map((b) => <option key={b} value={b}>{labels.behavior(b)}</option>)}
                  </select>
                </Field>
                <Field id="tc-source-type" label={t('aiAgent.adv.testCases.form.expectedSourceType')}>
                  <select id="tc-source-type" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.expected_source_type} onChange={(e) => setForm({ ...form, expected_source_type: e.target.value })}>
                    {SOURCE_TYPES.map((s) => <option key={s} value={s}>{s ? labels.sourceType(s) : t('aiAgent.adv.testCases.form.anySource')}</option>)}
                  </select>
                </Field>
              </div>
              <Field id="tc-source-url" label={t('aiAgent.adv.testCases.form.expectedSourceUrl')}>
                <Input id="tc-source-url" dir="ltr" value={form.expected_source_url} onChange={(e) => setForm({ ...form, expected_source_url: e.target.value })} placeholder="https://…" />
              </Field>
              <Field id="tc-source-id" label={t('aiAgent.adv.testCases.form.expectedSourceId')}>
                <Input id="tc-source-id" dir="ltr" value={form.expected_source_id} onChange={(e) => setForm({ ...form, expected_source_id: e.target.value })} />
              </Field>
              <Field id="tc-contains" label={t('aiAgent.adv.testCases.form.expectedContains')}>
                <Textarea id="tc-contains" dir="auto" value={form.expected_contains} onChange={(e) => setForm({ ...form, expected_contains: e.target.value })} rows={3} />
              </Field>
              <Field id="tc-not-contains" label={t('aiAgent.adv.testCases.form.expectedNotContains')}>
                <Textarea id="tc-not-contains" dir="auto" value={form.expected_not_contains} onChange={(e) => setForm({ ...form, expected_not_contains: e.target.value })} rows={2} />
              </Field>
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{t('aiAgent.adv.testCases.form.pageContext')}</p>
                <div className="grid grid-cols-3 gap-2">
                  <Input dir="ltr" aria-label={t('aiAgent.adv.testCases.form.pageUrl')} placeholder={t('aiAgent.adv.testCases.form.pageUrl')} value={form.page_currentPageUrl} onChange={(e) => setForm({ ...form, page_currentPageUrl: e.target.value })} />
                  <Input dir="ltr" aria-label={t('aiAgent.adv.testCases.form.pagePath')} placeholder={t('aiAgent.adv.testCases.form.pagePath')} value={form.page_currentPagePath} onChange={(e) => setForm({ ...form, page_currentPagePath: e.target.value })} />
                  <Input dir="auto" aria-label={t('aiAgent.adv.testCases.form.pageTitle')} placeholder={t('aiAgent.adv.testCases.form.pageTitle')} value={form.page_currentPageTitle} onChange={(e) => setForm({ ...form, page_currentPageTitle: e.target.value })} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="tc-enabled" checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
                <label htmlFor="tc-enabled" className="text-sm">{t('aiAgent.adv.testCases.form.enabled')}</label>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setForm(null)}>{t('aiAgent.adv.testCases.form.cancel')}</Button>
            <Button onClick={() => form && saveMut.mutate(form)} disabled={!form?.name || !form?.input_message || saveMut.isPending}>
              {saveMut.isPending ? t('aiAgent.adv.testCases.form.saving') : t('aiAgent.adv.testCases.form.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'ok' }) {
  return (
    <div className="rounded-md border border-border/50 bg-card/50 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold ${tone === 'ok' ? 'text-emerald-500' : ''}`}>{value ?? '—'}</div>
    </div>
  );
}
