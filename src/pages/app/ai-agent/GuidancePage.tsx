import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi, type GuidanceRule, type GuidanceRuleType } from '@/lib/ai-agent-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { Compass, Plus, Pencil, Trash2, Loader2 } from 'lucide-react';

const RULE_TYPES: { value: GuidanceRuleType; label: string; hint: string }[] = [
  { value: 'tone', label: 'Tone', hint: 'How the AI sounds (friendly, formal, concise…)' },
  { value: 'answer_policy', label: 'Answer policy', hint: 'When and how the AI may answer' },
  { value: 'escalation_policy', label: 'Escalation policy', hint: 'When to escalate to a human' },
  { value: 'restricted_topic', label: 'Restricted topic', hint: 'Topics the AI must avoid' },
  { value: 'fallback_behavior', label: 'Fallback behavior', hint: 'What to do when the AI is unsure' },
  { value: 'sales_guidance', label: 'Sales guidance', hint: 'How to handle sales questions' },
  { value: 'support_guidance', label: 'Support guidance', hint: 'How to handle support questions' },
  { value: 'pricing_guidance', label: 'Pricing guidance', hint: 'How to handle pricing questions' },
];

const DEFAULT_EXAMPLES: Array<{ title: string; description: string; rule_type: GuidanceRuleType; instruction: string }> = [
  { title: 'Never claim to be human', description: 'Honesty rule', rule_type: 'answer_policy',
    instruction: 'If a visitor asks whether you are a human, clearly say you are an AI assistant.' },
  { title: 'Do not invent exact prices', description: 'Pricing safety', rule_type: 'pricing_guidance',
    instruction: 'Never quote exact prices unless the knowledge base contains them. Offer to connect the visitor with sales instead.' },
  { title: 'Offer human help on request', description: 'Escalation rule', rule_type: 'escalation_policy',
    instruction: 'If the visitor asks for a human, immediately offer to hand off and stop attempting to answer.' },
  { title: 'Ask one clarification before handoff', description: 'Vague questions', rule_type: 'fallback_behavior',
    instruction: 'If a question is too vague to answer, ask exactly one short clarifying question before handing off.' },
  { title: 'Friendly and concise tone', description: 'Voice rule', rule_type: 'tone',
    instruction: 'Use a friendly, concise tone. Avoid long paragraphs. Prefer short, helpful answers.' },
];

function ruleTypeColor(t: GuidanceRuleType): string {
  switch (t) {
    case 'restricted_topic': return 'bg-destructive/10 text-destructive border-destructive/20';
    case 'escalation_policy':
    case 'fallback_behavior': return 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20';
    case 'pricing_guidance':
    case 'sales_guidance':
    case 'support_guidance': return 'bg-primary/10 text-primary border-primary/20';
    default: return 'bg-muted text-muted-foreground border-border';
  }
}

export default function GuidancePage() {
  const ws = useCurrentWorkspace() as any;
  const wsId = ws?.id as string | undefined;
  const [items, setItems] = useState<GuidanceRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<GuidanceRule | null>(null);

  async function refresh() {
    if (!wsId) return;
    setLoading(true);
    try {
      const r = await aiAgentApi.listGuidance(wsId);
      setItems(r.items || []);
    } catch (e: any) {
      toast({ title: 'Failed to load guidance', description: e?.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [wsId]);

  async function toggleEnabled(r: GuidanceRule) {
    try {
      await aiAgentApi.updateGuidance(r.id, { enabled: !r.enabled });
      setItems((it) => it.map((x) => x.id === r.id ? { ...x, enabled: !r.enabled } : x));
    } catch (e: any) {
      toast({ title: 'Update failed', description: e?.message, variant: 'destructive' });
    }
  }

  async function remove(r: GuidanceRule) {
    if (!confirm(`Delete guidance rule "${r.title}"?`)) return;
    try {
      await aiAgentApi.deleteGuidance(r.id);
      setItems((it) => it.filter((x) => x.id !== r.id));
    } catch (e: any) {
      toast({ title: 'Delete failed', description: e?.message, variant: 'destructive' });
    }
  }

  async function seedDefaults() {
    if (!wsId) return;
    try {
      for (const ex of DEFAULT_EXAMPLES) {
        await aiAgentApi.createGuidance({ workspaceId: wsId, ...ex });
      }
      toast({ title: 'Default rules added' });
      refresh();
    } catch (e: any) {
      toast({ title: 'Seeding failed', description: e?.message, variant: 'destructive' });
    }
  }

  if (!wsId) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Compass className="h-5 w-5 text-primary" /> Guidance
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Workspace-level rules that shape how the AI answers visitors — tone, what to avoid,
            when to escalate, and how to handle sensitive topics like pricing.
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
          <Plus className="h-4 w-4 mr-1.5" /> Add rule
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-4">
            <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 text-primary flex items-center justify-center">
              <Compass className="h-7 w-7" />
            </div>
            <div>
              <h2 className="text-lg font-medium">No guidance rules yet</h2>
              <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1">
                Add rules that explain how the AI should behave. You can start from a curated set of safe defaults.
              </p>
            </div>
            <div className="flex justify-center gap-2 pt-2">
              <Button variant="outline" onClick={seedDefaults}>Add default rules</Button>
              <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
                <Plus className="h-4 w-4 mr-1.5" /> Add a rule
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((r) => (
            <Card key={r.id} className={r.enabled ? '' : 'opacity-60'}>
              <CardContent className="p-4 flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{r.title}</span>
                    <Badge variant="outline" className={`text-[10px] ${ruleTypeColor(r.rule_type)}`}>
                      {RULE_TYPES.find((t) => t.value === r.rule_type)?.label || r.rule_type}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">priority {r.priority}</span>
                  </div>
                  {r.description && <p className="text-xs text-muted-foreground mt-1">{r.description}</p>}
                  {r.instruction && (
                    <p className="text-sm mt-2 text-foreground/80 whitespace-pre-wrap">{r.instruction}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={r.enabled} onCheckedChange={() => toggleEnabled(r)} />
                  <Button variant="ghost" size="icon" onClick={() => { setEditing(r); setDialogOpen(true); }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => remove(r)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <GuidanceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        workspaceId={wsId}
        onSaved={() => { setDialogOpen(false); refresh(); }}
      />
    </div>
  );
}

function GuidanceDialog({
  open, onOpenChange, editing, workspaceId, onSaved,
}: {
  open: boolean; onOpenChange: (b: boolean) => void; editing: GuidanceRule | null;
  workspaceId: string; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    title: '', description: '', rule_type: 'tone' as GuidanceRuleType,
    instruction: '', priority: 100, enabled: true,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) {
      setForm({
        title: editing.title,
        description: editing.description || '',
        rule_type: editing.rule_type,
        instruction: editing.instruction || '',
        priority: editing.priority,
        enabled: editing.enabled,
      });
    } else {
      setForm({ title: '', description: '', rule_type: 'tone', instruction: '', priority: 100, enabled: true });
    }
  }, [editing, open]);

  async function save() {
    if (!form.title.trim()) {
      toast({ title: 'Title is required', variant: 'destructive' }); return;
    }
    setSaving(true);
    try {
      if (editing) {
        await aiAgentApi.updateGuidance(editing.id, { ...form });
      } else {
        await aiAgentApi.createGuidance({ workspaceId, ...form });
      }
      onSaved();
    } catch (e: any) {
      toast({ title: 'Save failed', description: e?.message, variant: 'destructive' });
    } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit guidance rule' : 'New guidance rule'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Never invent prices" />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={form.rule_type} onValueChange={(v) => setForm((f) => ({ ...f, rule_type: v as GuidanceRuleType }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {RULE_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    <div className="flex flex-col">
                      <span>{t.label}</span>
                      <span className="text-[11px] text-muted-foreground">{t.hint}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Short description</Label>
            <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Optional" />
          </div>
          <div className="space-y-1.5">
            <Label>Instruction</Label>
            <Textarea rows={4} value={form.instruction}
              onChange={(e) => setForm((f) => ({ ...f, instruction: e.target.value }))}
              placeholder="Plain instruction the AI should follow…" />
            <p className="text-[11px] text-muted-foreground">Custom instructions cannot override built-in safety rules.</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Input type="number" min={0} max={10000} value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: parseInt(e.target.value || '100', 10) }))} />
            </div>
            <div className="flex items-end gap-2 pb-1">
              <Switch checked={form.enabled} onCheckedChange={(b) => setForm((f) => ({ ...f, enabled: b }))} />
              <span className="text-sm">Enabled</span>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {editing ? 'Save changes' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}