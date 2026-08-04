import { useEffect, useState } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentSettings, useUpdateAiAgentSettings } from '@/hooks/useAiAgent';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Loader2, Sliders, MessageSquare, HelpCircle, FileText, Heart, Languages } from 'lucide-react';
import { toast } from '@/lib/toast';
import type { AgentMode, AnswerGuidance } from '@/lib/ai-agent-api';
import { useTranslation } from '@/i18n';

type AiMode = 'auto' | 'suggest' | 'off';
type Unsure = 'clarify' | 'transfer' | 'silent';
type Style = 'short' | 'medium' | 'long';
type Tone = 'friendly' | 'formal' | 'professional';
type Lang = 'visitor' | 'workspace';

function deriveAiMode(s: any): AiMode {
  if (!s) return 'off';
  if (!s.enabled || s.mode === 'off') return 'off';
  if (s.mode === 'suggest_only') return 'suggest';
  return 'auto';
}
function deriveUnsure(s: any): Unsure {
  if (s?.allow_clarifying_questions) return 'clarify';
  if (s?.handoff_on_low_confidence) return 'transfer';
  return 'silent';
}
function deriveStyle(s: any): Style {
  return (s?.instructions?.max_answer_length as Style) || 'medium';
}
function deriveTone(s: any): Tone {
  const t = (s?.instructions?.tone || '').toLowerCase();
  if (t.includes('formal')) return 'formal';
  if (t.includes('professional')) return 'professional';
  return 'friendly';
}
function deriveLang(s: any): Lang {
  return (s?.allowed_locales?.length || 0) > 0 ? 'workspace' : 'visitor';
}

export default function BehaviorPage() {
  const { workspace } = useActiveWorkspace();
  const { data, isLoading } = useAiAgentSettings(workspace?.id);
  const update = useUpdateAiAgentSettings(workspace?.id);
  const { t, dir } = useTranslation();
  const tr = (k: string, fb: string) => {
    const v = t(`aiAgent.behavior.${k}` as any);
    return !v || v === `aiAgent.behavior.${k}` ? fb : v;
  };

  const [aiMode, setAiMode] = useState<AiMode>('off');
  const [unsure, setUnsure] = useState<Unsure>('clarify');
  const [style, setStyle] = useState<Style>('medium');
  const [tone, setTone] = useState<Tone>('friendly');
  const [lang, setLang] = useState<Lang>('visitor');

  useEffect(() => {
    const s = data?.settings;
    if (!s) return;
    setAiMode(deriveAiMode(s));
    setUnsure(deriveUnsure(s));
    setStyle(deriveStyle(s));
    setTone(deriveTone(s));
    setLang(deriveLang(s));
  }, [data]);

  if (isLoading || !data?.settings) {
    return <div className="flex justify-center py-20" dir={dir}><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const onSave = async () => {
    const s = data.settings;
    const mode: AgentMode =
      aiMode === 'off' ? 'off' :
      aiMode === 'suggest' ? 'suggest_only' :
      'auto_reply_until_human_joins';
    try {
      await update.mutateAsync({
        enabled: aiMode !== 'off',
        mode,
        allow_clarifying_questions: unsure === 'clarify',
        handoff_on_low_confidence: unsure === 'transfer',
        fallback_behavior: unsure === 'silent' ? 'silent' : 'handoff',
        instructions: {
          ...(s.instructions || {}),
          max_answer_length: style,
          tone,
        } as any,
        allowed_locales: lang === 'workspace' && (workspace as any)?.default_locale
          ? [(workspace as any).default_locale]
          : [],
      } as any);
      toast.success(tr('saved', 'Behavior saved'));
    } catch (e: any) {
      toast.error(e?.message || tr('saveFailed', 'Save failed'));
    }
  };

  return (
    <div className="space-y-8" dir={dir}>
      <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6 sm:p-8">
        <div className="pointer-events-none absolute -top-16 -end-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -start-10 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex items-start gap-4">
          <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-primary to-primary/60 shadow-lg shadow-primary/30 flex items-center justify-center shrink-0">
            <Sliders className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{tr('title', 'Behavior')}</h1>
            <p className="text-sm text-muted-foreground mt-1.5 max-w-xl">{tr('subtitle', 'Choose how your AI Agent talks to visitors.')}</p>
          </div>
        </div>
      </div>

      <SectionCard icon={MessageSquare} tone="bg-violet-500/10 text-violet-600 ring-violet-500/20" title={tr('aiMode.title', 'AI mode')} desc={tr('aiMode.desc', 'How the AI participates in conversations.')}>
        <RadioGroup dir={dir} value={aiMode} onValueChange={(v) => setAiMode(v as AiMode)} className="space-y-2">
          <Opt value="auto" label={tr('aiMode.auto', 'Answer visitors automatically')} />
          <Opt value="suggest" label={tr('aiMode.suggest', 'Suggest replies to operators only')} />
          <Opt value="off" label={tr('aiMode.off', 'Off')} />
        </RadioGroup>
      </SectionCard>

      <SectionCard icon={HelpCircle} tone="bg-amber-500/10 text-amber-600 ring-amber-500/20" title={tr('unsure.title', 'When AI is unsure')}>
        <RadioGroup dir={dir} value={unsure} onValueChange={(v) => setUnsure(v as Unsure)} className="space-y-2">
          <Opt value="clarify" label={tr('unsure.clarify', 'Ask a clarification question')} />
          <Opt value="transfer" label={tr('unsure.transfer', 'Transfer to operator')} />
          <Opt value="silent" label={tr('unsure.silent', 'Do not answer')} />
        </RadioGroup>
      </SectionCard>

      <div className="grid md:grid-cols-3 gap-4">
        <SectionCard icon={FileText} tone="bg-sky-500/10 text-sky-600 ring-sky-500/20" title={tr('style.title', 'Answer style')}>
          <RadioGroup dir={dir} value={style} onValueChange={(v) => setStyle(v as Style)} className="space-y-2">
            <Opt value="short" label={tr('style.short', 'Short')} />
            <Opt value="medium" label={tr('style.medium', 'Balanced')} />
            <Opt value="long" label={tr('style.long', 'Detailed')} />
          </RadioGroup>
        </SectionCard>
        <SectionCard icon={Heart} tone="bg-rose-500/10 text-rose-600 ring-rose-500/20" title={tr('tone.title', 'Tone')}>
          <RadioGroup dir={dir} value={tone} onValueChange={(v) => setTone(v as Tone)} className="space-y-2">
            <Opt value="friendly" label={tr('tone.friendly', 'Friendly')} />
            <Opt value="formal" label={tr('tone.formal', 'Formal')} />
            <Opt value="professional" label={tr('tone.professional', 'Professional')} />
          </RadioGroup>
        </SectionCard>
        <SectionCard icon={Languages} tone="bg-emerald-500/10 text-emerald-600 ring-emerald-500/20" title={tr('lang.title', 'Language')}>
          <RadioGroup dir={dir} value={lang} onValueChange={(v) => setLang(v as Lang)} className="space-y-2">
            <Opt value="visitor" label={tr('lang.visitor', 'Reply in visitor language')} />
            <Opt value="workspace" label={tr('lang.workspace', 'Always use workspace default language')} />
          </RadioGroup>
        </SectionCard>
      </div>

      <div className="flex justify-end">
        <Button onClick={onSave} disabled={update.isPending} size="lg" className="shadow-lg shadow-primary/20">
          {update.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />}{tr('save', 'Save behavior')}
        </Button>
      </div>
    </div>
  );
}

function SectionCard({ icon: Icon, tone, title, desc, children }: { icon: any; tone: string; title: string; desc?: string; children: React.ReactNode }) {
  return (
    <Card className="overflow-hidden border-border/60 hover:shadow-md transition-shadow">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2.5">
          <span className={`h-8 w-8 rounded-lg flex items-center justify-center ring-1 ${tone}`}>
            <Icon className="h-4 w-4" />
          </span>
          {title}
        </CardTitle>
        {desc && <CardDescription className="mt-1">{desc}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Opt({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border/40 px-3 py-2.5 hover:border-primary/40 hover:bg-accent/30 transition-colors cursor-pointer has-[:checked]:border-primary/60 has-[:checked]:bg-primary/5">
      <RadioGroupItem value={value} id={`opt-${value}`} />
      <Label htmlFor={`opt-${value}`} className="text-sm font-normal cursor-pointer flex-1">{label}</Label>
    </div>
  );
}