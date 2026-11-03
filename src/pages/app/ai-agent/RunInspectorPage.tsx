import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { formatDateTime } from '@/lib/date';
import { ArrowLeft } from 'lucide-react';
import { isolate, useTestRunLabels } from './testRunLabels';
import { AnswerStrategySummary, RawJson } from './TestRunParts';

/** A selected source as the inspector returns it (server/routes/ai-agent/activity.ts). */
interface InspectedSource {
  source_type?: string;
  title?: string;
  source_url?: string | null;
  final_score?: number;
  score?: number;
  keyword_score?: number;
  vector_score?: number;
  included_in_prompt?: boolean;
}

export default function RunInspectorPage() {
  const { id } = useParams<{ id: string }>();
  const wsPath = useWorkspacePath();
  const { t } = useTranslation();
  const labels = useTestRunLabels();
  const q = useQuery({
    queryKey: ['ai-agent', 'inspect', id],
    queryFn: () => aiAgentApi.inspectRun(id!),
    enabled: !!id,
  });

  if (q.isLoading) return <div className="p-6 text-muted-foreground">{t('aiAgent.adv.runInspector.loading')}</div>;
  if (q.isError || !q.data) return <div className="p-6 text-destructive">{t('aiAgent.adv.runInspector.loadFailed')}</div>;
  const d = q.data;

  const statusLabels: Record<string, string> = {
    replied: t('aiAgent.adv.runInspector.status.replied'),
    suggested: t('aiAgent.adv.runInspector.status.suggested'),
    handoff: t('aiAgent.adv.runInspector.status.handoff'),
    no_answer: t('aiAgent.adv.runInspector.status.no_answer'),
    skipped: t('aiAgent.adv.runInspector.status.skipped'),
    failed: t('aiAgent.adv.runInspector.status.failed'),
    pending: t('aiAgent.adv.runInspector.status.pending'),
  };
  const runTypeLabels: Record<string, string> = {
    playground: t('aiAgent.adv.runInspector.runType.playground'),
    auto_reply: t('aiAgent.adv.runInspector.runType.auto_reply'),
    suggestion: t('aiAgent.adv.runInspector.runType.suggestion'),
    handoff: t('aiAgent.adv.runInspector.runType.handoff'),
    skip: t('aiAgent.adv.runInspector.runType.skip'),
  };
  const word = (map: Record<string, string>, code: unknown) =>
    typeof code === 'string' && code ? (map[code] ?? isolate(code)) : '—';
  const sources = (d.selected_sources || []) as InspectedSource[];
  const S = (n: number | undefined, digits: number) => (typeof n === 'number' ? n.toFixed(digits) : '—');

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">{t('aiAgent.adv.runInspector.title')}</h1>
        <Link to={wsPath('/ai-agent/analytics')} className="text-sm text-muted-foreground hover:underline inline-flex items-center gap-1">
          <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" /> {t('aiAgent.adv.runInspector.back')}
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 flex-wrap">
            {t('aiAgent.adv.runInspector.run')}
            <Badge variant="outline">{word(statusLabels, d.run.status)}</Badge>
            <Badge variant="secondary">{word(runTypeLabels, d.run.run_type)}</Badge>
            {typeof d.run.confidence === 'number' && <Badge>{t('aiAgent.adv.runInspector.confidence', { value: d.run.confidence.toFixed(2) })}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <span className="text-muted-foreground">{t('aiAgent.adv.runInspector.visitor')}</span>
            <pre className="whitespace-pre-wrap font-sans" dir="auto">{d.visitor_message?.body || d.run.input_text || '—'}</pre>
          </div>
          <div>
            <span className="text-muted-foreground">{t('aiAgent.adv.runInspector.aiReply')}</span>
            <pre className="whitespace-pre-wrap font-sans" dir="auto">{d.ai_message?.body || d.run.output_text || '—'}</pre>
          </div>
          <div className="text-xs text-muted-foreground">
            <span dir="ltr" data-latin-digits="">{d.run.provider || '—'} · {d.run.model || '—'}</span> · {formatDateTime(d.run.created_at)}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('aiAgent.adv.runInspector.strategy')}</CardTitle></CardHeader>
        <CardContent>
          <AnswerStrategySummary strategy={d.answer_strategy} labels={labels} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('aiAgent.adv.runInspector.pageContext')}</CardTitle></CardHeader>
        <CardContent>
          {d.page_context ? <RawJson value={d.page_context} /> : <p className="text-sm text-muted-foreground">{t('aiAgent.adv.runInspector.noPageContext')}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('aiAgent.adv.runInspector.sources.title')}</CardTitle></CardHeader>
        <CardContent>
          {sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('aiAgent.adv.runInspector.sources.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="text-start">{t('aiAgent.adv.runInspector.sources.type')}</th>
                    <th className="text-start">{t('aiAgent.adv.runInspector.sources.name')}</th>
                    <th className="text-start">{t('aiAgent.adv.runInspector.sources.url')}</th>
                    <th className="text-start">{t('aiAgent.adv.runInspector.sources.final')}</th>
                    <th className="text-start">{t('aiAgent.adv.runInspector.sources.keyword')}</th>
                    <th className="text-start">{t('aiAgent.adv.runInspector.sources.vector')}</th>
                    <th className="text-start">{t('aiAgent.adv.runInspector.sources.used')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s, i) => (
                    <tr key={i} className="border-t border-border/50">
                      <td className="py-1 pe-2"><Badge variant="outline">{labels.sourceType(s.source_type)}</Badge></td>
                      <td className="py-1 pe-2 max-w-[280px] truncate" dir="auto">{s.title}</td>
                      <td className="py-1 pe-2 max-w-[200px] truncate" dir="ltr" data-latin-digits="">{s.source_url || '—'}</td>
                      <td className="py-1 pe-2">{S(s.final_score ?? s.score, 3)}</td>
                      <td className="py-1 pe-2">{(s.keyword_score ?? 0).toFixed(2)}</td>
                      <td className="py-1 pe-2">{(s.vector_score ?? 0).toFixed(2)}</td>
                      <td className="py-1 pe-2">{s.included_in_prompt ? t('aiAgent.adv.runInspector.sources.yes') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('aiAgent.adv.runInspector.timeline.title')}</CardTitle></CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-2">{t('aiAgent.adv.runInspector.timeline.hint')}</p>
          <RawJson value={d.decision_timeline} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('aiAgent.adv.runInspector.prompt.title')}</CardTitle></CardHeader>
        <CardContent>
          {d.prompt_preview
            ? <RawJson value={d.prompt_preview} />
            : <p className="text-sm text-muted-foreground">{t('aiAgent.adv.runInspector.prompt.notStored')}</p>}
        </CardContent>
      </Card>

      {d.safety_notes?.length ? (
        <Card>
          <CardHeader><CardTitle>{t('aiAgent.adv.runInspector.safety')}</CardTitle></CardHeader>
          <CardContent><ul className="text-xs list-disc ps-4">{(d.safety_notes as string[]).map((n, i) => <li key={i}>{labels.safetyNote(n)}</li>)}</ul></CardContent>
        </Card>
      ) : null}
    </div>
  );
}
