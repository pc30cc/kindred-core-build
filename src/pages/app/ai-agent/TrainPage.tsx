import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import {
  Database, AlertTriangle, RefreshCw, Plus, Globe, FileText,
  MessageCircleQuestion, GraduationCap, Loader2, ShieldCheck, ShieldX,
} from 'lucide-react';

const SEVERITY: Record<string, string> = {
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  error: 'border-destructive/40 bg-destructive/10 text-destructive',
};

const TYPE_LABEL: Record<string, string> = {
  website: 'Web pages', web_page: 'Web pages', kb_article: 'KB articles',
  qna: 'Q&A', learned_qna: 'Learned Q&A', file: 'Files',
  business_profile: 'Business profile', snippet: 'Snippets',
};

export default function TrainPage() {
  const { workspace } = useActiveWorkspace();
  const wsId = workspace?.id;
  const wsPath = useWorkspacePath();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();

  const overview = useQuery({
    queryKey: ['ai-train-overview', wsId],
    queryFn: () => aiAgentApi.getTrainOverview(wsId!),
    enabled: !!wsId,
    staleTime: 15_000,
  });

  const rebuild = useMutation({
    mutationFn: () => aiAgentApi.rebuildKnowledgeIndex(wsId!),
    onSuccess: (r) => {
      toast({ title: 'Index rebuilt', description: `${r.embeddingsGenerated} embeddings · ${r.sourcesProcessed} sources` });
      qc.invalidateQueries({ queryKey: ['ai-train-overview', wsId] });
    },
    onError: (e: any) => toast({ title: 'Rebuild failed', description: e?.message, variant: 'destructive' }),
  });

  if (overview.isLoading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  const data = overview.data;
  if (!data) return <p className="text-sm text-muted-foreground">No data.</p>;
  const c = data.counts;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Database className="h-5 w-5 text-primary" /> Data Hub
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            All trainable knowledge sources, sync status, and the live retrieval index.
            Only active and approved sources are used by the AI Agent at runtime.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => overview.refetch()} disabled={overview.isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 me-1.5 ${overview.isFetching ? 'animate-spin' : ''}`} />Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Total sources" value={String(c.totalSources)} hint={`${c.activeSources} active`} />
        <Stat label="Active chunks" value={String(c.activeChunks)} hint={`${c.embeddedChunks} embedded`} />
        <Stat label="Q&A" value={`${c.qnaEnabled}/${c.qnaEnabled + c.qnaDisabled}`} hint="enabled / total" />
        <Stat label="KB articles" value={`${c.kbPublished}/${c.kbPublished + c.kbDraft}`} hint="published / total" />
        <Stat label="Failed sources" value={String(c.failedSources)} />
        <Stat label="Failed embeddings" value={String(c.failedEmbeddings)} />
        <Stat label="Pending learning" value={String(c.learningPending)} />
        <Stat label="Last sync" value={data.lastSyncAt ? new Date(data.lastSyncAt).toLocaleString() : '—'} />
      </div>

      {data.warnings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" /> Warnings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.warnings.map((w, i) => (
              <div key={`${w.code}-${i}`} className={`rounded-md border px-3 py-2 text-sm ${SEVERITY[w.severity] || ''}`}>
                {w.message}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick actions</CardTitle>
          <CardDescription>Common training tasks.</CardDescription>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          <Action icon={MessageCircleQuestion} label="Add Q&A" onClick={() => navigate(wsPath('/ai-agent/qna'))} />
          <Action icon={Globe} label="Add web page source" onClick={() => navigate(wsPath('/ai-agent/web-pages'))} />
          <Action icon={FileText} label="Upload file" onClick={() => navigate(wsPath('/ai-agent/files'))} />
          <Action icon={GraduationCap} label="Review learning candidates" onClick={() => navigate(wsPath('/ai-agent/learning-candidates'))} />
          <Action icon={RefreshCw} label="Rebuild knowledge index" onClick={() => rebuild.mutate()} loading={rebuild.isPending} />
          <Action icon={Plus} label="Open Overview" onClick={() => navigate(wsPath('/ai-agent/overview'))} />
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">Sources by type</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {data.sourcesByType.length === 0 ? (
              <p className="text-xs text-muted-foreground">No sources yet.</p>
            ) : data.sourcesByType.map((s) => (
              <div key={s.source_type} className="flex items-center gap-2 text-sm py-1.5 border-b last:border-b-0">
                <Badge variant="outline" className="text-[10px] shrink-0">{TYPE_LABEL[s.source_type] || s.source_type}</Badge>
                <span className="flex-1 text-xs text-muted-foreground">{s.active} active · {s.paused} paused · {s.failed} failed</span>
                <span className="tabular-nums text-xs">{s.total}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Recent sync logs</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {data.recentSyncLogs.length === 0 ? (
              <p className="text-xs text-muted-foreground">No syncs yet.</p>
            ) : data.recentSyncLogs.slice(0, 8).map((l: any) => (
              <div key={l.id} className="flex items-start gap-2 text-xs py-1.5 border-b last:border-b-0">
                <Badge variant="outline" className="text-[10px] shrink-0">{l.status}</Badge>
                <span className="flex-1 truncate">{l.message || `pages: ${l.pages_found}, chunks: ${l.chunks_created}`}</span>
                <span className="tabular-nums text-muted-foreground shrink-0">{new Date(l.created_at).toLocaleTimeString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-500" /> Retrieval safety contract
          </CardTitle>
          <CardDescription>What the runtime is allowed (and not allowed) to read for AI answers.</CardDescription>
        </CardHeader>
        <CardContent className="grid md:grid-cols-2 gap-4 text-xs">
          <div>
            <p className="font-medium text-emerald-700 dark:text-emerald-400 mb-1.5 flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Allowed</p>
            <ul className="space-y-1 text-muted-foreground list-disc list-inside">
              {data.retrievalContract.allowed.map((s) => <li key={s}>{s}</li>)}
            </ul>
          </div>
          <div>
            <p className="font-medium text-destructive mb-1.5 flex items-center gap-1.5"><ShieldX className="h-3.5 w-3.5" /> Blocked</p>
            <ul className="space-y-1 text-muted-foreground list-disc list-inside">
              {data.retrievalContract.blocked.map((s) => <li key={s}>{s}</li>)}
            </ul>
          </div>
        </CardContent>
      </Card>

      {data.knowledgeIndex && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Knowledge index</CardTitle>
            <CardDescription>
              Embedding provider: <span className="font-mono">{data.knowledgeIndex.embeddingProvider || 'noop'}</span>
              {' · '}model: <span className="font-mono">{data.knowledgeIndex.embeddingModel || '—'}</span>
              {' · '}available: {data.knowledgeIndex.embeddingProviderAvailable ? 'yes' : 'no'}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {Object.entries(data.knowledgeIndex.bySourceType).length === 0 ? 'No indexed chunks yet.' : (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(data.knowledgeIndex.bySourceType).map(([k, v]) => (
                  <Badge key={k} variant="outline" className="text-[10px]">{TYPE_LABEL[k] || k}: {v}</Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold mt-1 tabular-nums">{value}</p>
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function Action({ icon: Icon, label, onClick, loading }: { icon: any; label: string; onClick: () => void; loading?: boolean }) {
  return (
    <Button variant="outline" className="justify-start h-auto py-2.5" onClick={onClick} disabled={loading}>
      {loading ? <Loader2 className="h-4 w-4 me-2 animate-spin" /> : <Icon className="h-4 w-4 me-2 text-primary" />}
      <span className="text-sm">{label}</span>
    </Button>
  );
}