import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useWorkspacePath } from '@/hooks/useWorkspace';

export default function RunInspectorPage() {
  const { id } = useParams<{ id: string }>();
  const wsPath = useWorkspacePath();
  const q = useQuery({
    queryKey: ['ai-agent', 'inspect', id],
    queryFn: () => aiAgentApi.inspectRun(id!),
    enabled: !!id,
  });

  if (q.isLoading) return <div className="p-6 text-muted-foreground">Loading run…</div>;
  if (q.isError || !q.data) return <div className="p-6 text-destructive">Failed to load run.</div>;
  const d = q.data;

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Answer Inspector</h1>
        <Link to={`${wsPath}/ai-agent/analytics`} className="text-sm text-muted-foreground hover:underline">← Back to analytics</Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Run
            <Badge variant="outline">{d.run.status}</Badge>
            <Badge variant="secondary">{d.run.run_type}</Badge>
            {typeof d.run.confidence === 'number' && <Badge>conf {d.run.confidence.toFixed(2)}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div><span className="text-muted-foreground">Visitor:</span> <pre className="whitespace-pre-wrap">{d.visitor_message?.body || d.run.input_text || '—'}</pre></div>
          <div><span className="text-muted-foreground">AI reply:</span> <pre className="whitespace-pre-wrap">{d.ai_message?.body || d.run.output_text || '—'}</pre></div>
          <div className="text-xs text-muted-foreground">{d.run.provider} · {d.run.model} · {new Date(d.run.created_at).toLocaleString()}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Answer strategy</CardTitle></CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted/30 p-3 rounded overflow-auto">{JSON.stringify(d.answer_strategy, null, 2)}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Page context</CardTitle></CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted/30 p-3 rounded overflow-auto">{JSON.stringify(d.page_context, null, 2)}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Selected sources</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="text-xs w-full">
              <thead><tr className="text-left text-muted-foreground"><th>Type</th><th>Title</th><th>URL</th><th>Final</th><th>kw</th><th>vec</th><th>Used</th></tr></thead>
              <tbody>
                {(d.selected_sources || []).map((s: any, i: number) => (
                  <tr key={i} className="border-t border-border/50">
                    <td className="py-1 pr-2"><Badge variant="outline">{s.source_type}</Badge></td>
                    <td className="py-1 pr-2 max-w-[280px] truncate">{s.title}</td>
                    <td className="py-1 pr-2 max-w-[200px] truncate">{s.source_url || '—'}</td>
                    <td className="py-1 pr-2">{(s.final_score ?? s.score).toFixed(3)}</td>
                    <td className="py-1 pr-2">{(s.keyword_score ?? 0).toFixed(2)}</td>
                    <td className="py-1 pr-2">{(s.vector_score ?? 0).toFixed(2)}</td>
                    <td className="py-1 pr-2">{s.included_in_prompt ? 'yes' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Decision timeline</CardTitle></CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted/30 p-3 rounded overflow-auto">{JSON.stringify(d.decision_timeline, null, 2)}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Prompt preview</CardTitle></CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted/30 p-3 rounded overflow-auto">{d.prompt_preview ? JSON.stringify(d.prompt_preview, null, 2) : 'Not stored for this run.'}</pre>
        </CardContent>
      </Card>

      {d.safety_notes?.length ? (
        <Card>
          <CardHeader><CardTitle>Safety notes</CardTitle></CardHeader>
          <CardContent><ul className="text-xs list-disc pl-4">{d.safety_notes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul></CardContent>
        </Card>
      ) : null}
    </div>
  );
}