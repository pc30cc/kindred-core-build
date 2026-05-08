import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CheckCircle2, AlertTriangle, ShieldAlert, RefreshCw, Loader2 } from 'lucide-react';

const REASON_LABEL: Record<string, string> = {
  eligible: 'Eligible',
  no_active_chunks: 'No active chunks',
  disabled_qna: 'Q&A disabled',
  candidate_not_approved: 'Candidate not approved',
  draft_kb: 'KB draft',
  file_not_active: 'File not active',
  website_not_active: 'Website not active',
  source_missing: 'Source missing',
  embedding_missing: 'Embedding missing',
  unknown: 'Unknown',
};

export default function SourceHealthPage() {
  const { workspace } = useActiveWorkspace();
  const wsId = workspace?.id;
  const [sourceType, setSourceType] = useState<string>('');
  const [eligible, setEligible] = useState<string>('');
  const [query, setQuery] = useState('');

  const q = useQuery({
    queryKey: ['ai-agent', 'source-health', wsId, sourceType, eligible, query],
    queryFn: () => aiAgentApi.getSourceHealth(wsId!, {
      sourceType: sourceType || undefined,
      eligible: eligible === 'true' ? true : eligible === 'false' ? false : undefined,
      query: query || undefined,
      limit: 500,
    }),
    enabled: !!wsId,
  });

  const items = (q.data?.items || []) as any[];
  const summary = q.data?.summary || {};

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-primary" /> Source Health
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Which knowledge sources are eligible for runtime retrieval — and why.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 me-1.5 ${q.isFetching ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Eligible" value={summary.eligible || 0} accent="ok" />
        <Stat label="Not eligible" value={summary.not_eligible || 0} accent="warn" />
        <Stat label="Active chunks" value={summary.active_chunks_total || 0} />
        <Stat label="Embedded chunks" value={summary.embedded_chunks_total || 0} />
        <Stat label="Q&A enabled / disabled" value={`${summary.qna_enabled || 0} / ${summary.qna_disabled || 0}`} />
        <Stat label="Learned approved / unapproved" value={`${summary.learned_qna_approved || 0} / ${summary.learned_qna_unapproved || 0}`} />
        <Stat label="Files active / not" value={`${summary.files_active || 0} / ${summary.files_not_active || 0}`} />
        <Stat label="Websites active / not" value={`${summary.websites_active || 0} / ${summary.websites_not_active || 0}`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-4 gap-2">
          <select value={sourceType} onChange={(e) => setSourceType(e.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
            <option value="">All types</option>
            <option value="qna">Q&A</option>
            <option value="learned_qna">Learned Q&A</option>
            <option value="kb_article">KB article</option>
            <option value="file">File</option>
            <option value="website">Website</option>
            <option value="web_page">Web page</option>
          </select>
          <select value={eligible} onChange={(e) => setEligible(e.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
            <option value="">All eligibility</option>
            <option value="true">Eligible only</option>
            <option value="false">Not eligible</option>
          </select>
          <Input placeholder="Search title…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 sm:col-span-2" />
        </CardContent>
      </Card>

      {q.isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">No sources match these filters.</CardContent></Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="text-xs w-full">
              <thead className="bg-muted/40">
                <tr className="text-left">
                  <th className="py-2 px-3">Type</th>
                  <th className="py-2 px-3">Title</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3">Eligibility</th>
                  <th className="py-2 px-3">Reason</th>
                  <th className="py-2 px-3 text-right">Active</th>
                  <th className="py-2 px-3 text-right">Embedded</th>
                  <th className="py-2 px-3">Last indexed</th>
                  <th className="py-2 px-3">Last error</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={`${it.source_type}:${it.source_id}`} className="border-t border-border/40">
                    <td className="py-2 px-3"><Badge variant="outline">{it.source_type}</Badge></td>
                    <td className="py-2 px-3 max-w-[280px] truncate" title={it.title}>{it.title}</td>
                    <td className="py-2 px-3">{it.status || '—'}</td>
                    <td className="py-2 px-3">
                      {it.eligible
                        ? <Badge className="gap-1"><CheckCircle2 className="h-3 w-3" /> Eligible</Badge>
                        : <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" /> Not eligible</Badge>}
                    </td>
                    <td className="py-2 px-3" title={it.reason}>{REASON_LABEL[it.reason] || it.reason}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{it.active_chunks_count}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{it.embedded_chunks_count}</td>
                    <td className="py-2 px-3">{it.last_indexed_at ? new Date(it.last_indexed_at).toLocaleString() : '—'}</td>
                    <td className="py-2 px-3 text-destructive max-w-[220px] truncate" title={it.last_error || ''}>{it.last_error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: 'ok' | 'warn' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-xl font-semibold mt-1 tabular-nums ${accent === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : accent === 'warn' ? 'text-amber-600 dark:text-amber-400' : ''}`}>{value}</p>
      </CardContent>
    </Card>
  );
}