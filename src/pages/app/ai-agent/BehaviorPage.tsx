import { useEffect, useState } from 'react';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentSettings, useUpdateAiAgentSettings } from '@/hooks/useAiAgent';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Loader2, Sliders } from 'lucide-react';
import { toast } from 'sonner';
import type { AgentMode, AnswerGuidance } from '@/lib/ai-agent-api';

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
    return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
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
      toast.success('Behavior saved');
    } catch (e: any) {
      toast.error(e?.message || 'Save failed');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
          <Sliders className="h-5 w-5 text-primary" /> Behavior
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5">Choose how your AI Agent talks to visitors.</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">AI mode</CardTitle><CardDescription>How the AI participates in conversations.</CardDescription></CardHeader>
        <CardContent>
          <RadioGroup value={aiMode} onValueChange={(v) => setAiMode(v as AiMode)} className="space-y-2">
            <Opt value="auto" label="Answer visitors automatically" />
            <Opt value="suggest" label="Suggest replies to operators only" />
            <Opt value="off" label="Off" />
          </RadioGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">When AI is unsure</CardTitle></CardHeader>
        <CardContent>
          <RadioGroup value={unsure} onValueChange={(v) => setUnsure(v as Unsure)} className="space-y-2">
            <Opt value="clarify" label="Ask a clarification question" />
            <Opt value="transfer" label="Transfer to operator" />
            <Opt value="silent" label="Do not answer" />
          </RadioGroup>
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Answer style</CardTitle></CardHeader>
          <CardContent>
            <RadioGroup value={style} onValueChange={(v) => setStyle(v as Style)} className="space-y-2">
              <Opt value="short" label="Short" />
              <Opt value="medium" label="Balanced" />
              <Opt value="long" label="Detailed" />
            </RadioGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Tone</CardTitle></CardHeader>
          <CardContent>
            <RadioGroup value={tone} onValueChange={(v) => setTone(v as Tone)} className="space-y-2">
              <Opt value="friendly" label="Friendly" />
              <Opt value="formal" label="Formal" />
              <Opt value="professional" label="Professional" />
            </RadioGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Language</CardTitle></CardHeader>
          <CardContent>
            <RadioGroup value={lang} onValueChange={(v) => setLang(v as Lang)} className="space-y-2">
              <Opt value="visitor" label="Reply in visitor language" />
              <Opt value="workspace" label="Always use workspace default language" />
            </RadioGroup>
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end">
        <Button onClick={onSave} disabled={update.isPending}>
          {update.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />}Save behavior
        </Button>
      </div>
    </div>
  );
}

function Opt({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-center space-x-2 rtl:space-x-reverse">
      <RadioGroupItem value={value} id={`opt-${value}`} />
      <Label htmlFor={`opt-${value}`} className="text-sm font-normal cursor-pointer">{label}</Label>
    </div>
  );
}