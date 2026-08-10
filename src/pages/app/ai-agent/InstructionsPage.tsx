import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useAiAgentSettings, useUpdateAiAgentSettings } from '@/hooks/useAiAgent';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { ScrollText, Loader2, AlertTriangle } from 'lucide-react';

export default function InstructionsPage() {
  const ws = useCurrentWorkspace() as any;
  const wsId = ws?.id as string | undefined;
  const { data, isLoading } = useAiAgentSettings(wsId);
  const update = useUpdateAiAgentSettings(wsId);

  const i = (data?.settings?.instructions ?? {}) as any;
  const [form, setForm] = useState({
    brand_voice: '', business_description: '', tone: 'friendly',
    do_list: '' as string,
    dont_list: '' as string,
    pricing_instructions: '', handoff_instructions: '', support_instructions: '',
    custom_system_instruction: '',
  });
  // Every nested `instructions` key on this page is only written when the
  // operator actually edited its control this session -- the backend
  // replaces the ENTIRE `instructions` JSON column on write (no server-side
  // per-key merge), so unconditionally resending all 9 keys on every save
  // (as before) could silently revert a key changed elsewhere (e.g.
  // `tone`/`max_answer_length`, both owned by BehaviorPage) back to whatever
  // this page had loaded, even when the operator only touched an unrelated
  // field here. Same dirty-tracking discipline as BehaviorPage.
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
      business_description: i.business_description || data.settings.business_description || '',
      tone: i.tone || 'friendly',
      do_list: (i.do_list || []).join('\n'),
      dont_list: (i.dont_list || []).join('\n'),
      pricing_instructions: i.pricing_instructions || '',
      handoff_instructions: i.handoff_instructions || i.escalation_instructions || '',
      support_instructions: i.support_instructions || '',
      custom_system_instruction: i.custom_system_instruction || i.custom_instructions || '',
    });
    setDirty(new Set());
    // eslint-disable-next-line
  }, [data?.settings?.id]);

  async function save() {
    // Merge base: the FRESHEST instructions object available at save time
    // (not a snapshot captured at mount), so keys this page doesn't own
    // (e.g. a concurrent BehaviorPage edit to tone/max_answer_length) are
    // preserved as-is. Only the keys the operator actually touched this
    // session are overlaid on top.
    const fresh = (data?.settings?.instructions || {}) as any;
    const instructions: Record<string, unknown> = { ...fresh };
    if (dirty.has('brand_voice')) instructions.brand_voice = form.brand_voice.trim() || undefined;
    if (dirty.has('business_description')) instructions.business_description = form.business_description.trim() || undefined;
    if (dirty.has('tone')) instructions.tone = form.tone.trim() || undefined;
    if (dirty.has('do_list')) instructions.do_list = form.do_list.split('\n').map((s) => s.trim()).filter(Boolean);
    if (dirty.has('dont_list')) instructions.dont_list = form.dont_list.split('\n').map((s) => s.trim()).filter(Boolean);
    if (dirty.has('pricing_instructions')) instructions.pricing_instructions = form.pricing_instructions.trim() || undefined;
    if (dirty.has('handoff_instructions')) instructions.handoff_instructions = form.handoff_instructions.trim() || undefined;
    if (dirty.has('support_instructions')) instructions.support_instructions = form.support_instructions.trim() || undefined;
    if (dirty.has('custom_system_instruction')) instructions.custom_system_instruction = form.custom_system_instruction.trim() || undefined;
    try {
      await update.mutateAsync({ instructions } as any);
      setDirty(new Set());
      toast({ title: 'Instructions saved' });
    } catch (e: any) {
      toast({ title: 'Save failed', description: e?.message, variant: 'destructive' });
    }
  }

  if (!wsId) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
          <ScrollText className="h-5 w-5 text-primary" /> Instructions
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
          Workspace-level instructions that shape every AI reply — brand voice, what to do, what to avoid,
          and how to handle pricing, support and handoffs.
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">Brand voice</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>Tone</Label>
                <Input value={form.tone} onChange={(e) => { setForm((f) => ({ ...f, tone: e.target.value })); markDirty('tone'); }}
                  placeholder="friendly, professional, concise…" />
              </div>
              <div className="space-y-1.5">
                <Label>Brand voice description</Label>
                <Textarea rows={3} value={form.brand_voice}
                  onChange={(e) => { setForm((f) => ({ ...f, brand_voice: e.target.value })); markDirty('brand_voice'); }}
                  placeholder="How should the assistant sound? (e.g. warm, modern, plainspoken)" />
              </div>
              <div className="space-y-1.5">
                <Label>Business description</Label>
                <Textarea rows={3} value={form.business_description}
                  onChange={(e) => { setForm((f) => ({ ...f, business_description: e.target.value })); markDirty('business_description'); }}
                  placeholder="What does the company do?" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Do &amp; Don't</CardTitle></CardHeader>
            <CardContent className="grid md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Always do (one per line)</Label>
                <Textarea rows={5} value={form.do_list}
                  onChange={(e) => { setForm((f) => ({ ...f, do_list: e.target.value })); markDirty('do_list'); }}
                  placeholder={'Be concise\nOffer to connect with a human when stuck\nLink to relevant help articles'} />
              </div>
              <div className="space-y-1.5">
                <Label>Never do (one per line)</Label>
                <Textarea rows={5} value={form.dont_list}
                  onChange={(e) => { setForm((f) => ({ ...f, dont_list: e.target.value })); markDirty('dont_list'); }}
                  placeholder={'Do not invent prices\nDo not promise refunds\nDo not claim to be human'} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Topic-specific instructions</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>Pricing instructions</Label>
                <Textarea rows={3} value={form.pricing_instructions}
                  onChange={(e) => { setForm((f) => ({ ...f, pricing_instructions: e.target.value })); markDirty('pricing_instructions'); }}
                  placeholder="How should the AI talk about pricing?" />
              </div>
              <div className="space-y-1.5">
                <Label>Handoff instructions</Label>
                <Textarea rows={3} value={form.handoff_instructions}
                  onChange={(e) => { setForm((f) => ({ ...f, handoff_instructions: e.target.value })); markDirty('handoff_instructions'); }}
                  placeholder="When and how should the AI hand off to a human?" />
              </div>
              <div className="space-y-1.5">
                <Label>Support instructions</Label>
                <Textarea rows={3} value={form.support_instructions}
                  onChange={(e) => { setForm((f) => ({ ...f, support_instructions: e.target.value })); markDirty('support_instructions'); }}
                  placeholder="How should the AI handle technical support?" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                Advanced custom instruction
                <span className="inline-flex items-center gap-1 text-[11px] font-normal text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" /> Cannot override built-in safety rules
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea rows={6} value={form.custom_system_instruction}
                onChange={(e) => { setForm((f) => ({ ...f, custom_system_instruction: e.target.value })); markDirty('custom_system_instruction'); }}
                placeholder="Free-form additional system instruction (use sparingly)" />
              <p className="text-[11px] text-muted-foreground mt-2">
                Do not put API keys or secrets here. Custom instructions are appended to every prompt and are visible to the model provider.
              </p>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-2">
            <Button onClick={save} disabled={update.isPending}>
              {update.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Save instructions
            </Button>
          </div>
        </>
      )}
    </div>
  );
}