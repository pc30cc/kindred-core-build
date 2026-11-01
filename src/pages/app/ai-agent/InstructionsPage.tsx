import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentSettings, useUpdateAiAgentSettings } from '@/hooks/useAiAgent';
import { useTranslation, type TranslationKey } from '@/i18n';
import type { AgentSettings } from '@/lib/ai-agent-api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { ScrollText, Loader2, AlertTriangle, Info } from 'lucide-react';

type Instructions = AgentSettings['instructions'];

function errorText(e: unknown): string | undefined {
  return e instanceof Error ? e.message : undefined;
}

export default function InstructionsPage() {
  const ws = useCurrentWorkspace();
  const wsId = ws?.id;
  const { data, isLoading } = useAiAgentSettings(wsId);
  const update = useUpdateAiAgentSettings(wsId);
  const { t } = useTranslation();
  const tr = (k: string) => t(`aiAgent.instructions.${k}` as TranslationKey);
  // Newer copy, in English until every catalogue has it.
  const trf = (k: string, fallback: string) => {
    const v = tr(k);
    return !v || v === `aiAgent.instructions.${k}` ? fallback : v;
  };

  const i: Instructions = data?.settings?.instructions ?? {};
  // The saved custom instruction never reaches the browser
  // (server/services/ai-agent/customerSafe.ts), only whether there is one.
  const hasSavedCustomInstruction = data?.settings?.has_custom_system_instruction === true;
  const [form, setForm] = useState({
    brand_voice: '', business_description: '',
    do_list: '' as string,
    dont_list: '' as string,
    pricing_instructions: '', handoff_instructions: '', support_instructions: '',
    custom_system_instruction: '',
  });
  // Every nested `instructions` key on this page is only written when the
  // operator actually edited its control this session -- the backend
  // replaces the ENTIRE `instructions` JSON column on write (no server-side
  // per-key merge, except that a write without `custom_system_instruction`
  // keeps the saved one), so unconditionally resending all keys on every
  // save (as before) could silently revert a key changed elsewhere (e.g.
  // `tone`/`max_answer_length`, both owned exclusively by BehaviorPage --
  // this page no longer has a tone control at all, to avoid the two pages
  // fighting over the same instructions.tone field) back to whatever this
  // page had loaded, even when the operator only touched an unrelated field
  // here. Same dirty-tracking discipline as BehaviorPage.
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const markDirty = (key: string) => setDirty((prev) => {
    const next = new Set(prev);
    next.add(key);
    return next;
  });

  useEffect(() => {
    if (!data?.settings) return;
    setForm({
      brand_voice: i.brand_voice || '',
      // Canonical field is the top-level ai_agent_settings.business_description
      // (also owned/written by SettingsPage and the AI generator, and the only
      // one the runtime prompt reads). instructions.business_description is a
      // legacy persisted key, shown ONLY as a display fallback when the
      // canonical field is empty -- never given write precedence here.
      business_description: data.settings.business_description || i.business_description || '',
      do_list: (i.do_list || []).join('\n'),
      dont_list: (i.dont_list || []).join('\n'),
      pricing_instructions: i.pricing_instructions || '',
      handoff_instructions: i.handoff_instructions || i.escalation_instructions || '',
      support_instructions: i.support_instructions || '',
      // Never the saved custom instruction (the server does not send it):
      // empty, under a note, when one is saved; otherwise the legacy
      // custom_instructions text the prompt falls back to, if any.
      custom_system_instruction: data.settings.has_custom_system_instruction ? '' : (i.custom_instructions || ''),
    });
    setDirty(new Set());
    // eslint-disable-next-line
  }, [data?.settings?.id]);

  async function save() {
    const patch: Partial<AgentSettings> = {};

    // Canonical field: business_description is a top-level ai_agent_settings
    // column (same one SettingsPage and the AI generator write, and the only
    // one the runtime prompt reads). An explicit edit here writes it there --
    // never into the legacy nested instructions.business_description key, so
    // this page can no longer recreate the dual-write ownership conflict.
    const businessDescriptionDirty = dirty.has('business_description');
    if (businessDescriptionDirty) {
      patch.business_description = form.business_description;
    }

    // Skip resending `instructions` only when Business Description is the
    // ONLY dirty field -- there is no reason to rewrite the whole nested JSON
    // object (the backend replaces it wholesale on write) for a change that
    // is fully captured by the top-level business_description patch above.
    const nestedDirty = ['brand_voice', 'do_list', 'dont_list',
      'pricing_instructions', 'handoff_instructions', 'support_instructions',
      'custom_system_instruction'].some((k) => dirty.has(k));
    if (!(businessDescriptionDirty && !nestedDirty)) {
      // Merge base: the FRESHEST instructions object available at save time
      // (not a snapshot captured at mount), so keys this page doesn't own
      // (e.g. a concurrent BehaviorPage edit to tone/max_answer_length) are
      // preserved as-is. Only the keys the operator actually touched this
      // session are overlaid on top. The legacy business_description key, if
      // present, is carried over unchanged -- it is never written here.
      const fresh: Instructions = data?.settings?.instructions || {};
      const instructions: Instructions = { ...fresh };
      if (dirty.has('brand_voice')) instructions.brand_voice = form.brand_voice.trim() || undefined;
      if (dirty.has('do_list')) instructions.do_list = form.do_list.split('\n').map((s) => s.trim()).filter(Boolean);
      if (dirty.has('dont_list')) instructions.dont_list = form.dont_list.split('\n').map((s) => s.trim()).filter(Boolean);
      if (dirty.has('pricing_instructions')) instructions.pricing_instructions = form.pricing_instructions.trim() || undefined;
      if (dirty.has('handoff_instructions')) instructions.handoff_instructions = form.handoff_instructions.trim() || undefined;
      if (dirty.has('support_instructions')) instructions.support_instructions = form.support_instructions.trim() || undefined;
      if (dirty.has('custom_system_instruction')) {
        // Typed text replaces the saved instruction. An emptied field sends
        // nothing, so the saved one stays (Remove is the way to clear it).
        const text = form.custom_system_instruction.trim();
        if (text) instructions.custom_system_instruction = text;
        else delete instructions.custom_system_instruction;
      }
      patch.instructions = instructions;
    }

    try {
      await update.mutateAsync(patch);
      setDirty(new Set());
      toast({ title: tr('saved') });
    } catch (e: unknown) {
      toast({ title: tr('saveFailed'), description: errorText(e), variant: 'destructive' });
    }
  }

  async function removeCustomInstruction() {
    if (!window.confirm(trf('advanced.removeConfirm', 'Remove the saved custom instruction? The AI will stop using it.'))) return;
    const fresh: Instructions = data?.settings?.instructions || {};
    try {
      // Only this key changes; other unsaved edits on the page stay as they are.
      await update.mutateAsync({ instructions: { ...fresh, custom_system_instruction: '' } });
      setForm((f) => ({ ...f, custom_system_instruction: '' }));
      setDirty((prev) => {
        const next = new Set(prev);
        next.delete('custom_system_instruction');
        return next;
      });
      toast({ title: trf('advanced.removed', 'Custom instruction removed') });
    } catch (e: unknown) {
      toast({ title: tr('saveFailed'), description: errorText(e), variant: 'destructive' });
    }
  }

  if (!wsId) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
          <ScrollText className="h-5 w-5 text-primary" /> {tr('title')}
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
          {tr('subtitle')}
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">{tr('brandVoice.title')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>{tr('brandVoice.voiceDesc')}</Label>
                <Textarea rows={3} value={form.brand_voice}
                  onChange={(e) => { setForm((f) => ({ ...f, brand_voice: e.target.value })); markDirty('brand_voice'); }}
                  placeholder={tr('brandVoice.voiceDescPlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label>{tr('brandVoice.businessDesc')}</Label>
                <Textarea rows={3} value={form.business_description}
                  onChange={(e) => { setForm((f) => ({ ...f, business_description: e.target.value })); markDirty('business_description'); }}
                  placeholder={tr('brandVoice.businessDescPlaceholder')} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">{tr('doDont.title')}</CardTitle></CardHeader>
            <CardContent className="grid md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>{tr('doDont.doTitle')}</Label>
                <Textarea rows={5} value={form.do_list}
                  onChange={(e) => { setForm((f) => ({ ...f, do_list: e.target.value })); markDirty('do_list'); }}
                  placeholder={tr('doDont.doPlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label>{tr('doDont.dontTitle')}</Label>
                <Textarea rows={5} value={form.dont_list}
                  onChange={(e) => { setForm((f) => ({ ...f, dont_list: e.target.value })); markDirty('dont_list'); }}
                  placeholder={tr('doDont.dontPlaceholder')} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">{tr('topicSpecific.title')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>{tr('topicSpecific.pricing')}</Label>
                <Textarea rows={3} value={form.pricing_instructions}
                  onChange={(e) => { setForm((f) => ({ ...f, pricing_instructions: e.target.value })); markDirty('pricing_instructions'); }}
                  placeholder={tr('topicSpecific.pricingPlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label>{tr('topicSpecific.handoff')}</Label>
                <Textarea rows={3} value={form.handoff_instructions}
                  onChange={(e) => { setForm((f) => ({ ...f, handoff_instructions: e.target.value })); markDirty('handoff_instructions'); }}
                  placeholder={tr('topicSpecific.handoffPlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label>{tr('topicSpecific.support')}</Label>
                <Textarea rows={3} value={form.support_instructions}
                  onChange={(e) => { setForm((f) => ({ ...f, support_instructions: e.target.value })); markDirty('support_instructions'); }}
                  placeholder={tr('topicSpecific.supportPlaceholder')} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                {tr('advanced.title')}
                <span className="inline-flex items-center gap-1 text-[11px] font-normal text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" /> {tr('advanced.badge')}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {hasSavedCustomInstruction && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2">
                  <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    {trf('advanced.savedNote', 'A custom instruction is saved. Type here to replace it; leave empty to keep it.')}
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={removeCustomInstruction} disabled={update.isPending}>
                    {trf('advanced.remove', 'Remove')}
                  </Button>
                </div>
              )}
              <Textarea rows={6} value={form.custom_system_instruction}
                onChange={(e) => { setForm((f) => ({ ...f, custom_system_instruction: e.target.value })); markDirty('custom_system_instruction'); }}
                placeholder={tr('advanced.placeholder')} />
              <p className="text-[11px] text-muted-foreground mt-2">
                {tr('advanced.hint')}
              </p>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-2">
            <Button onClick={save} disabled={update.isPending}>
              {update.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {tr('save')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
