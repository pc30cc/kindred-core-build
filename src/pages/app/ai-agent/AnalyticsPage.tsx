import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentAnalytics, useAiAgentRuns } from '@/hooks/useAiAgent';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BarChart3, Loader2 } from 'lucide-react';

export default function AnalyticsPage() {
  const { workspace } = useActiveWorkspace();
  const { data: stats, isLoading: l1 } = useAiAgentAnalytics(workspace?.id);
  const { data: runsData, isLoading: l2 } = useAiAgentRuns(workspace?.id);

  if (l1 || l2) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const runs = runsData?.runs || [];
  const totals = stats?.totals || { total: 0, replied: 0, suggested: 0, handoff: 0, no_answer: 0, failed: 0, skipped: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
          <BarChart3 className="h-5 w-5 text-primary" /> Analytics
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5">
          Playground tests and (in Phase 2) live AI Agent runs across this workspace.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total runs', value: totals.total },
          { label: 'Replied', value: totals.replied },
          { label: 'Handoff', value: totals.handoff },
          { label: 'No answer', value: totals.no_answer },
        ].map((s) => (
          <Card key={s.label}><CardContent className="p-4">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className="text-2xl font-semibold mt-1">{s.value}</p>
          </CardContent></Card>
        ))}
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