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
import { useTranslation } from '@/i18n';

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
  const { t } = useTranslation();
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
      toast({ title: t('admin.aiAgentControl.saved' as any), description: t('admin.aiAgentControl.savedDescription' as any) });
    },
    onError: (e: any) => {
      toast({ title: t('admin.aiAgentControl.saveFailed' as any), description: e?.message || t('admin.aiAgentControl.unableToSave' as any), variant: 'destructive' });
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
          <p className="text-sm text-destructive">{t('admin.aiAgentControl.loadFailed' as any)}</p>
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
          <h1 className="text-2xl font-semibold tracking-tight">{t('admin.aiAgentControl.title' as any)}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('admin.aiAgentControl.subtitle' as any)}</p>
        </div>
        <Button
          onClick={() => update.mutate(draft)}
          disabled={!dirty || update.isPending}
        >
          {update.isPending ? <Loader2 className="h-4 w-4 me-2 animate-spin" /> : <Save className="h-4 w-4 me-2" />}
          {t('admin.aiAgentControl.saveChanges' as any)}
        </Button>
      </div>

      <Section icon={Power} title={t('admin.aiAgentControl.killSwitch.title' as any)} description={t('admin.aiAgentControl.killSwitch.description' as any)}>
        <Toggle
          label={t('admin.aiAgentControl.killSwitch.enabled' as any)}
          description={t('admin.aiAgentControl.killSwitch.enabledHint' as any)}
          checked={merged.ai_agent_enabled}
          onChange={(v) => set('ai_agent_enabled', v)}
        />
        <Toggle
          label={t('admin.aiAgentControl.killSwitch.navigation' as any)}
          description={t('admin.aiAgentControl.killSwitch.navigationHint' as any)}
          checked={merged.customer_ai_agent_visible}
          onChange={(v) => set('customer_ai_agent_visible', v)}
          disabled={killSwitchOff}
        />
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">{t('admin.aiAgentControl.killSwitch.disabledMessage' as any)}</Label>
          <Textarea
            value={merged.disabled_message ?? ''}
            onChange={(e) => set('disabled_message', e.target.value || null)}
            placeholder={t('admin.aiAgentControl.killSwitch.disabledMessagePlaceholder' as any)}
            rows={3}
          />
        </div>
      </Section>

      <Section icon={Sparkles} title={t('admin.aiAgentControl.customer.title' as any)} description={t('admin.aiAgentControl.customer.description' as any)}>
        <Toggle
          label={t('admin.aiAgentControl.customer.operatorAssist' as any)}
          checked={merged.operator_assist_enabled}
          onChange={(v) => set('operator_assist_enabled', v)}
          disabled={killSwitchOff}
        />
        <Toggle
          label={t('admin.aiAgentControl.customer.autoAnswer' as any)}
          checked={merged.auto_answer_enabled}
          onChange={(v) => set('auto_answer_enabled', v)}
          disabled={killSwitchOff}
        />
        <Toggle
          label={t('admin.aiAgentControl.customer.learning' as any)}
          checked={merged.learning_enabled}
          onChange={(v) => set('learning_enabled', v)}
          disabled={killSwitchOff}
        />
        <Toggle label={t('admin.aiAgentControl.customer.files' as any)} checked={merged.files_enabled} onChange={(v) => set('files_enabled', v)} disabled={killSwitchOff} />
        <Toggle label={t('admin.aiAgentControl.customer.websites' as any)} checked={merged.websites_enabled} onChange={(v) => set('websites_enabled', v)} disabled={killSwitchOff} />
        <Toggle label={t('admin.aiAgentControl.customer.qna' as any)} checked={merged.qna_enabled} onChange={(v) => set('qna_enabled', v)} disabled={killSwitchOff} />
        <Toggle label={t('admin.aiAgentControl.customer.knowledgeBase' as any)} checked={merged.kb_enabled} onChange={(v) => set('kb_enabled', v)} disabled={killSwitchOff} />
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">{t('admin.aiAgentControl.customer.maxNavItems' as any)}</Label>
          <Input
            type="number"
            min={1}
            max={20}
            value={merged.max_customer_visible_nav_items}
            onChange={(e) => set('max_customer_visible_nav_items', Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
          />
        </div>
      </Section>

      <Section icon={Wrench} title={t('admin.aiAgentControl.advanced.title' as any)} description={t('admin.aiAgentControl.advanced.description' as any)}>
        <Toggle
          label={t('admin.aiAgentControl.advanced.enabled' as any)}
          description={t('admin.aiAgentControl.advanced.enabledHint' as any)}
          checked={merged.advanced_tools_enabled}
          onChange={(v) => set('advanced_tools_enabled', v)}
        />
        <Toggle
          label={t('admin.aiAgentControl.advanced.regression' as any)}
          checked={merged.regression_runner_enabled}
          onChange={(v) => set('regression_runner_enabled', v)}
          disabled={!merged.advanced_tools_enabled}
        />
        <Toggle
          label={t('admin.aiAgentControl.advanced.sourceHealth' as any)}
          checked={merged.source_health_visible_to_customers}
          onChange={(v) => set('source_health_visible_to_customers', v)}
          disabled={!merged.advanced_tools_enabled}
        />
        <Toggle
          label={t('admin.aiAgentControl.advanced.testHarness' as any)}
          checked={merged.test_harness_visible_to_customers}
          onChange={(v) => set('test_harness_visible_to_customers', v)}
          disabled={!merged.advanced_tools_enabled}
        />
      </Section>

      <Card className="p-4 border-amber-500/30 bg-amber-500/5 flex items-start gap-3">
        <ShieldAlert className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
        <div className="text-xs text-muted-foreground">
          {t('admin.aiAgentControl.adminNotice' as any)}
        </div>
      </Card>
    </div>
  );
}
