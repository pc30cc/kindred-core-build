import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import {
  LayoutDashboard, AlertTriangle, CheckCircle2, AlertCircle, Loader2,
  RefreshCw, Plus, Globe, Beaker, GraduationCap, Tags, Workflow,
} from 'lucide-react';
import TestAiPanel from './TestAiPanel';

const SEVERITY_STYLES: Record<string, string> = {
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  error: 'border-destructive/40 bg-destructive/10 text-destructive',
};

export default function OverviewPage() {
  const { workspace } = useActiveWorkspace();
  const wsId = workspace?.id;
  const wsPath = useWorkspacePath();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();

  const overview = useQuery({
    queryKey: ['ai-overview', wsId],
    queryFn: () => aiAgentApi.getOverview(wsId!),
    enabled: !!wsId,
    staleTime: 15_000,
  });

  const rebuild = useMutation({
    mutationFn: () => aiAgentApi.rebuildKnowledgeIndex(wsId!),
    onSuccess: () => { toast({ title: 'Knowledge index rebuilt' }); qc.invalidateQueries({ queryKey: ['ai-overview', wsId] }); },
    onError: (e: any) => toast({ title: 'Rebuild failed', description: e?.message, variant: 'destructive' }),
  });

  if (overview.isLoading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  const data = overview.data;
  if (!data) return <p className="text-sm text-muted-foreground">No data.</p>;
  const c = data.counts;
  const ready = data.settings.enabled && c.activeChunks > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <LayoutDashboard className="h-5 w-5 text-primary" /> Overview
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            Status, knowledge readiness, recent activity, and warnings for your AI Agent.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => overview.refetch()} disabled={overview.isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 me-1.5 ${overview.isFetching ? 'animate-spin' : ''}`} />Refresh
        </Button>
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Status" value={ready ? 'Ready' : 'Not ready'} icon={ready ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertCircle className="h-4 w-4 text-amber-500" />} />
        <Stat label="Mode" value={data.settings.mode} />
        <Stat label="Knowledge chunks" value={`${c.embeddedChunks}/${c.activeChunks}`} hint="embedded / active" />
        <Stat label="Q&A pairs" value={String(c.qna)} />
        <Stat label="Topics" value={String(c.topics)} />
        <Stat label="Workflows" value={String(c.workflows)} />
        <Stat label="Triggers" value={String(c.messageTriggers)} />
        <Stat label="Tools" value={String(c.tools)} />
      </div>

      {/* Last 24h */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Stat label="AI runs (24h)" value={String(c.aiRuns24h)} />
        <Stat label="Replies" value={String(c.replies24h)} />
        <Stat label="Handoffs" value={String(c.handoffs24h)} />
        <Stat label="No answer" value={String(c.noAnswer24h)} />
        <Stat label="Lang. repairs" value={String(c.outputLanguageRepairs24h)} />
      </div>

      {/* Warnings */}
      {data.warnings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" /> Warnings & notices</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.warnings.map((w) => (
              <div key={w.code} className={`rounded-md border px-3 py-2 text-sm ${SEVERITY_STYLES[w.severity] || ''}`}>
                {w.message}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Quick actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick actions</CardTitle>
          <CardDescription>Most common next steps for your AI Agent.</CardDescription>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          <QuickButton icon={RefreshCw} label="Rebuild knowledge index" onClick={() => rebuild.mutate()} loading={rebuild.isPending} />
          <QuickButton icon={Plus} label="Add Q&A" onClick={() => navigate(wsPath('/ai-agent/qna'))} />
          <QuickButton icon={Globe} label="Add web page source" onClick={() => navigate(wsPath('/ai-agent/web-pages'))} />
          <QuickButton icon={Beaker} label="Test AI Agent" onClick={() => navigate(wsPath('/ai-agent/playground'))} />
          <QuickButton icon={GraduationCap} label="Review learning candidates" onClick={() => navigate(wsPath('/ai-agent/qna'))} />
          <QuickButton icon={Tags} label="Add default topics" onClick={() => navigate(wsPath('/ai-agent/topics'))} />
          <QuickButton icon={Workflow} label="Create workflow" onClick={() => navigate(wsPath('/ai-agent/workflow'))} />
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">Recent AI runs</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {data.recentRuns.length === 0 ? (
              <p className="text-xs text-muted-foreground">No recent activity.</p>
            ) : data.recentRuns.slice(0, 10).map((r) => (
              <div key={r.id} className="flex items-start gap-2 text-xs py-1.5 border-b last:border-b-0">
                <Badge variant="outline" className="text-[10px] shrink-0">{r.status || '—'}</Badge>
                <span className="text-muted-foreground shrink-0">{r.run_type || ''}</span>
                <span className="flex-1 truncate">{r.input_text || ''}</span>
                <span className="tabular-nums text-muted-foreground shrink-0">{new Date(r.created_at).toLocaleTimeString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Recent sync logs</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {data.recentSyncLogs.length === 0 ? (
              <p className="text-xs text-muted-foreground">No syncs yet.</p>
            ) : data.recentSyncLogs.map((l) => (
              <div key={l.id} className="flex items-start gap-2 text-xs py-1.5 border-b last:border-b-0">
                <Badge variant="outline" className="text-[10px] shrink-0">{l.status}</Badge>
                <span className="flex-1 truncate">{l.message || `pages: ${l.pages_found}, chunks: ${l.chunks_created}`}</span>
                <span className="tabular-nums text-muted-foreground shrink-0">{new Date(l.created_at).toLocaleTimeString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <TestAiPanel />
    </div>
  );
}

function Stat({ label, value, icon, hint }: { label: string; value: string; icon?: React.ReactNode; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{label}</p>
          {icon}
        </div>
        <p className="text-xl font-semibold mt-1 tabular-nums">{value}</p>
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function QuickButton({ icon: Icon, label, onClick, loading }: { icon: any; label: string; onClick: () => void; loading?: boolean }) {
  return (
    <Button variant="outline" className="justify-start h-auto py-2.5" onClick={onClick} disabled={loading}>
      {loading ? <Loader2 className="h-4 w-4 me-2 animate-spin" /> : <Icon className="h-4 w-4 me-2 text-primary" />}
      <span className="text-sm">{label}</span>
    </Button>
  );
}