import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Activity, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

type Filter = 'all' | 'answered' | 'suggested' | 'handoff' | 'no_answer' | 'needs_review';

const FILTERS: Filter[] = ['all', 'answered', 'suggested', 'handoff', 'no_answer', 'needs_review'];

function describeKey(run: any): { key: 'suggested' | 'handoff' | 'no_answer' | 'blocked' | 'answered' | 'unknown'; tone: string } {
  const action = run.action || run.status;
  if (run.run_type === 'operator_assist' || action === 'suggested') return { key: 'suggested', tone: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30' };
  if (action === 'handoff') return { key: 'handoff', tone: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30' };
  if (action === 'no_answer' || action === 'no-answer') return { key: 'no_answer', tone: 'bg-muted text-muted-foreground border-border' };
  if (action === 'blocked' || action === 'failed' || action === 'error' || action === 'errored') return { key: 'blocked', tone: 'bg-destructive/10 text-destructive border-destructive/40' };
  if (action === 'answer' || action === 'answered' || action === 'success') return { key: 'answered', tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30' };
  return { key: 'unknown', tone: 'bg-muted text-muted-foreground border-border' };
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
  const { t, dir } = useTranslation();
  const tr = (k: string, fb: string) => {
    const v = t(`aiAgent.activity.${k}` as any);
    return !v || v === `aiAgent.activity.${k}` ? fb : v;
  };

  const runs = useQuery({
    queryKey: ['ai-activity', workspace?.id],
    queryFn: () => aiAgentApi.getRuns(workspace!.id, 100),
    enabled: !!workspace?.id,
    staleTime: 15_000,
  });

  const filtered = useMemo(() => (runs.data?.runs || []).filter((r: any) => matchesFilter(r, filter)), [runs.data, filter]);

  return (
    <div className="space-y-8" dir={dir}>
      <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6 sm:p-8">
        <div className="pointer-events-none absolute -top-16 -end-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -start-10 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-primary to-primary/60 shadow-lg shadow-primary/30 flex items-center justify-center shrink-0">
              <Activity className="h-6 w-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{tr('title', 'Activity')}</h1>
              <p className="text-sm text-muted-foreground mt-1.5 max-w-xl">{tr('subtitle', 'Recent AI Agent activity in this workspace.')}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => runs.refetch()} disabled={runs.isFetching} className="self-start sm:self-auto">
            <RefreshCw className={cn('h-3.5 w-3.5 me-1.5', runs.isFetching && 'animate-spin')} />{tr('refresh', 'Refresh')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'text-xs px-4 py-2 rounded-full border font-medium transition-all',
              filter === f
                ? 'bg-primary text-primary-foreground border-primary shadow-md shadow-primary/20'
                : 'border-border bg-card hover:bg-accent hover:border-primary/30',
            )}
          >
            {tr(`filter.${f}`, f)}
          </button>
        ))}
      </div>

      <Card className="border-border/60">
        <CardContent className="p-4">
          {runs.isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground py-12 text-center italic">{tr('empty', 'No activity yet.')}</p>
          ) : (
            <div className="space-y-1">
              {filtered.slice(0, 100).map((r: any) => {
                const d = describeKey(r);
                return (
                  <div key={r.id} className="flex items-center gap-3 py-2.5 px-2 -mx-2 rounded-md border-b border-border/40 last:border-b-0 hover:bg-accent/30 transition-colors">
                    <Badge variant="outline" className={`text-[10px] shrink-0 ${d.tone}`}>{tr(`describe.${d.key}`, d.key)}</Badge>
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