import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Activity, Loader2, RefreshCw } from 'lucide-react';

type Filter = 'all' | 'answered' | 'suggested' | 'handoff' | 'no_answer' | 'needs_review';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'answered', label: 'Answered' },
  { key: 'suggested', label: 'Suggested' },
  { key: 'handoff', label: 'Handoff' },
  { key: 'no_answer', label: 'No answer' },
  { key: 'needs_review', label: 'Needs review' },
];

function describe(run: any): { label: string; tone: string } {
  const action = run.action || run.status;
  if (run.run_type === 'operator_assist' || action === 'suggested') return { label: 'AI suggested reply to operator', tone: 'bg-sky-500/10 text-sky-700 dark:text-sky-300' };
  if (action === 'handoff') return { label: 'AI transferred to operator', tone: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' };
  if (action === 'no_answer' || action === 'no-answer') return { label: 'AI did not answer (low confidence)', tone: 'bg-muted text-muted-foreground' };
  if (action === 'blocked' || action === 'failed' || action === 'error' || action === 'errored') return { label: 'AI could not answer (knowledge issue)', tone: 'bg-destructive/10 text-destructive' };
  if (action === 'answer' || action === 'answered' || action === 'success') return { label: 'AI answered visitor', tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' };
  return { label: action || run.run_type || 'AI activity', tone: 'bg-muted text-muted-foreground' };
}

function matchesFilter(run: any, f: Filter): boolean {
  if (f === 'all') return true;
  const a = run.action || run.status;
  if (f === 'answered') return a === 'answer' || a === 'answered' || a === 'success';
  if (f === 'suggested') return run.run_type === 'operator_assist' || a === 'suggested';
  if (f === 'handoff') return a === 'handoff';
  if (f === 'no_answer') return a === 'no_answer' || a === 'no-answer';
  if (f === 'needs_review') return a === 'failed' || a === 'error' || a === 'errored' || a === 'blocked';
  return true;
}

export default function ActivityPage() {
  const { workspace } = useActiveWorkspace();
  const [filter, setFilter] = useState<Filter>('all');

  const runs = useQuery({
    queryKey: ['ai-activity', workspace?.id],
    queryFn: () => aiAgentApi.getRuns(workspace!.id, 100),
    enabled: !!workspace?.id,
    staleTime: 15_000,
  });

  const filtered = useMemo(() => (runs.data?.runs || []).filter((r: any) => matchesFilter(r, filter)), [runs.data, filter]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Activity className="h-5 w-5 text-primary" /> Activity
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">Recent AI Agent activity in this workspace.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => runs.refetch()} disabled={runs.isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 me-1.5 ${runs.isFetching ? 'animate-spin' : ''}`} />Refresh
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`text-xs px-3 py-1.5 rounded-full border transition ${filter === f.key ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent'}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-4">
          {runs.isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No activity yet.</p>
          ) : (
            <div className="space-y-1">
              {filtered.slice(0, 100).map((r: any) => {
                const d = describe(r);
                return (
                  <div key={r.id} className="flex items-center gap-3 py-2 border-b last:border-b-0">
                    <Badge variant="outline" className={`text-[10px] shrink-0 ${d.tone}`}>{d.label}</Badge>
                    <span className="text-sm flex-1 truncate text-muted-foreground">{r.input_text || ''}</span>
                    <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                      {r.created_at ? new Date(r.created_at).toLocaleString() : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}