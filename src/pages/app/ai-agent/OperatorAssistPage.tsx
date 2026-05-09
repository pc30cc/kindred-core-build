import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentSettings, useUpdateAiAgentSettings } from '@/hooks/useAiAgent';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

export default function OperatorAssistPage() {
  const { workspace } = useActiveWorkspace();
  const wsId = workspace?.id;
  const { data, isLoading } = useAiAgentSettings(wsId);
  const update = useUpdateAiAgentSettings(wsId);

  const [enabled, setEnabled] = useState(false);
  const [allowInsert, setAllowInsert] = useState(true);
  const [allowRegen, setAllowRegen] = useState(true);
  const [showSources, setShowSources] = useState(true);

  useEffect(() => {
    const s = data?.settings as any;
    if (!s) return;
    setEnabled(s.mode === 'suggest_only' || s.allow_suggestions_after_takeover === true || s.show_sources_to_operator === true);
    setAllowInsert(true);
    setAllowRegen(true);
    setShowSources(!!s.show_sources_to_operator);
  }, [data]);

  const analytics = useQuery({
    queryKey: ['assist-analytics', wsId],
    queryFn: () => aiAgentApi.getAssistAnalytics(wsId!, '7d'),
    enabled: !!wsId,
    staleTime: 60_000,
  });

  if (isLoading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const onSave = async () => {
    try {
      await update.mutateAsync({
        show_sources_to_operator: showSources,
        allow_suggestions_after_takeover: enabled,
      } as any);
      toast.success('Operator Assist saved');
    } catch (e: any) {
      toast.error(e?.message || 'Save failed');
    }
  };

  const sum = analytics.data?.summary;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
          <Sparkles className="h-5 w-5 text-primary" /> Operator Assist
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5">
          Help your operators reply faster with AI suggestions. Suggestions are inserted into the composer — never sent automatically.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Settings</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <Row label="Enable Operator Assist" value={enabled} onChange={setEnabled} />
          <Row label="Allow agents to insert suggestions" value={allowInsert} onChange={setAllowInsert} />
          <Row label="Allow agents to regenerate suggestions" value={allowRegen} onChange={setAllowRegen} />
          <Row label="Show source used for suggestion" value={showSources} onChange={setShowSources} />
          <div className="flex justify-end pt-2">
            <button
              onClick={onSave}
              disabled={update.isPending}
              className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {update.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Save
            </button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent usage (7 days)</CardTitle>
          <CardDescription>How operators are using AI suggestions.</CardDescription>
        </CardHeader>
        <CardContent>
          {analytics.isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : sum ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Suggestions" value={String(sum.total_suggestions || 0)} />
              <Stat label="Acceptance" value={`${Math.round((sum.acceptance_rate || 0) * 100)}%`} />
              <Stat label="Positive" value={String(sum.positive || 0)} />
              <Stat label="Negative" value={String(sum.negative || 0)} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No usage data yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-sm font-normal">{label}</Label>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums mt-1">{value}</p>
    </div>
  );
}