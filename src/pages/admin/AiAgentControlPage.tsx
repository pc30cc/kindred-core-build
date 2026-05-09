/**
 * E12 — Super Admin AI Agent Control Center.
 * Single source of truth for the platform-wide AI Agent kill switch,
 * advanced/QA/regression visibility, and per-feature toggles.
 * Backend access is enforced by the advanced-tools guard middleware
 * in server/routes/aiAgent.ts (admin-only).
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save, Power, ShieldAlert, Sparkles, Wrench } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/hooks/use-toast';
import { aiAgentApi, type PlatformAiAgentSettings } from '@/lib/ai-agent-api';

type Patch = Partial<PlatformAiAgentSettings>;

function Section({
  icon: Icon, title, description, children,
}: { icon: any; title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description && (
            <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          )}
        </div>
      </div>
      <Separator />
      <div className="space-y-3">{children}</div>
    </Card>
  );
}

function Toggle({
  label, description, checked, onChange, disabled,
}: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="min-w-0">
        <Label className="text-sm font-medium">{label}</Label>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

export default function AiAgentControlPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-ai-agent-platform-settings'],
    queryFn: () => aiAgentApi.getPlatformSettings(),
    staleTime: 10_000,
  });
  const [draft, setDraft] = useState<Patch>({});

  useEffect(() => {
    setDraft({});
  }, [data?.settings.id, data?.settings.updated_at]);

  const merged: PlatformAiAgentSettings | null = useMemo(() => {
    if (!data?.settings) return null;
    return { ...data.settings, ...draft } as PlatformAiAgentSettings;
  }, [data?.settings, draft]);

  const update = useMutation({
    mutationFn: (patch: Patch) => aiAgentApi.updatePlatformSettings(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-ai-agent-platform-settings'] });
      qc.invalidateQueries({ queryKey: ['ai-agent-capabilities'] });
      setDraft({});
      toast({ title: 'Saved', description: 'Platform AI Agent settings updated.' });
    },
    onError: (e: any) => {
      toast({ title: 'Save failed', description: e?.message || 'Unable to save', variant: 'destructive' });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !merged) {
    return (
      <div className="p-6">
        <Card className="p-6 border-destructive/40">
          <p className="text-sm text-destructive">Failed to load platform AI Agent settings.</p>
          <p className="text-xs text-muted-foreground mt-1">{(error as any)?.message}</p>
        </Card>
      </div>
    );
  }

  const set = <K extends keyof PlatformAiAgentSettings>(k: K, v: PlatformAiAgentSettings[K]) =>
    setDraft(prev => ({ ...prev, [k]: v }));

  const dirty = Object.keys(draft).length > 0;
  const killSwitchOff = !merged.ai_agent_enabled;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI Agent Control Center</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Platform-wide controls for the AI Agent feature. Changes apply to every workspace.
          </p>
        </div>
        <Button
          onClick={() => update.mutate(draft)}
          disabled={!dirty || update.isPending}
        >
          {update.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          Save changes
        </Button>
      </div>

      <Section icon={Power} title="Kill switch" description="Globally enable or disable the AI Agent product across the platform.">
        <Toggle
          label="AI Agent enabled"
          description="When off, customer-facing AI Agent endpoints reject requests with ai_agent_platform_disabled."
          checked={merged.ai_agent_enabled}
          onChange={(v) => set('ai_agent_enabled', v)}
        />
        <Toggle
          label="Show AI Agent in workspace navigation"
          description="Hides the AI Agent section from every workspace sidebar without disabling backend endpoints."
          checked={merged.customer_ai_agent_visible}
          onChange={(v) => set('customer_ai_agent_visible', v)}
          disabled={killSwitchOff}
        />
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Disabled message (optional)</Label>
          <Textarea
            value={merged.disabled_message ?? ''}
            onChange={(e) => set('disabled_message', e.target.value || null)}
            placeholder="Shown to operators when AI Agent is disabled (kept generic; never reveal internals)."
            rows={3}
          />
        </div>
      </Section>

      <Section icon={Sparkles} title="Customer features" description="Per-feature toggles surfaced in the customer-facing UI.">
        <Toggle
          label="Operator Assist"
          checked={merged.operator_assist_enabled}
          onChange={(v) => set('operator_assist_enabled', v)}
          disabled={killSwitchOff}
        />
        <Toggle
          label="Auto-answer"
          checked={merged.auto_answer_enabled}
          onChange={(v) => set('auto_answer_enabled', v)}
          disabled={killSwitchOff}
        />
        <Toggle
          label="Learning"
          checked={merged.learning_enabled}
          onChange={(v) => set('learning_enabled', v)}
          disabled={killSwitchOff}
        />
        <Toggle label="Files knowledge" checked={merged.files_enabled} onChange={(v) => set('files_enabled', v)} disabled={killSwitchOff} />
        <Toggle label="Website knowledge" checked={merged.websites_enabled} onChange={(v) => set('websites_enabled', v)} disabled={killSwitchOff} />
        <Toggle label="Q&A knowledge" checked={merged.qna_enabled} onChange={(v) => set('qna_enabled', v)} disabled={killSwitchOff} />
        <Toggle label="Knowledge base knowledge" checked={merged.kb_enabled} onChange={(v) => set('kb_enabled', v)} disabled={killSwitchOff} />
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Max customer-visible nav items</Label>
          <Input
            type="number"
            min={1}
            max={20}
            value={merged.max_customer_visible_nav_items}
            onChange={(e) => set('max_customer_visible_nav_items', Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
          />
        </div>
      </Section>

      <Section icon={Wrench} title="Advanced & QA tools" description="Internal QA, debug, regression and source-health surfaces. Customers see nothing here unless explicitly enabled.">
        <Toggle
          label="Advanced tools enabled"
          description="Master switch for any advanced/QA visibility toggle below."
          checked={merged.advanced_tools_enabled}
          onChange={(v) => set('advanced_tools_enabled', v)}
        />
        <Toggle
          label="Regression runner visible to customers"
          checked={merged.regression_runner_enabled}
          onChange={(v) => set('regression_runner_enabled', v)}
          disabled={!merged.advanced_tools_enabled}
        />
        <Toggle
          label="Source health visible to customers"
          checked={merged.source_health_visible_to_customers}
          onChange={(v) => set('source_health_visible_to_customers', v)}
          disabled={!merged.advanced_tools_enabled}
        />
        <Toggle
          label="Test harness visible to customers"
          checked={merged.test_harness_visible_to_customers}
          onChange={(v) => set('test_harness_visible_to_customers', v)}
          disabled={!merged.advanced_tools_enabled}
        />
      </Section>

      <Card className="p-4 border-amber-500/30 bg-amber-500/5 flex items-start gap-3">
        <ShieldAlert className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
        <div className="text-xs text-muted-foreground">
          Global super admins always retain access to advanced AI tools regardless of these toggles.
          Customer toggles only affect non-admin workspace users.
        </div>
      </Card>
    </div>
  );
}