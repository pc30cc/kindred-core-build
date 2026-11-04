import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { isolate, useTestRunLabels } from './testRunLabels';
import { pickErrorText } from './apiErrorCode';

/** POST /api/ai-agent/debug/retrieval (server/routes/ai-agent/internalQa.ts): what this page reads of it. */
interface DebugSource {
  source_type: string;
  title: string;
  source_url: string | null;
  locale: string | null;
  final_score?: number;
  keyword_score?: number;
  vector_score?: number;
  topic_boost?: number;
  url_boost?: number;
}
interface DebugPageContext {
  current_page_url?: string | null;
  exact_page_match?: boolean;
  same_path_match?: boolean;
  same_host_match?: boolean;
  page_url_boost_applied?: boolean;
  page_matched_source_ids?: string[];
}
interface DebugRetrievalResult {
  recommendation: string;
  page_context_debug: DebugPageContext | null;
  excluded_summary: Record<string, number> | null;
  sources: DebugSource[] | null;
  retrieval_debug: unknown;
}

const RECOMMENDATIONS = ['answer_possible', 'needs_clarification', 'handoff_likely', 'no_answer_likely'] as const;

export default function RetrievalDebuggerPage() {
  const { t } = useTranslation();
  const labels = useTestRunLabels();
  const { workspace } = useActiveWorkspace();
  const [params] = useSearchParams();
  const [message, setMessage] = useState(params.get('message') || '');
  const [locale, setLocale] = useState(params.get('locale') || 'en');
  const [pageUrl, setPageUrl] = useState(params.get('pageUrl') || '');
  const [pagePath, setPagePath] = useState(params.get('pagePath') || '');
  const [pageTitle, setPageTitle] = useState(params.get('pageTitle') || '');

  const run = useMutation({
    mutationFn: () => {
      const pc: Record<string, string> = {};
      if (pageUrl) pc.currentPageUrl = pageUrl;
      if (pagePath) pc.currentPagePath = pagePath;
      if (pageTitle) pc.currentPageTitle = pageTitle;
      return aiAgentApi.debugRetrieval({
        workspaceId: workspace!.id,
        message,
        locale,
        pageContext: Object.keys(pc).length ? pc : null,
      }) as Promise<DebugRetrievalResult>;
    },
  });

  const recommendationMap: Record<string, string> = {
    answer_possible: t('aiAgent.adv.retrievalDebug.recommendation.answer_possible'),
    needs_clarification: t('aiAgent.adv.retrievalDebug.recommendation.needs_clarification'),
    handoff_likely: t('aiAgent.adv.retrievalDebug.recommendation.handoff_likely'),
    no_answer_likely: t('aiAgent.adv.retrievalDebug.recommendation.no_answer_likely'),
  };
  const recommendation = (code: string) =>
    (RECOMMENDATIONS as readonly string[]).includes(code) ? recommendationMap[code] : isolate(code);
  const errorText = (e: unknown) => pickErrorText(e, {
    debug_rate_limited: t('aiAgent.adv.retrievalDebug.errors.debug_rate_limited'),
    retrieval_debug_failed: t('aiAgent.adv.retrievalDebug.errors.retrieval_debug_failed'),
    invalid_params: t('aiAgent.adv.retrievalDebug.errors.invalid_params'),
  }, labels.error);

  const localePlaceholder = t('aiAgent.adv.retrievalDebug.form.locale', { codes: isolate('en, fa, tr') });
  const data = run.data;
  const page = data?.page_context_debug;
  const pageItem = (label: string, value: string) => t('aiAgent.adv.retrievalDebug.pageMatch.item', { label, value });

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <h1 className="text-2xl font-semibold">{t('aiAgent.adv.retrievalDebug.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('aiAgent.adv.retrievalDebug.subtitle')}</p>

      <Card>
        <CardContent className="pt-6 space-y-3">
          <Textarea
            dir="auto"
            aria-label={t('aiAgent.adv.retrievalDebug.form.message')}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('aiAgent.adv.retrievalDebug.form.messagePlaceholder')}
            rows={3}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input dir="ltr" aria-label={localePlaceholder} value={locale} onChange={(e) => setLocale(e.target.value)} placeholder={localePlaceholder} />
            <Input dir="ltr" aria-label={t('aiAgent.adv.retrievalDebug.form.pageUrl')} value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} placeholder={t('aiAgent.adv.retrievalDebug.form.pageUrl')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input dir="ltr" aria-label={t('aiAgent.adv.retrievalDebug.form.pagePath')} value={pagePath} onChange={(e) => setPagePath(e.target.value)} placeholder={t('aiAgent.adv.retrievalDebug.form.pagePath')} />
            <Input dir="auto" aria-label={t('aiAgent.adv.retrievalDebug.form.pageTitle')} value={pageTitle} onChange={(e) => setPageTitle(e.target.value)} placeholder={t('aiAgent.adv.retrievalDebug.form.pageTitle')} />
          </div>
          <Button disabled={!message || run.isPending || !workspace?.id} onClick={() => run.mutate()}>
            {run.isPending ? t('aiAgent.adv.retrievalDebug.form.running') : t('aiAgent.adv.retrievalDebug.form.run')}
          </Button>
          {run.isError && <div className="text-sm text-destructive">{errorText(run.error)}</div>}
        </CardContent>
      </Card>

      {data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {t('aiAgent.adv.retrievalDebug.recommendation.title')} <Badge variant="outline">{recommendation(data.recommendation)}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs space-y-2">
              <div>
                <strong>{t('aiAgent.adv.retrievalDebug.pageMatch.title')}</strong>{' '}
                {!page
                  ? t('aiAgent.adv.retrievalDebug.pageMatch.none')
                  : [
                    pageItem(t('aiAgent.adv.retrievalDebug.pageMatch.exact'), labels.yesNo(!!page.exact_page_match)),
                    pageItem(t('aiAgent.adv.retrievalDebug.pageMatch.samePath'), labels.yesNo(!!page.same_path_match)),
                    pageItem(t('aiAgent.adv.retrievalDebug.pageMatch.sameHost'), labels.yesNo(!!page.same_host_match)),
                    pageItem(t('aiAgent.adv.retrievalDebug.pageMatch.boost'), labels.yesNo(!!page.page_url_boost_applied)),
                    pageItem(t('aiAgent.adv.retrievalDebug.pageMatch.matchedSources'), String(page.page_matched_source_ids?.length ?? 0)),
                  ].join(' · ')}
              </div>
              {(() => {
                const exc = data.excluded_summary || {};
                const entries = Object.entries(exc).filter(([, v]) => Number(v) > 0);
                const allIneligibleWarning = (data.sources?.length ?? 0) === 0 && entries.length > 0;
                return (
                  <div className="space-y-1">
                    <div className="font-medium">{t('aiAgent.adv.retrievalDebug.excluded.title')}</div>
                    {entries.length === 0
                      ? <div className="text-muted-foreground">{t('aiAgent.adv.retrievalDebug.excluded.none')}</div>
                      : (
                        <ul className="list-disc ps-5">
                          {entries.map(([k, v]) => <li key={k}>{labels.excludedKey(k)}: <span className="tabular-nums">{String(v)}</span></li>)}
                        </ul>
                      )}
                    {allIneligibleWarning && (
                      <div className="mt-1 rounded border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 px-2 py-1">
                        {t('aiAgent.adv.retrievalDebug.excluded.allIneligible')}
                      </div>
                    )}
                  </div>
                );
              })()}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('aiAgent.adv.retrievalDebug.sources.title')}</CardTitle></CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="text-xs w-full">
                  <thead>
                    <tr className="text-start text-muted-foreground">
                      <th className="text-start">{t('aiAgent.adv.retrievalDebug.sources.cols.type')}</th>
                      <th className="text-start">{t('aiAgent.adv.retrievalDebug.sources.cols.title')}</th>
                      <th className="text-start">{t('aiAgent.adv.retrievalDebug.sources.cols.url')}</th>
                      <th className="text-start">{t('aiAgent.adv.retrievalDebug.sources.cols.final')}</th>
                      <th className="text-start">{t('aiAgent.adv.retrievalDebug.sources.cols.keyword')}</th>
                      <th className="text-start">{t('aiAgent.adv.retrievalDebug.sources.cols.vector')}</th>
                      <th className="text-start">{t('aiAgent.adv.retrievalDebug.sources.cols.topic')}</th>
                      <th className="text-start">{t('aiAgent.adv.retrievalDebug.sources.cols.urlBoost')}</th>
                      <th className="text-start">{t('aiAgent.adv.retrievalDebug.sources.cols.locale')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.sources || []).map((s, i) => (
                      <tr key={i} className="border-t border-border/50">
                        <td className="py-1 pe-2"><Badge variant="outline">{labels.sourceType(s.source_type)}</Badge></td>
                        <td className="py-1 pe-2 max-w-[260px] truncate" title={s.title} dir="auto">{s.title}</td>
                        <td className="py-1 pe-2 max-w-[180px] truncate" dir="ltr" data-latin-digits="">{s.source_url || '—'}</td>
                        <td className="py-1 pe-2">{s.final_score?.toFixed(3)}</td>
                        <td className="py-1 pe-2">{s.keyword_score?.toFixed(2)}</td>
                        <td className="py-1 pe-2">{s.vector_score?.toFixed(2)}</td>
                        <td className="py-1 pe-2">{s.topic_boost?.toFixed(2)}</td>
                        <td className="py-1 pe-2">{s.url_boost?.toFixed(2)}</td>
                        <td className="py-1 pe-2" dir="ltr">{s.locale || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('aiAgent.adv.retrievalDebug.why.title')}</CardTitle></CardHeader>
            <CardContent>
              <pre dir="ltr" data-latin-digits="" className="text-xs bg-muted/30 p-3 rounded overflow-auto">{JSON.stringify(data.retrieval_debug, null, 2)}</pre>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
