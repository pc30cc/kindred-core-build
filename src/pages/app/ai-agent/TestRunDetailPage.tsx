import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';

export default function TestRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const wsPath = useWorkspacePath();
  const q = useQuery({
    queryKey: ['ai-agent', 'test-run', id],
    queryFn: () => aiAgentApi.getTestRun(id!),
    enabled: !!id,
  });

  if (q.isLoading) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (q.isError || !q.data) return <div className="p-6 text-destructive">Failed to load run.</div>;

  const run = q.data.item;
  const tc = q.data.test_case;
  const meta = (run.metadata || {}) as any;
  const safetyNotes: string[] = meta.safety_notes || [];
  const runtime = (run as any).runtime || meta.runtime || null;
  const aiRunId = (run as any).ai_agent_run_id;

  const debugUrl = wsPath(`/ai-agent/debug/retrieval`);

  const statusVariant = run.status === 'passed' ? 'default' : run.status === 'failed' ? 'destructive' : 'secondary';

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <div className="flex items-center gap-3">
        <Link to={wsPath('/ai-agent/test-cases')}>
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1"/> Back to Test Cases</Button>
        </Link>
      </div>

      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Test Run</h1>
        <Badge variant={statusVariant as any}>{run.status}</Badge>
        {run.confidence != null && <span className="text-sm text-muted-foreground">conf {Number(run.confidence).toFixed(2)}</span>}
      </div>

      <Card>
        <CardHeader><CardTitle>Input</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-2">
          <div className="rounded bg-muted/30 p-3 whitespace-pre-wrap">{run.input_message}</div>
          {tc && (
            <div className="text-xs text-muted-foreground">
              From test case: <span className="font-medium text-foreground">{tc.name}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Expected vs Actual</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div className="space-y-1">
            <h3 className="text-xs font-medium text-muted-foreground">Expected</h3>
            <div>Behavior: <Badge variant="outline">{tc?.expected_behavior || '—'}</Badge></div>
            <div>Source type: <Badge variant="outline">{tc?.expected_source_type || 'any'}</Badge></div>
            <div>Source ID: <code className="text-xs">{tc?.expected_source_id || '—'}</code></div>
            <div>Source URL: <code className="text-xs break-all">{tc?.expected_source_url || '—'}</code></div>
            <div>Min confidence: {tc?.min_confidence ?? '—'}</div>
            {(tc?.expected_contains?.length || 0) > 0 && (
              <div>Contains: {(tc!.expected_contains || []).map((s, i) => <Badge key={i} variant="secondary" className="mr-1">{s}</Badge>)}</div>
            )}
            {(tc?.expected_not_contains?.length || 0) > 0 && (
              <div>Not contains: {(tc!.expected_not_contains || []).map((s, i) => <Badge key={i} variant="outline" className="mr-1">{s}</Badge>)}</div>
            )}
          </div>
          <div className="space-y-1">
            <h3 className="text-xs font-medium text-muted-foreground">Actual</h3>
            <div>Status: <Badge variant="outline">{run.actual_status || '—'}</Badge></div>
            <div className="rounded bg-muted/30 p-2 text-xs whitespace-pre-wrap min-h-[60px]">{run.actual_output || '(no output)'}</div>
            {run.failure_reasons?.length ? (
              <div className="text-xs text-destructive">
                <div className="font-medium mb-0.5">Failure reasons</div>
                <ul className="list-disc pl-5">{run.failure_reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Selected sources</CardTitle></CardHeader>
        <CardContent>
          {!run.selected_sources?.length ? (
            <div className="text-sm text-muted-foreground">No sources selected.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead><tr className="text-left text-muted-foreground"><th>Type</th><th>Title</th><th>URL</th><th>Score</th></tr></thead>
                <tbody>
                  {(run.selected_sources as any[]).map((s, i) => (
                    <tr key={i} className="border-t border-border/50">
                      <td className="py-1 pr-2"><Badge variant="outline">{s.source_type}</Badge></td>
                      <td className="py-1 pr-2 max-w-[280px] truncate" title={s.title}>{s.title}</td>
                      <td className="py-1 pr-2 max-w-[220px] truncate">{s.source_url || '—'}</td>
                      <td className="py-1 pr-2">{Number(s.final_score || s.score || 0).toFixed(3)}</td>
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
          <CardHeader><CardTitle>Runtime side effects</CardTitle></CardHeader>
          <CardContent>
            <pre className="text-xs bg-muted/30 p-3 rounded overflow-auto">{JSON.stringify(runtime, null, 2)}</pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Answer strategy</CardTitle></CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted/30 p-3 rounded overflow-auto">{JSON.stringify(run.answer_strategy, null, 2)}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Retrieval debug</CardTitle></CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted/30 p-3 rounded overflow-auto max-h-[400px]">{JSON.stringify(run.retrieval_debug, null, 2)}</pre>
        </CardContent>
      </Card>

      {safetyNotes.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Safety notes</CardTitle></CardHeader>
          <CardContent className="text-xs">
            <ul className="list-disc pl-5">{safetyNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-3 pt-1">
        <Link
          className="text-primary hover:underline text-sm"
          to={`${debugUrl}?message=${encodeURIComponent(run.input_message)}`}
        >
          Open Retrieval Debugger (prefilled)
        </Link>
        {aiRunId && (
          <Link className="text-primary hover:underline text-sm" to={wsPath(`/ai-agent/runs/${aiRunId}`)}>
            Open Answer Inspector
          </Link>
        )}
      </div>
    </div>
  );
}