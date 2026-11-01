import { useCallback, useEffect, useState } from 'react';
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
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { Compass, Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { cn } from '@/lib/utils';

// `value` is what the server stores; label and hint are shown in the dashboard's language.
const RULE_TYPES: { value: GuidanceRuleType; label: TranslationKey; hint: TranslationKey }[] = [
  { value: 'tone', label: 'aiAgent.guidance.types.tone.label', hint: 'aiAgent.guidance.types.tone.hint' },
  { value: 'answer_policy', label: 'aiAgent.guidance.types.answer_policy.label', hint: 'aiAgent.guidance.types.answer_policy.hint' },
  { value: 'escalation_policy', label: 'aiAgent.guidance.types.escalation_policy.label', hint: 'aiAgent.guidance.types.escalation_policy.hint' },
  { value: 'restricted_topic', label: 'aiAgent.guidance.types.restricted_topic.label', hint: 'aiAgent.guidance.types.restricted_topic.hint' },
  { value: 'fallback_behavior', label: 'aiAgent.guidance.types.fallback_behavior.label', hint: 'aiAgent.guidance.types.fallback_behavior.hint' },
  { value: 'sales_guidance', label: 'aiAgent.guidance.types.sales_guidance.label', hint: 'aiAgent.guidance.types.sales_guidance.hint' },
  { value: 'support_guidance', label: 'aiAgent.guidance.types.support_guidance.label', hint: 'aiAgent.guidance.types.support_guidance.hint' },
  { value: 'pricing_guidance', label: 'aiAgent.guidance.types.pricing_guidance.label', hint: 'aiAgent.guidance.types.pricing_guidance.hint' },
];

/**
 * The starter rules. Their title and text are saved as the rules themselves
 * (and go into the AI's prompt), so they are written in the dashboard's
 * language when the owner adds them, where the owner can read and edit them.
 */
const DEFAULT_EXAMPLES: Array<{ title: TranslationKey; description: TranslationKey; rule_type: GuidanceRuleType; instruction: TranslationKey }> = [
  { title: 'aiAgent.guidance.defaults.human.title', description: 'aiAgent.guidance.defaults.human.description', rule_type: 'answer_policy',
    instruction: 'aiAgent.guidance.defaults.human.instruction' },
  { title: 'aiAgent.guidance.defaults.prices.title', description: 'aiAgent.guidance.defaults.prices.description', rule_type: 'pricing_guidance',
    instruction: 'aiAgent.guidance.defaults.prices.instruction' },
  { title: 'aiAgent.guidance.defaults.handoff.title', description: 'aiAgent.guidance.defaults.handoff.description', rule_type: 'escalation_policy',
    instruction: 'aiAgent.guidance.defaults.handoff.instruction' },
  { title: 'aiAgent.guidance.defaults.clarify.title', description: 'aiAgent.guidance.defaults.clarify.description', rule_type: 'fallback_behavior',
    instruction: 'aiAgent.guidance.defaults.clarify.instruction' },
  { title: 'aiAgent.guidance.defaults.tone.title', description: 'aiAgent.guidance.defaults.tone.description', rule_type: 'tone',
    instruction: 'aiAgent.guidance.defaults.tone.instruction' },
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

/** The API client's error text (the server's code), if any. */
function errorMessage(e: unknown): string | undefined {
  return (e as { message?: string } | null | undefined)?.message;
}

export interface GuidanceRulesListProps {
  workspaceId: string;
  /**
   * 'page': the Guidance page's list of cards. 'embedded': a compact block
   * inside another page (Personality & behavior). Every rule saves through
   * its own dialog or switch, at once, in both.
   */
  variant?: 'page' | 'embedded';
}

/**
 * The workspace's answer rules: list, add, edit, turn on or off, delete, and
 * the five starter rules in the dashboard's language. Each change is saved
 * right away (POST/PATCH/DELETE /api/ai-agent/guidance), never with a page's
 * own Save.
 */
export function GuidanceRulesList({ workspaceId, variant = 'page' }: GuidanceRulesListProps) {
  const { t } = useTranslation();
  const embedded = variant === 'embedded';
  const [items, setItems] = useState<GuidanceRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<GuidanceRule | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await aiAgentApi.listGuidance(workspaceId);
      setItems(r.items || []);
    } catch (e) {
      toast({ title: t('aiAgent.guidance.loadFailed'), description: errorMessage(e), variant: 'destructive' });
    } finally { setLoading(false); }
  }, [workspaceId, t]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per workspace
  }, [workspaceId]);

  async function toggleEnabled(r: GuidanceRule) {
    try {
      await aiAgentApi.updateGuidance(r.id, { enabled: !r.enabled });
      setItems((it) => it.map((x) => x.id === r.id ? { ...x, enabled: !r.enabled } : x));
    } catch (e) {
      toast({ title: t('aiAgent.guidance.updateFailed'), description: errorMessage(e), variant: 'destructive' });
    }
  }

  async function remove(r: GuidanceRule) {
    if (!confirm(t('aiAgent.guidance.confirmDelete', { title: r.title }))) return;
    try {
      await aiAgentApi.deleteGuidance(r.id);
      setItems((it) => it.filter((x) => x.id !== r.id));
    } catch (e) {
      toast({ title: t('aiAgent.guidance.deleteFailed'), description: errorMessage(e), variant: 'destructive' });
    }
  }

  async function seedDefaults() {
    setSeeding(true);
    try {
      for (const ex of DEFAULT_EXAMPLES) {
        await aiAgentApi.createGuidance({
          workspaceId,
          title: t(ex.title),
          description: t(ex.description),
          rule_type: ex.rule_type,
          instruction: t(ex.instruction),
        });
      }
      toast({ title: t('aiAgent.guidance.seeded') });
      refresh();
    } catch (e) {
      toast({ title: t('aiAgent.guidance.seedFailed'), description: errorMessage(e), variant: 'destructive' });
    } finally { setSeeding(false); }
  }

  const typeLabel = (value: GuidanceRuleType): string => {
    const type = RULE_TYPES.find((rt) => rt.value === value);
    return type ? t(type.label) : value;
  };

  const openNew = () => { setEditing(null); setDialogOpen(true); };

  return (
    <div data-guidance-rules={variant} className={embedded ? 'space-y-3' : 'space-y-4'}>
      {items.length > 0 && (
        <div className="flex justify-end">
          <Button size={embedded ? 'sm' : 'default'} variant={embedded ? 'outline' : 'default'} onClick={openNew}>
            <Plus className="h-4 w-4 me-1.5" /> {t('aiAgent.guidance.addRule')}
          </Button>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <div className={cn(
          'text-center space-y-3',
          embedded ? 'rounded-lg border border-dashed border-border/70 p-5' : 'rounded-lg border bg-card p-8 shadow-sm',
        )}>
          <div className={cn(
            'mx-auto rounded-full bg-primary/10 text-primary flex items-center justify-center',
            embedded ? 'h-10 w-10' : 'h-14 w-14',
          )}>
            <Compass className={embedded ? 'h-5 w-5' : 'h-7 w-7'} />
          </div>
          <div>
            <p className={embedded ? 'text-sm font-medium' : 'text-lg font-medium'}>{t('aiAgent.guidance.emptyTitle')}</p>
            <p className={cn('text-muted-foreground max-w-md mx-auto mt-1', embedded ? 'text-xs' : 'text-sm')}>
              {t('aiAgent.guidance.emptyBody')}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Button variant="outline" size={embedded ? 'sm' : 'default'} onClick={seedDefaults} disabled={seeding}>
              {seeding && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
              {t('aiAgent.guidance.addDefaults')}
            </Button>
            <Button size={embedded ? 'sm' : 'default'} onClick={openNew}>
              <Plus className="h-4 w-4 me-1.5" /> {t('aiAgent.guidance.addFirst')}
            </Button>
          </div>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((r) => (
            <li key={r.id}>
              <Card className={cn(embedded && 'shadow-none border-border/60', !r.enabled && 'opacity-60')}>
                <CardContent className={cn('flex items-start gap-4', embedded ? 'p-3' : 'p-4')}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm" dir="auto">{r.title}</span>
                      <Badge variant="outline" className={`text-[10px] ${ruleTypeColor(r.rule_type)}`}>
                        {typeLabel(r.rule_type)}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">{t('aiAgent.guidance.priority', { priority: r.priority })}</span>
                    </div>
                    {r.description && <p className="text-xs text-muted-foreground mt-1" dir="auto">{r.description}</p>}
                    {r.instruction && (
                      <p className={cn('text-foreground/80 whitespace-pre-wrap', embedded ? 'text-xs mt-1.5' : 'text-sm mt-2')} dir="auto">{r.instruction}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Switch checked={r.enabled} onCheckedChange={() => toggleEnabled(r)} aria-label={t('aiAgent.guidance.dialog.enabled')} />
                    <Button variant="ghost" size="icon" onClick={() => { setEditing(r); setDialogOpen(true); }} aria-label={t('aiAgent.guidance.editRule')}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => remove(r)} aria-label={t('aiAgent.guidance.deleteRule')}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <GuidanceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        workspaceId={workspaceId}
        onSaved={() => { setDialogOpen(false); refresh(); }}
      />
    </div>
  );
}

export function GuidanceDialog({
  open, onOpenChange, editing, workspaceId, onSaved,
}: {
  open: boolean; onOpenChange: (b: boolean) => void; editing: GuidanceRule | null;
  workspaceId: string; onSaved: () => void;
}) {
  const { t } = useTranslation();
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
      toast({ title: t('aiAgent.guidance.dialog.titleRequired'), variant: 'destructive' }); return;
    }
    setSaving(true);
    try {
      if (editing) {
        await aiAgentApi.updateGuidance(editing.id, { ...form });
      } else {
        await aiAgentApi.createGuidance({ workspaceId, ...form });
      }
      onSaved();
    } catch (e) {
      toast({ title: t('aiAgent.guidance.dialog.saveFailed'), description: errorMessage(e), variant: 'destructive' });
    } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? t('aiAgent.guidance.dialog.editTitle') : t('aiAgent.guidance.dialog.newTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t('aiAgent.guidance.dialog.title')}</Label>
            <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder={t('aiAgent.guidance.dialog.titlePlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('aiAgent.guidance.dialog.type')}</Label>
            <Select value={form.rule_type} onValueChange={(v) => setForm((f) => ({ ...f, rule_type: v as GuidanceRuleType }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {RULE_TYPES.map((rt) => (
                  <SelectItem key={rt.value} value={rt.value}>
                    <div className="flex flex-col">
                      <span>{t(rt.label)}</span>
                      <span className="text-[11px] text-muted-foreground">{t(rt.hint)}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('aiAgent.guidance.dialog.description')}</Label>
            <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder={t('aiAgent.guidance.dialog.descriptionPlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('aiAgent.guidance.dialog.instruction')}</Label>
            <Textarea rows={4} value={form.instruction}
              onChange={(e) => setForm((f) => ({ ...f, instruction: e.target.value }))}
              placeholder={t('aiAgent.guidance.dialog.instructionPlaceholder')} />
            <p className="text-[11px] text-muted-foreground">{t('aiAgent.guidance.dialog.safetyNote')}</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>{t('aiAgent.guidance.dialog.priority')}</Label>
              <Input type="number" min={0} max={10000} value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: parseInt(e.target.value || '100', 10) }))} />
            </div>
            <div className="flex items-end gap-2 pb-1">
              <Switch checked={form.enabled} onCheckedChange={(b) => setForm((f) => ({ ...f, enabled: b }))} />
              <span className="text-sm">{t('aiAgent.guidance.dialog.enabled')}</span>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('aiAgent.guidance.dialog.cancel')}</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
            {editing ? t('aiAgent.guidance.dialog.save') : t('aiAgent.guidance.dialog.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default GuidanceRulesList;
