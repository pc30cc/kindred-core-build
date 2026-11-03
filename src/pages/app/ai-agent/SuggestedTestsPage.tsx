/**
 * Pass E9 — Suggested regression test cases UI.
 *
 * Workspace-scoped review queue. Operator roles can generate suggestions
 * (from elsewhere in the app); only owners/admins can accept/reject/delete.
 * Accepting a suggestion creates a real `ai_agent_test_cases` row.
 *
 * Every word is the panel's (aiAgent.adv.suggested.*): statuses, where a
 * suggestion came from, its reason (failure reasons of the run, the
 * operator's feedback reason) and the server's default name prefix
 * (server/services/ai-agent/regressionSuggestions.ts shortName) are shown in
 * words; the visitor's message and the operator's comment are data.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { aiAgentApi, type SuggestedTestCase, type SuggestedTestCaseStatus } from '@/lib/ai-agent-api';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useTranslation, type TranslationKey } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { Check, Trash2, X, FlaskConical } from 'lucide-react';
import { isolate, useTestRunLabels, type TestRunLabels } from './testRunLabels';
import { pickErrorText } from './apiErrorCode';
import { regressionFailureReason, splitFailureReasons } from './regressionReasons';

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;
type TabKey = 'pending' | 'converted' | 'rejected' | 'all';
const TABS: TabKey[] = ['pending', 'converted', 'rejected', 'all'];
const BEHAVIORS = ['answer', 'no_answer', 'handoff', 'clarification'] as const;
const SOURCE_TYPES = ['', 'qna', 'learned_qna', 'kb_article', 'web_page', 'file', 'business_profile'] as const;

/** The prefixes the server puts before the visitor's message in a suggestion's name (regressionSuggestions.ts shortName). */
const NAME_PREFIXES = [
  { prefix: 'Assist negative: ', key: 'aiAgent.adv.suggested.namePrefix.assistNegative' },
  { prefix: 'Failed run: ', key: 'aiAgent.adv.suggested.namePrefix.failedRun' },
  { prefix: 'Errored run: ', key: 'aiAgent.adv.suggested.namePrefix.erroredRun' },
] as const satisfies ReadonlyArray<{ prefix: string; key: TranslationKey }>;

interface ReviewForm {
  id: string;
  name: string;
  input_message: string;
  expected_behavior: string;
  expected_source_type: string;
  expected_contains: string;
  expected_not_contains: string;
  min_confidence: string;
}

function suggestionWords(t: Translate, labels: TestRunLabels) {
  const tabMap: Record<TabKey, string> = {
    pending: t('aiAgent.adv.suggested.tabs.pending'),
    converted: t('aiAgent.adv.suggested.tabs.converted'),
    rejected: t('aiAgent.adv.suggested.tabs.rejected'),
    all: t('aiAgent.adv.suggested.tabs.all'),
  };
  const statusMap: Record<string, string> = {
    pending: t('aiAgent.adv.suggested.status.pending'),
    accepted: t('aiAgent.adv.suggested.status.accepted'),
    rejected: t('aiAgent.adv.suggested.status.rejected'),
    converted: t('aiAgent.adv.suggested.status.converted'),
  };
  const originMap: Record<string, string> = {
    operator_assist_feedback: t('aiAgent.adv.suggested.origin.operator_assist_feedback'),
    test_run: t('aiAgent.adv.suggested.origin.test_run'),
    manual: t('aiAgent.adv.suggested.origin.manual'),
  };
  const feedbackReasonMap: Record<string, string> = {
    helpful: t('aiAgent.codes.feedbackReason.helpful'),
    wrong_answer: t('aiAgent.codes.feedbackReason.wrong_answer'),
    missing_context: t('aiAgent.codes.feedbackReason.missing_context'),
    bad_tone: t('aiAgent.codes.feedbackReason.bad_tone'),
    too_long: t('aiAgent.codes.feedbackReason.too_long'),
    too_short: t('aiAgent.codes.feedbackReason.too_short'),
    unsafe: t('aiAgent.codes.feedbackReason.unsafe'),
    not_grounded: t('aiAgent.codes.feedbackReason.not_grounded'),
    other: t('aiAgent.codes.feedbackReason.other'),
  };
  const failureReason = regressionFailureReason(t, labels);
  const has = (map: Record<string, string>, code: string) => Object.prototype.hasOwnProperty.call(map, code);
  const pick = (map: Record<string, string>, code: string | null | undefined) =>
    code ? (has(map, code) ? map[code] : isolate(code)) : '—';
  return {
    tab: (tab: TabKey) => tabMap[tab],
    status: (code: string) => pick(statusMap, code),
    origin: (code: string) => pick(originMap, code),
    /** The server's English prefix in the panel's language; the visitor's words after it stay as they are. */
    name: (name: string) => {
      for (const { prefix, key } of NAME_PREFIXES) {
        if (name.startsWith(prefix)) return `${t(key)}: ${name.slice(prefix.length)}`;
      }
      return name;
    },
    /**
     * Why it was suggested: a failed run's failure reasons (joined by "; "),
     * or the operator's feedback reason and comment (joined by " — ").
     */
    reason: (s: SuggestedTestCase) => {
      const reason = s.reason || '';
      if (!reason) return '';
      if (s.source_type === 'test_run') {
        return labels.list(splitFailureReasons(reason).map(failureReason));
      }
      if (s.source_type === 'operator_assist_feedback') {
        const [code, ...rest] = reason.split(' — ');
        if (has(feedbackReasonMap, code)) return [feedbackReasonMap[code], ...rest].join(' — ');
      }
      return reason;
    },
  };
}

function toForm(s: SuggestedTestCase, localizedName: string): ReviewForm {
  return {
    id: s.id,
    name: localizedName,
    input_message: s.input_message,
    expected_behavior: s.expected_behavior,
    expected_source_type: s.expected_source_type || '',
    expected_contains: (s.expected_contains || []).join('\n'),
    expected_not_contains: (s.expected_not_contains || []).join('\n'),
    min_confidence: s.min_confidence != null ? String(s.min_confidence) : '',
  };
}

function StatusBadge({ s, label }: { s: SuggestedTestCaseStatus; label: string }) {
  const v: BadgeProps['variant'] = s === 'converted' ? 'default' : s === 'rejected' ? 'destructive' : 'secondary';
  return <Badge variant={v}>{label}</Badge>;
}

export default function SuggestedTestsPage() {
  const { t } = useTranslation();
  const labels = useTestRunLabels();
  const words = suggestionWords(t, labels);
  const { workspace } = useActiveWorkspace();
  const wsPath = useWorkspacePath();
  const wsId = workspace?.id;
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>('pending');
  const [form, setForm] = useState<ReviewForm | null>(null);

  const errorText = (e: unknown) => pickErrorText(e, {
    already_converted: t('aiAgent.adv.suggested.errors.already_converted'),
    load_failed: t('aiAgent.adv.suggested.errors.load_failed'),
    tc_insert_failed: t('aiAgent.adv.suggested.errors.tc_insert_failed'),
  }, labels.error);

  const list = useQuery({
    queryKey: ['ai-agent', 'suggested-tc', wsId, tab],
    queryFn: () => aiAgentApi.listSuggestedTestCases(wsId!, tab),
    enabled: !!wsId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['ai-agent', 'suggested-tc', wsId] });

  const acceptMut = useMutation({
    mutationFn: ({ id, overrides }: { id: string; overrides: Partial<SuggestedTestCase> }) =>
      aiAgentApi.acceptSuggestedTestCase(id, overrides),
    onSuccess: (r) => {
      setForm(null);
      invalidate();
      toast({
        title: t('aiAgent.adv.suggested.toast.created'),
        description: t('aiAgent.adv.suggested.toast.createdDesc', { id: isolate(`${r.test_case_id.slice(0, 8)}…`) }),
      });
    },
    onError: (e: unknown) => toast({ title: t('aiAgent.adv.suggested.toast.acceptFailed'), description: errorText(e), variant: 'destructive' }),
  });
  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => aiAgentApi.rejectSuggestedTestCase(id, reason),
    onSuccess: () => { invalidate(); toast({ title: t('aiAgent.adv.suggested.toast.rejected') }); },
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => aiAgentApi.deleteSuggestedTestCase(id),
    onSuccess: () => { invalidate(); toast({ title: t('aiAgent.adv.suggested.toast.deleted') }); },
  });

  const items = useMemo(() => list.data?.items || [], [list.data]);
  const counts = useMemo(() => {
    const map: Record<string, number> = { pending: 0, converted: 0, rejected: 0, all: items.length };
    for (const it of items) map[it.status] = (map[it.status] || 0) + 1;
    return map;
  }, [items]);

  const confirmDelete = (id: string) => {
    if (confirm(t('aiAgent.adv.suggested.confirmDelete'))) deleteMut.mutate(id);
  };

  return (
    <div className="space-y-6 p-1">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FlaskConical className="w-5 h-5 text-primary" /> {t('aiAgent.adv.suggested.title')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t('aiAgent.adv.suggested.subtitle')}
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList>
          {TABS.map((k) => <TabsTrigger key={k} value={k}>{words.tab(k)}</TabsTrigger>)}
        </TabsList>
      </Tabs>

      <Card>
        <CardHeader><CardTitle className="text-sm">{t('aiAgent.adv.suggested.listTitle', { tab: words.tab(tab), count: items.length })}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <div className="p-6 text-muted-foreground text-sm">{t('aiAgent.adv.suggested.loading')}</div>
          ) : items.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              {t('aiAgent.adv.suggested.emptyBefore')}{' '}
              <Link className="text-primary hover:underline" to={wsPath('/ai-agent/operator-assist-analytics')}>{t('aiAgent.adv.suggested.emptyLink')}</Link>{' '}
              {t('aiAgent.adv.suggested.emptyAfter')}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {items.map((s) => {
                const reason = words.reason(s);
                return (
                  <div key={s.id} className="p-4 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium" dir="auto">{words.name(s.name)}</span>
                        <Badge variant="outline">{labels.behavior(s.expected_behavior)}</Badge>
                        {s.expected_source_type && <Badge variant="secondary">{labels.sourceType(s.expected_source_type)}</Badge>}
                        <Badge variant="outline" className="text-[10px]">{words.origin(s.source_type)}</Badge>
                        <StatusBadge s={s.status} label={words.status(s.status)} />
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5" dir="auto">{s.input_message}</p>
                      {reason && <p className="text-xs text-muted-foreground italic mt-1">{t('aiAgent.adv.suggested.reason', { reason })}</p>}
                      {s.metadata?.converted_test_case_id && (
                        <p className="text-xs mt-1">
                          {t('aiAgent.adv.suggested.convertedTo')}{' '}
                          <Link className="text-primary hover:underline" to={wsPath('/ai-agent/test-cases')} dir="ltr">
                            {String(s.metadata.converted_test_case_id).slice(0, 8)}…
                          </Link>
                        </p>
                      )}
                    </div>
                    {s.status === 'pending' && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" onClick={() => setForm(toForm(s, words.name(s.name)))}>
                          <Check className="h-3.5 w-3.5 me-1" /> {t('aiAgent.adv.suggested.actions.accept')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('aiAgent.adv.suggested.actions.reject')}
                          title={t('aiAgent.adv.suggested.actions.reject')}
                          onClick={() => {
                            const reason = prompt(t('aiAgent.adv.suggested.rejectPrompt')) || '';
                            rejectMut.mutate({ id: s.id, reason });
                          }}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('aiAgent.adv.suggested.actions.delete')}
                          title={t('aiAgent.adv.suggested.actions.delete')}
                          onClick={() => confirmDelete(s.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                    {s.status !== 'pending' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('aiAgent.adv.suggested.actions.delete')}
                        title={t('aiAgent.adv.suggested.actions.delete')}
                        onClick={() => confirmDelete(s.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
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
          <DialogHeader><DialogTitle>{t('aiAgent.adv.suggested.dialog.title')}</DialogTitle></DialogHeader>
          {form && (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pe-1">
              <Field id="suggested-name" label={t('aiAgent.adv.suggested.dialog.name')}>
                <Input id="suggested-name" dir="auto" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field id="suggested-input" label={t('aiAgent.adv.suggested.dialog.inputMessage')}>
                <Textarea id="suggested-input" dir="auto" value={form.input_message} onChange={(e) => setForm({ ...form, input_message: e.target.value })} rows={3} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field id="suggested-behavior" label={t('aiAgent.adv.suggested.dialog.expectedBehavior')}>
                  <select id="suggested-behavior" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.expected_behavior} onChange={(e) => setForm({ ...form, expected_behavior: e.target.value })}>
                    {BEHAVIORS.map((b) => <option key={b} value={b}>{labels.behavior(b)}</option>)}
                  </select>
                </Field>
                <Field id="suggested-source-type" label={t('aiAgent.adv.suggested.dialog.expectedSourceType')}>
                  <select id="suggested-source-type" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.expected_source_type} onChange={(e) => setForm({ ...form, expected_source_type: e.target.value })}>
                    {SOURCE_TYPES.map((s) => <option key={s} value={s}>{s ? labels.sourceType(s) : t('aiAgent.adv.suggested.dialog.anySource')}</option>)}
                  </select>
                </Field>
              </div>
              <Field id="suggested-min-confidence" label={t('aiAgent.adv.suggested.dialog.minConfidence')}>
                <Input id="suggested-min-confidence" dir="ltr" value={form.min_confidence} onChange={(e) => setForm({ ...form, min_confidence: e.target.value })} placeholder="0.6" />
              </Field>
              <Field id="suggested-contains" label={t('aiAgent.adv.suggested.dialog.expectedContains')}>
                <Textarea id="suggested-contains" dir="auto" value={form.expected_contains} onChange={(e) => setForm({ ...form, expected_contains: e.target.value })} rows={3} />
              </Field>
              <Field id="suggested-not-contains" label={t('aiAgent.adv.suggested.dialog.expectedNotContains')}>
                <Textarea id="suggested-not-contains" dir="auto" value={form.expected_not_contains} onChange={(e) => setForm({ ...form, expected_not_contains: e.target.value })} rows={2} />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setForm(null)}>{t('aiAgent.adv.suggested.dialog.cancel')}</Button>
            <Button
              disabled={!form?.name || !form?.input_message || acceptMut.isPending}
              onClick={() => {
                if (!form) return;
                const overrides: Partial<SuggestedTestCase> = {
                  name: form.name,
                  input_message: form.input_message,
                  expected_behavior: form.expected_behavior as SuggestedTestCase['expected_behavior'],
                  expected_source_type: form.expected_source_type || null,
                  expected_contains: form.expected_contains.split('\n').map((s) => s.trim()).filter(Boolean),
                  expected_not_contains: form.expected_not_contains.split('\n').map((s) => s.trim()).filter(Boolean),
                  min_confidence: form.min_confidence ? Number(form.min_confidence) : null,
                };
                acceptMut.mutate({ id: form.id, overrides });
              }}
            >
              {acceptMut.isPending ? t('aiAgent.adv.suggested.dialog.saving') : t('aiAgent.adv.suggested.dialog.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* counts hint */}
      <p className="text-xs text-muted-foreground">
        {t('aiAgent.adv.suggested.counts', { pending: counts.pending, converted: counts.converted, rejected: counts.rejected })}
      </p>
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
