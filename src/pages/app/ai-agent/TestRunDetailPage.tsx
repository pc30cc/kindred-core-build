import { useQuery, useMutation } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { aiAgentApi, type TestRunMetadata } from '@/lib/ai-agent-api';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useTestRunLabels } from './testRunLabels';
import { AnswerStrategySummary, KeyValueList, RawJson } from './TestRunParts';

/** A selected source as a test run records it (server/services/ai-agent/testHarness.ts DryRunSelectedSource). */
interface SelectedSource {
  source_type?: string;
  title?: string;
  source_url?: string | null;
  final_score?: number;
  score?: number;
}

/** An error's code (AiAgentApiError), or its message. */
function codeOf(e: unknown): string {
  if (!e || typeof e !== 'object') return '';
  const r = e as { code?: unknown; message?: unknown };
  if (typeof r.code === 'string') return r.code;
  return typeof r.message === 'string' ? r.message : '';
}

export default function TestRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const wsPath = useWorkspacePath();
  const { t } = useTranslation();
  const labels = useTestRunLabels();
  const q = useQuery({
    queryKey: ['ai-agent', 'test-run', id],
    queryFn: () => aiAgentApi.getTestRun(id!),
    enabled: !!id,
  });
  // Before the early returns below: a hook after them broke the page the
  // moment its run arrived (React's rules of hooks).
  const suggestMut = useMutation({
    mutationFn: (runId: string) => aiAgentApi.suggestTestCaseFromTestRun(runId),
    onSuccess: () => toast({ title: t('aiAgent.adv.testRun.toast.suggestedTitle'), description: t('aiAgent.adv.testRun.toast.suggestedDesc') }),
    onError: (e: unknown) => toast({
      title: t('aiAgent.adv.testRun.toast.suggestFailed'),
      description: codeOf(e).includes('duplicate') ? t('aiAgent.adv.testRun.toast.duplicate') : labels.error(e),
      variant: 'destructive',
    }),
  });

  if (q.isLoading) return <div className="p-6 text-muted-foreground">{t('aiAgent.adv.testRun.loading')}</div>;
  if (q.isError || !q.data) return <div className="p-6 text-destructive">{t('aiAgent.adv.testRun.loadFailed')}</div>;

  const run = q.data.item;
  const tc = q.data.test_case;
  const meta: TestRunMetadata = run.metadata || {};
  const safetyNotes: string[] = meta.safety_notes || [];
  const runtime = meta.runtime || null;
  const runtimeParity = meta.runtime_parity || null;
  const excludedSummary = meta.excluded_summary || null;
  const aiRunId = run.ai_agent_run_id;

  const debugUrl = wsPath(`/ai-agent/debug/retrieval`);
  const tcPC = (tc?.page_context || {}) as Record<string, string | undefined>;
  const debugParams = new URLSearchParams();
  debugParams.set('message', run.input_message);
  if (tc?.locale) debugParams.set('locale', tc.locale);
  if (tcPC.currentPageUrl) debugParams.set('pageUrl', tcPC.currentPageUrl);
  if (tcPC.currentPagePath) debugParams.set('pagePath', tcPC.currentPagePath);
  if (tcPC.currentPageTitle) debugParams.set('pageTitle', tcPC.currentPageTitle);

  const statusVariant: BadgeProps['variant'] = run.status === 'passed' ? 'default' : run.status === 'failed' ? 'destructive' : 'secondary';
  const canSuggest = run.status === 'failed' || run.status === 'errored';

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <div className="flex items-center gap-3">
        <Link to={wsPath('/ai-agent/test-cases')}>
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 me-1 rtl:rotate-180"/> {t('aiAgent.adv.testRun.back')}</Button>
        </Link>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">{t('aiAgent.adv.testRun.title')}</h1>
        <Badge variant={statusVariant}>{labels.status(run.status)}</Badge>
        {run.confidence != null && (
          <span className="text-sm text-muted-foreground">{t('aiAgent.adv.testRun.confidence', { value: Number(run.confidence).toFixed(2) })}</span>
        )}
        {canSuggest && (
          <Button size="sm" variant="outline" disabled={suggestMut.isPending} onClick={() => suggestMut.mutate(run.id)}>
            {suggestMut.isPending ? t('aiAgent.adv.testRun.suggesting') : t('aiAgent.adv.testRun.suggest')}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader><CardTitle>{t('aiAgent.adv.testRun.input.title')}</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-2">
          <div className="rounded bg-muted/30 p-3 whitespace-pre-wrap" dir="auto">{run.input_message}</div>
          {tc && (
            <div className="text-xs text-muted-foreground">
              {t('aiAgent.adv.testRun.input.fromCase')} <span className="font-medium text-foreground" dir="auto">{labels.caseName(tc.name)}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('aiAgent.adv.testRun.compare.title')}</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div className="space-y-1">
            <h3 className="text-xs font-medium text-muted-foreground">{t('aiAgent.adv.testRun.compare.expected')}</h3>
            <div>{t('aiAgent.adv.testRun.compare.behavior')} <Badge variant="outline">{tc?.expected_behavior ? labels.behavior(tc.expected_behavior) : '—'}</Badge></div>
            <div>{t('aiAgent.adv.testRun.compare.sourceType')} <Badge variant="outline">{tc?.expected_source_type ? labels.sourceType(tc.expected_source_type) : t('aiAgent.adv.testRun.compare.anySource')}</Badge></div>
            <div>{t('aiAgent.adv.testRun.compare.sourceId')} <code className="text-xs" dir="ltr">{tc?.expected_source_id || '—'}</code></div>
            <div>{t('aiAgent.adv.testRun.compare.sourceUrl')} <code className="text-xs break-all" dir="ltr">{tc?.expected_source_url || '—'}</code></div>
            <div>{t('aiAgent.adv.testRun.compare.minConfidence')} {tc?.min_confidence ?? '—'}</div>
            {(tc?.expected_contains?.length || 0) > 0 && (
              <div>{t('aiAgent.adv.testRun.compare.contains')} {(tc!.expected_contains || []).map((s, i) => <Badge key={i} variant="secondary" className="me-1" dir="auto">{s}</Badge>)}</div>
            )}
            {(tc?.expected_not_contains?.length || 0) > 0 && (
              <div>{t('aiAgent.adv.testRun.compare.notContains')} {(tc!.expected_not_contains || []).map((s, i) => <Badge key={i} variant="outline" className="me-1" dir="auto">{s}</Badge>)}</div>
            )}
          </div>
          <div className="space-y-1">
            <h3 className="text-xs font-medium text-muted-foreground">{t('aiAgent.adv.testRun.compare.actual')}</h3>
            <div>{t('aiAgent.adv.testRun.compare.status')} <Badge variant="outline">{run.actual_status ? labels.actualStatus(run.actual_status) : '—'}</Badge></div>
            <div className="rounded bg-muted/30 p-2 text-xs whitespace-pre-wrap min-h-[60px]" dir="auto">{run.actual_output || t('aiAgent.adv.testRun.compare.noOutput')}</div>
            {run.failure_reasons?.length ? (
              <div className="text-xs text-destructive">
                <div className="font-medium mb-0.5">{t('aiAgent.adv.testRun.compare.failureReasons')}</div>
                <ul className="list-disc ps-5">{run.failure_reasons.map((r, i) => <li key={i}>{labels.failureReason(r)}</li>)}</ul>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('aiAgent.adv.testRun.sources.title')}</CardTitle></CardHeader>
        <CardContent>
          {!run.selected_sources?.length ? (
            <div className="text-sm text-muted-foreground">{t('aiAgent.adv.testRun.sources.empty')}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr className="text-start text-muted-foreground">
                    <th className="text-start">{t('aiAgent.adv.testRun.sources.type')}</th>
                    <th className="text-start">{t('aiAgent.adv.testRun.sources.name')}</th>
                    <th className="text-start">{t('aiAgent.adv.testRun.sources.url')}</th>
                    <th className="text-start">{t('aiAgent.adv.testRun.sources.score')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(run.selected_sources as SelectedSource[]).map((s, i) => (
                    <tr key={i} className="border-t border-border/50">
                      <td className="py-1 pe-2"><Badge variant="outline">{labels.sourceType(s.source_type)}</Badge></td>
                      <td className="py-1 pe-2 max-w-[280px] truncate" title={s.title} dir="auto">{s.title}</td>
                      <td className="py-1 pe-2 max-w-[220px] truncate" dir="ltr" data-latin-digits="">{s.source_url || '—'}</td>
                      <td className="py-1 pe-2">{Number(s.final_score || s.score || 0).toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {runtime && (
        <Card>
          <CardHeader><CardTitle>{t('aiAgent.adv.testRun.runtime.title')}</CardTitle></CardHeader>
          <CardContent>
            <KeyValueList rows={Object.entries(runtime).map(([key, value]) => ({ key, label: labels.runtimeKey(key), value: labels.yesNo(value) }))} />
          </CardContent>
        </Card>
      )}

      {runtimeParity && (
        <Card>
          <CardHeader><CardTitle>{t('aiAgent.adv.testRun.parity.title')}</CardTitle></CardHeader>
          <CardContent>
            <KeyValueList rows={Object.entries(runtimeParity).map(([key, value]) => ({ key, label: labels.parityKey(key), value: labels.parityValue(String(value)) }))} />
          </CardContent>
        </Card>
      )}

      {excludedSummary && Object.keys(excludedSummary).length > 0 && (
        <Card>
          <CardHeader><CardTitle>{t('aiAgent.adv.testRun.excluded.title')}</CardTitle></CardHeader>
          <CardContent>
            <KeyValueList rows={Object.entries(excludedSummary).map(([key, value]) => ({ key, label: labels.excludedKey(key), value: String(value) }))} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>{t('aiAgent.adv.testRun.strategy.title')}</CardTitle></CardHeader>
        <CardContent>
          <AnswerStrategySummary strategy={run.answer_strategy} labels={labels} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('aiAgent.adv.testRun.retrievalDebug.title')}</CardTitle></CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-2">{t('aiAgent.adv.testRun.rawHint')}</p>
          <RawJson value={run.retrieval_debug} className="max-h-[400px]" />
        </CardContent>
      </Card>

      {safetyNotes.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{t('aiAgent.adv.testRun.safety.title')}</CardTitle></CardHeader>
          <CardContent className="text-xs">
            <ul className="list-disc ps-5">{safetyNotes.map((n, i) => <li key={i}>{labels.safetyNote(n)}</li>)}</ul>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-3 pt-1 flex-wrap">
        <Link
          className="text-primary hover:underline text-sm"
          to={`${debugUrl}?${debugParams.toString()}`}
        >
          {t('aiAgent.adv.testRun.links.debugger')}
        </Link>
        {aiRunId && (
          <Link className="text-primary hover:underline text-sm" to={wsPath(`/ai-agent/runs/${aiRunId}`)}>
            {t('aiAgent.adv.testRun.links.inspector')}
          </Link>
        )}
      </div>
    </div>
  );
}
