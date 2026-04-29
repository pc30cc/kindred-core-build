import { useQuery } from '@tanstack/react-query';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentAnalytics, useAiAgentRuns } from '@/hooks/useAiAgent';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BarChart3, Loader2 } from 'lucide-react';

export default function AnalyticsPage() {
  const { workspace } = useActiveWorkspace();
  const { data: stats, isLoading: l1 } = useAiAgentAnalytics(workspace?.id);
  const { data: runsData, isLoading: l2 } = useAiAgentRuns(workspace?.id);
  const overview = useQuery({
    queryKey: ['ai-overview', workspace?.id],
    queryFn: () => aiAgentApi.getOverview(workspace!.id),
    enabled: !!workspace?.id,
    staleTime: 30_000,
  });

  if (l1 || l2 || overview.isLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const runs = runsData?.runs || [];
  const s = stats || { total: 0, replies: 0, handoffs: 0, no_answer: 0 };
  const c = overview.data?.counts;

  const topicTally: Record<string, number> = {};
  const handoffReasons: Record<string, number> = {};
  const noAnswerInputs: string[] = [];
  const lowConfidence: Array<{ q: string; conf: number }> = [];
  for (const r of runs as any[]) {
    const meta = (r.metadata || {}) as any;
    const topics: string[] = meta?.topics || meta?.detectedTopics?.map?.((t: any) => t.slug) || [];
    for (const t of topics) topicTally[t] = (topicTally[t] || 0) + 1;
    if (r.status === 'handoff') {
      const reason = r.skip_reason || meta?.handoffReason || 'unspecified';
      handoffReasons[reason] = (handoffReasons[reason] || 0) + 1;
    }
    if (r.status === 'no_answer' && r.input_text) noAnswerInputs.push(r.input_text);
    if (typeof r.confidence === 'number' && r.confidence < 0.4 && r.input_text) {
      lowConfidence.push({ q: r.input_text, conf: r.confidence });
    }
  }
  const topTopics = Object.entries(topicTally).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topReasons = Object.entries(handoffReasons).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const cards = [
    { label: 'Runs (24h)', value: c?.aiRuns24h ?? 0 },
    { label: 'Replies (24h)', value: c?.replies24h ?? 0 },
    { label: 'Handoffs (24h)', value: c?.handoffs24h ?? 0 },
    { label: 'No answer (24h)', value: c?.noAnswer24h ?? 0 },
    { label: 'Total runs (30d)', value: s.total },
    { label: 'Lang. repairs (24h)', value: c?.outputLanguageRepairs24h ?? 0 },
    { label: 'Pending learning', value: c?.pendingLearningCandidates ?? 0 },
    { label: 'Embedded chunks', value: c?.embeddedChunks ?? 0 },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
          <BarChart3 className="h-5 w-5 text-primary" /> Analytics
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5">
          AI Agent activity, handoff reasons, top topics, and learning signals.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {cards.map((card) => (
          <Card key={card.label}><CardContent className="p-4">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p className="text-2xl font-semibold mt-1 tabular-nums">{card.value}</p>
          </CardContent></Card>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top detected topics</CardTitle>
            <CardDescription>From recent AI runs.</CardDescription>
          </CardHeader>
          <CardContent>
            {topTopics.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No topic data yet.</p>
            ) : (
              <div className="space-y-1.5">
                {topTopics.map(([slug, count]) => (
                  <div key={slug} className="flex items-center justify-between text-sm">
                    <span className="truncate">{slug}</span>
                    <Badge variant="secondary">{count}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Handoff reasons</CardTitle></CardHeader>
          <CardContent>
            {topReasons.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No handoffs yet.</p>
            ) : (
              <div className="space-y-1.5">
                {topReasons.map(([reason, count]) => (
                  <div key={reason} className="flex items-center justify-between text-sm">
                    <span className="truncate">{reason}</span>
                    <Badge variant="outline">{count}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">No-answer questions</CardTitle>
            <CardDescription>Recent visitor questions the agent could not answer.</CardDescription>
          </CardHeader>
          <CardContent>
            {noAnswerInputs.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No no-answer questions recorded.</p>
            ) : (
              <div className="space-y-1">
                {noAnswerInputs.slice(0, 8).map((q, i) => (
                  <p key={i} className="text-xs truncate text-foreground">• {q}</p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Low-confidence questions</CardTitle></CardHeader>
          <CardContent>
            {lowConfidence.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No low-confidence answers.</p>
            ) : (
              <div className="space-y-1">
                {lowConfidence.slice(0, 8).map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <Badge variant="outline" className="shrink-0">{(r.conf * 100).toFixed(0)}%</Badge>
                    <span className="truncate">{r.q}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Recent runs</CardTitle></CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No runs yet. Try the Playground.</p>
          ) : (
            <div className="divide-y">
              {runs.slice(0, 30).map((r: any) => (
                <div key={r.id} className="py-2.5 flex items-start gap-3 text-sm">
                  <Badge variant="outline" className="shrink-0">{r.run_type}</Badge>
                  <Badge variant="secondary" className="shrink-0">{r.status}</Badge>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-foreground">{r.input_text || <span className="text-muted-foreground">—</span>}</p>
                    {r.output_text && <p className="truncate text-xs text-muted-foreground mt-0.5">{r.output_text}</p>}
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">{new Date(r.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}