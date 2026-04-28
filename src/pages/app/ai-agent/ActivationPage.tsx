import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentDiagnostics, useAiAgentSettings, useUpdateAiAgentSettings } from '@/hooks/useAiAgent';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Check, X, Loader2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

function CheckRow({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b last:border-0">
      <div className={`h-5 w-5 rounded-full flex items-center justify-center shrink-0 ${ok ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'}`}>
        {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      </div>
      <div className="flex-1">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
    </div>
  );
}

export default function ActivationPage() {
  const { workspace } = useActiveWorkspace();
  const { data: diag, isLoading } = useAiAgentDiagnostics(workspace?.id);
  const { data: settingsData } = useAiAgentSettings(workspace?.id);
  const update = useUpdateAiAgentSettings(workspace?.id);
  const settings = settingsData?.settings;

  if (isLoading || !diag || !settings) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const canEnable = diag.checks.ai_provider_configured && diag.checks.module_enabled && (!settings.answer_only_from_kb || diag.checks.has_knowledge);

  const onToggle = async (v: boolean) => {
    if (v && !canEnable) {
      toast.error('Resolve the checklist below before enabling.');
      return;
    }
    try {
      await update.mutateAsync({ enabled: v });
      toast.success(v ? 'AI Agent enabled' : 'AI Agent disabled');
    } catch (e: any) {
      toast.error(e?.message || 'Update failed');
    }
  };

  const onMode = async (mode: any) => {
    try {
      await update.mutateAsync({ mode });
      toast.success('Mode updated');
    } catch (e: any) {
      toast.error(e?.message || 'Update failed');
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activation</h1>
        <p className="text-sm text-muted-foreground mt-1">Control whether the AI Agent is active and how it replies.</p>
      </div>

      <Card>
        <CardContent className="p-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${settings.enabled ? 'bg-success/15' : 'bg-muted'}`}>
              <div className={`h-2.5 w-2.5 rounded-full ${settings.enabled ? 'bg-success' : 'bg-muted-foreground/40'}`} />
            </div>
            <div>
              <p className="font-semibold">{settings.enabled ? 'AI Agent is active' : 'AI Agent is disabled'}</p>
              <p className="text-xs text-muted-foreground">Mode: <Badge variant="outline" className="text-[10px]">{settings.mode}</Badge></p>
            </div>
          </div>
          <Switch checked={settings.enabled} onCheckedChange={onToggle} disabled={update.isPending} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Reply mode</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Label>Mode</Label>
          <Select value={settings.mode} onValueChange={onMode}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="suggest_only">Suggest only — operators see suggestions, no visitor replies</SelectItem>
              <SelectItem value="auto_reply_when_offline">Auto-reply when offline</SelectItem>
              <SelectItem value="auto_reply_until_human_joins">Auto-reply until a human joins</SelectItem>
              <SelectItem value="auto_reply_always">Auto-reply always</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Auto-reply will only answer from published Knowledge Base articles. If unsure, it hands off to a human.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Readiness checklist</CardTitle></CardHeader>
        <CardContent>
          <CheckRow ok={diag.checks.ai_provider_configured} label="AI provider configured" hint={diag.provider ? `${diag.provider.name} • ${diag.provider.model}` : 'Set up an AI provider in admin or workspace providers'} />
          <CheckRow ok={diag.checks.has_knowledge} label="Published knowledge available" hint={`${diag.knowledge.published} published articles, ${diag.knowledge.qna_count} Q&A pairs`} />
          <CheckRow ok={diag.checks.module_enabled} label="Module enabled" hint="Plan grants the ai_assistant module" />
        </CardContent>
      </Card>

      {!canEnable && (
        <div className="flex items-start gap-2.5 rounded-md bg-warning/10 border border-warning/30 px-4 py-3 text-sm">
          <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
          <p>Resolve the checklist items above before enabling the AI Agent.</p>
        </div>
      )}
    </div>
  );
}