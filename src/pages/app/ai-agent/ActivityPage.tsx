import { memo, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Activity, BarChart3, ChevronLeft, ChevronRight, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/date';

type Filter = 'all' | 'answered' | 'suggested' | 'handoff' | 'no_answer' | 'needs_review';

const FILTERS: Filter[] = ['all', 'answered', 'suggested', 'handoff', 'no_answer', 'needs_review'];
const PAGE_SIZES = [20, 50, 100, 200];
const PAGE_SIZE_KEY = 'ai-activity-page-size';

function describeKey(run: any): { key: 'suggested' | 'handoff' | 'no_answer' | 'blocked' | 'answered' | 'unknown'; tone: string } {
  const action = run.action || run.status;
  if (run.run_type === 'operator_assist' || action === 'suggested') return { key: 'suggested', tone: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30' };
  if (action === 'handoff') return { key: 'handoff', tone: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30' };
  if (action === 'no_answer' || action === 'no-answer' || action === 'skipped') return { key: 'no_answer', tone: 'bg-muted text-muted-foreground border-border' };
  if (action === 'blocked' || action === 'failed' || action === 'error' || action === 'errored') return { key: 'blocked', tone: 'bg-destructive/10 text-destructive border-destructive/40' };
  if (action === 'answer' || action === 'answered' || action === 'replied' || action === 'success') return { key: 'answered', tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30' };
  return { key: 'unknown', tone: 'bg-muted text-muted-foreground border-border' };
}

const RunRow = memo(function RunRow({ run, label }: { run: any; label: string }) {
  const d = describeKey(run);
  return (
    <div className="flex items-center gap-3 py-2.5 px-2 -mx-2 rounded-md border-b border-border/40 last:border-b-0 hover:bg-accent/30 transition-colors">
      <Badge variant="outline" className={`text-[10px] shrink-0 ${d.tone}`}>{label}</Badge>
      <span className="text-sm flex-1 truncate text-muted-foreground">{run.input_text || ''}</span>
      <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
        {run.created_at ? formatDateTime(run.created_at) : ''}
      </span>
    </div>
  );
});

export default function ActivityPage() {
  const { workspace } = useActiveWorkspace();
  const navigate = useNavigate();
  const wsPath = useWorkspacePath();
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(() => {
    const stored = Number(typeof window !== 'undefined' ? window.localStorage.getItem(PAGE_SIZE_KEY) : '');
    return PAGE_SIZES.includes(stored) ? stored : 20;
  });
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const { t, dir } = useTranslation();
  const tr = (k: string, fb: string, params?: Record<string, string>) => {
    const v = t(`aiAgent.activity.${k}` as any, params);
    return !v || v.includes(`aiAgent.activity.${k}`) ? fb : v;
  };

  // Debounced search — avoids a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 350);
    return () => clearTimeout(id);
  }, [searchInput]);

  const runs = useQuery({
    queryKey: ['ai-activity', workspace?.id, filter, search, page, pageSize],
    queryFn: () => aiAgentApi.getRunsPaged(workspace!.id, { page, pageSize, filter, search }),
    enabled: !!workspace?.id,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const items = runs.data?.runs || [];
  const total = runs.data?.total ?? 0;
  const totalPages = runs.data?.totalPages ?? 1;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = total === 0 ? 0 : Math.min((page - 1) * pageSize + items.length, total);

  // Keep the current page valid when the size changes or rows disappear.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const labels = useMemo(() => ({
    suggested: tr('describe.suggested', 'suggested'),
    handoff: tr('describe.handoff', 'handoff'),
    no_answer: tr('describe.no_answer', 'no answer'),
    blocked: tr('describe.blocked', 'blocked'),
    answered: tr('describe.answered', 'answered'),
    unknown: tr('describe.unknown', 'activity'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [t]);

  return (
    <div className="space-y-8" dir={dir}>
      <AiPageHeader
        icon={Activity}
        accent="sky"
        title={tr('title', 'Activity')}
        subtitle={tr('subtitle', 'Recent AI Agent activity in this workspace.')}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate(wsPath('/ai-agent/analytics'))}>
              <BarChart3 className="h-3.5 w-3.5 me-1.5" />{tr('viewAnalytics', 'View analytics')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => runs.refetch()} disabled={runs.isFetching}>
              <RefreshCw className={cn('h-3.5 w-3.5 me-1.5', runs.isFetching && 'animate-spin')} />{tr('refresh', 'Refresh')}
            </Button>
          </>
        }
      />

      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <Select
          value={String(pageSize)}
          onValueChange={(v) => {
            const n = Number(v);
            setPageSize(n);
            setPage(1);
            try { window.localStorage.setItem(PAGE_SIZE_KEY, String(n)); } catch { /* ignore */ }
          }}
        >
          <SelectTrigger className="w-full lg:w-40" aria-label={tr('perPage', 'Per page')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((n) => (
              <SelectItem key={n} value={String(n)}>{`${n} / ${tr('perPage', 'Per page')}`}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap gap-2 flex-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => { setFilter(f); setPage(1); }}
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
        <div className="relative w-full lg:w-72">
          <Search className="absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={tr('search', 'Search activity…')}
            aria-label={tr('searchHint', 'Search visitor messages')}
            className="ps-9 pe-9"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput('')}
              aria-label={tr('clear', 'Clear')}
              className="absolute top-1/2 -translate-y-1/2 end-2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <Card className="border-border/60">
        <CardContent className="p-4">
          {runs.isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-12 text-center italic">
              {search || filter !== 'all' ? tr('noResults', 'No activity matched your search.') : tr('empty', 'No activity yet.')}
            </p>
          ) : (
            <div className={cn('space-y-1 transition-opacity', runs.isFetching && 'opacity-60')}>
              {items.map((r: any) => (
                <RunRow key={r.id} run={r} label={labels[describeKey(r).key]} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {total > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {tr('showing', `Showing ${from}–${to} of ${total}`, { from: String(from), to: String(to), total: String(total) })}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1 || runs.isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <ChevronLeft className={cn('h-4 w-4 me-1', dir === 'rtl' && 'rotate-180')} />{tr('prev', 'Previous')}
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums px-1">
              {tr('page', `Page ${page} of ${totalPages}`, { page: String(page), pages: String(totalPages) })}
            </span>
            <Button variant="outline" size="sm" disabled={page >= totalPages || runs.isFetching} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              {tr('next', 'Next')}<ChevronRight className={cn('h-4 w-4 ms-1', dir === 'rtl' && 'rotate-180')} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
