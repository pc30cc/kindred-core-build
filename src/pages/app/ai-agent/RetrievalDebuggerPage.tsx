import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

export default function RetrievalDebuggerPage() {
  const { workspace } = useActiveWorkspace();
  const [params] = useSearchParams();
  const [message, setMessage] = useState(params.get('message') || '');
  const [locale, setLocale] = useState(params.get('locale') || 'en');
  const [pageUrl, setPageUrl] = useState(params.get('pageUrl') || '');

  const run = useMutation({
    mutationFn: () => aiAgentApi.debugRetrieval({
      workspaceId: workspace!.id,
      message,
      locale,
      pageContext: pageUrl ? { currentPageUrl: pageUrl } : null,
    }),
  });

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <h1 className="text-2xl font-semibold">Retrieval Debugger</h1>
      <p className="text-sm text-muted-foreground">Run retrieval only — no visitor message, no workflow, no LLM call.</p>

      <Card>
        <CardContent className="pt-6 space-y-3">
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Test message…" rows={3} />
          <div className="grid grid-cols-2 gap-3">
            <Input value={locale} onChange={(e) => setLocale(e.target.value)} placeholder="locale (en, fa, tr)" />
            <Input value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} placeholder="Page URL (optional)" />
          </div>
          <Button disabled={!message || run.isPending || !workspace?.id} onClick={() => run.mutate()}>
            {run.isPending ? 'Running…' : 'Run debug retrieval'}
          </Button>
          {run.isError && <div className="text-sm text-destructive">{(run.error as any)?.message || 'Failed'}</div>}
        </CardContent>
      </Card>

      {run.data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Recommendation <Badge variant="outline">{run.data.recommendation}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs space-y-2">
              <div><strong>Page match:</strong> {JSON.stringify(run.data.page_context_debug)}</div>
              {(() => {
                const exc = run.data.excluded_summary || {};
                const entries = Object.entries(exc).filter(([, v]) => Number(v) > 0);
                const allIneligibleWarning = (run.data.sources?.length ?? 0) === 0 && entries.length > 0;
                return (
                  <div className="space-y-1">
                    <div className="font-medium">Excluded sources</div>
                    {entries.length === 0
                      ? <div className="text-muted-foreground">No sources excluded by eligibility filter.</div>
                      : (
                        <ul className="list-disc pl-5">
                          {entries.map(([k, v]) => <li key={k}>{k}: <span className="tabular-nums">{String(v)}</span></li>)}
                        </ul>
                      )}
                    {allIneligibleWarning && (
                      <div className="mt-1 rounded border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 px-2 py-1">
                        Warning: query had matches, but every source was excluded as ineligible.
                      </div>
                    )}
                  </div>
                );
              })()}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Ranked sources</CardTitle></CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="text-xs w-full">
                  <thead><tr className="text-left text-muted-foreground"><th>Type</th><th>Title</th><th>URL</th><th>Final</th><th>kw</th><th>vec</th><th>topic</th><th>url</th><th>locale</th></tr></thead>
                  <tbody>
                    {(run.data.sources || []).map((s: any, i: number) => (
                      <tr key={i} className="border-t border-border/50">
                        <td className="py-1 pr-2"><Badge variant="outline">{s.source_type}</Badge></td>
                        <td className="py-1 pr-2 max-w-[260px] truncate" title={s.title}>{s.title}</td>
                        <td className="py-1 pr-2 max-w-[180px] truncate">{s.source_url || '—'}</td>
                        <td className="py-1 pr-2">{s.final_score?.toFixed(3)}</td>
                        <td className="py-1 pr-2">{s.keyword_score?.toFixed(2)}</td>
                        <td className="py-1 pr-2">{s.vector_score?.toFixed(2)}</td>
                        <td className="py-1 pr-2">{s.topic_boost?.toFixed(2)}</td>
                        <td className="py-1 pr-2">{s.url_boost?.toFixed(2)}</td>
                        <td className="py-1 pr-2">{s.locale || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Why this won</CardTitle></CardHeader>
            <CardContent>
              <pre className="text-xs bg-muted/30 p-3 rounded overflow-auto">{JSON.stringify(run.data.retrieval_debug, null, 2)}</pre>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}