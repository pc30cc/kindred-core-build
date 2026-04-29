import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentDiagnostics, useAiAgentKnowledgeStatus } from '@/hooks/useAiAgent';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LayoutDashboard, CheckCircle2, AlertCircle, Bot } from 'lucide-react';

export default function OverviewPage() {
  const ws = useCurrentWorkspace() as any;
  const wsId = ws?.id as string | undefined;
  const { data: diag } = useAiAgentDiagnostics(wsId);
  const { data: ks } = useAiAgentKnowledgeStatus(wsId);

  const ready = !!diag?.ready;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
          <LayoutDashboard className="h-5 w-5 text-primary" /> Overview
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
          Quick status of your AI Agent — readiness, knowledge, and recent activity.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Status" value={ready ? 'Ready' : 'Not ready'}
          icon={ready ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertCircle className="h-4 w-4 text-amber-500" />} />
        <Stat label="Mode" value={diag?.checks?.mode || '—'} icon={<Bot className="h-4 w-4 text-primary" />} />
        <Stat label="Knowledge articles" value={String(ks?.published ?? 0)} />
        <Stat label="Q&A pairs" value={String(ks?.qna_count ?? 0)} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">Automated inbox</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="AI managed" value={diag?.automated_inbox?.ai_managed ?? 0} />
            <Row label="Needs human" value={diag?.automated_inbox?.needs_human ?? 0} />
            <Row label="Human active" value={diag?.automated_inbox?.human_active ?? 0} />
            {diag?.automated_inbox?.last_handoff_reason && (
              <p className="text-xs text-muted-foreground pt-2">
                Last handoff reason: <span className="text-foreground">{diag.automated_inbox.last_handoff_reason}</span>
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Recent runs</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {(diag?.recent_runs || []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No recent activity.</p>
            ) : (
              (diag?.recent_runs || []).map((r) => (
                <div key={r.id} className="flex items-center gap-2 text-xs">
                  <Badge variant="outline" className="text-[10px]">{r.status || '—'}</Badge>
                  <span className="text-muted-foreground">{r.run_type || ''}</span>
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    {r.created_at ? new Date(r.created_at).toLocaleTimeString() : ''}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{label}</p>
          {icon}
        </div>
        <p className="text-xl font-semibold mt-1">{value}</p>
      </CardContent>
    </Card>
  );
}
function Row({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}