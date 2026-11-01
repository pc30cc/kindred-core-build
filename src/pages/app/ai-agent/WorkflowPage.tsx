import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useTranslation, type TranslationKey } from '@/i18n';
import { aiAgentApi, type WorkflowRecord, type WorkflowPreviewResult } from '@/lib/ai-agent-api';
import { AiPageHeader } from '@/components/ai-agent/AiPageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { Workflow, Plus, Pencil, Trash2, Loader2, Copy, Eye, AlertTriangle, CheckCircle2 } from 'lucide-react';

// `value` is what the server stores and stays as it is; `label` is only what
// people read.
type Option = { value: string; label: TranslationKey };

const TRIGGERS: Option[] = [
  { value: 'conversation_started', label: 'aiAgent.workflow.trigger.conversation_started' },
  { value: 'after_prechat', label: 'aiAgent.workflow.trigger.after_prechat' },
  { value: 'visitor_first_message', label: 'aiAgent.workflow.trigger.visitor_first_message' },
  { value: 'topic_detected', label: 'aiAgent.workflow.trigger.topic_detected' },
  { value: 'ai_no_answer', label: 'aiAgent.workflow.trigger.ai_no_answer' },
  { value: 'human_requested', label: 'aiAgent.workflow.trigger.human_requested' },
  { value: 'no_operator_online', label: 'aiAgent.workflow.trigger.no_operator_online' },
  { value: 'business_hours_closed', label: 'aiAgent.workflow.trigger.business_hours_closed' },
];
const ACTIONS: Option[] = [
  { value: 'send_ai_message', label: 'aiAgent.workflow.action.send_ai_message' },
  { value: 'ask_visitor_question', label: 'aiAgent.workflow.action.ask_visitor_question' },
  { value: 'handoff', label: 'aiAgent.workflow.action.handoff' },
  { value: 'assign_main_inbox', label: 'aiAgent.workflow.action.assign_main_inbox' },
  { value: 'assign_team', label: 'aiAgent.workflow.action.assign_team' },
  { value: 'add_internal_note', label: 'aiAgent.workflow.action.add_internal_note' },
  { value: 'mark_priority', label: 'aiAgent.workflow.action.mark_priority' },
  { value: 'add_tag', label: 'aiAgent.workflow.action.add_tag' },
  { value: 'create_ticket', label: 'aiAgent.workflow.action.create_ticket' },
];
const STATUS_LABELS: Record<WorkflowRecord['status'], TranslationKey> = {
  draft: 'aiAgent.workflow.status.draft',
  active: 'aiAgent.workflow.status.active',
  paused: 'aiAgent.workflow.status.paused',
  archived: 'aiAgent.workflow.status.archived',
};

/** The label of a known id; an id this page does not know is shown as it is. */
function optionLabel(options: Option[], value: string, t: (key: TranslationKey) => string): string {
  const option = options.find((o) => o.value === value);
  return option ? t(option.label) : value;
}

/** What was thrown, for a toast's description (undefined when it has no message). */
const messageOf = (e: unknown) => (e as { message?: string } | null | undefined)?.message;

type Step = { type: 'action'; action: { type: string; message?: string; team_id?: string } };

function statusBadge(s: WorkflowRecord['status']) {
  switch (s) {
    case 'active': return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30';
    case 'paused': return 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30';
    case 'archived': return 'bg-muted text-muted-foreground';
    default: return 'bg-primary/10 text-primary border-primary/20';
  }
}

export default function WorkflowBuilderPage() {
  const { t } = useTranslation();
  const wsId = useCurrentWorkspace()?.id;
  const [items, setItems] = useState<WorkflowRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowRecord | null>(null);

  async function refresh() {
    if (!wsId) return;
    setLoading(true);
    try { setItems((await aiAgentApi.listWorkflows(wsId)).items || []); }
    catch (e) { toast({ title: t('aiAgent.workflow.toast.loadFailed'), description: messageOf(e), variant: 'destructive' }); }
    finally { setLoading(false); }
  }
  // Loads once per workspace; refresh only reads wsId.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refresh(); }, [wsId]);

  async function remove(w: WorkflowRecord) {
    if (!confirm(t('aiAgent.workflow.deleteConfirm', { name: w.name }))) return;
    try { await aiAgentApi.deleteWorkflow(w.id); setItems((it) => it.filter((x) => x.id !== w.id)); }
    catch (e) { toast({ title: t('aiAgent.workflow.toast.deleteFailed'), description: messageOf(e), variant: 'destructive' }); }
  }
  async function duplicate(w: WorkflowRecord) {
    try { await aiAgentApi.duplicateWorkflow(w.id); refresh(); }
    catch (e) { toast({ title: t('aiAgent.workflow.toast.duplicateFailed'), description: messageOf(e), variant: 'destructive' }); }
  }
  async function toggleEnabled(w: WorkflowRecord) {
    try {
      const updated = await aiAgentApi.updateWorkflow(w.id, { enabled: !w.enabled, status: !w.enabled ? 'active' : 'paused' });
      setItems((it) => it.map((x) => x.id === w.id ? updated.item : x));
    } catch (e) {
      toast({ title: t('aiAgent.workflow.toast.enableFailed'), description: messageOf(e), variant: 'destructive' });
    }
  }

  if (!wsId) return null;

  return (
    <div className="space-y-6">
      <AiPageHeader
        icon={Workflow}
        accent="indigo"
        title={t('aiAgent.workflow.title')}
        subtitle={t('aiAgent.workflow.subtitle')}
        meta={<Badge variant="outline" className="text-[10px]">{t('aiAgent.workflow.runtimeOptIn')}</Badge>}
        actions={
          <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
            <Plus className="h-4 w-4 me-1.5" /> {t('aiAgent.workflow.newWorkflow')}
          </Button>
        }
      />

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-4">
            <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 text-primary flex items-center justify-center">
              <Workflow className="h-7 w-7" />
            </div>
            <div>
              <h2 className="text-lg font-medium">{t('aiAgent.workflow.emptyTitle')}</h2>
              <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1">
                {t('aiAgent.workflow.emptyDescription')}
              </p>
            </div>
            <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
              <Plus className="h-4 w-4 me-1.5" /> {t('aiAgent.workflow.newWorkflow')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((w) => (
            <Card key={w.id} className={w.enabled ? '' : 'opacity-80'}>
              <CardContent className="p-4 flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{w.name}</span>
                    <Badge variant="outline" className={`text-[10px] ${statusBadge(w.status)}`}>{STATUS_LABELS[w.status] ? t(STATUS_LABELS[w.status]) : w.status}</Badge>
                    <Badge variant="outline" className="text-[10px]">{t('aiAgent.workflow.version', { version: w.version })}</Badge>
                    {w.trigger_json?.type && <Badge variant="secondary" className="text-[10px]">{optionLabel(TRIGGERS, String(w.trigger_json.type), t)}</Badge>}
                    <span className="text-[11px] text-muted-foreground">{t('aiAgent.workflow.stepCount', { count: (w.steps_json || []).length })}</span>
                  </div>
                  {w.description && <p className="text-xs text-muted-foreground mt-1">{w.description}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={w.enabled} onCheckedChange={() => toggleEnabled(w)} aria-label={t('aiAgent.workflow.enabled')} />
                  <Button variant="ghost" size="icon" onClick={() => duplicate(w)} title={t('aiAgent.workflow.duplicate')}><Copy className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => { setEditing(w); setDialogOpen(true); }} title={t('aiAgent.workflow.edit')}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => remove(w)} title={t('aiAgent.workflow.remove')}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <WorkflowDialog
        open={dialogOpen} onOpenChange={setDialogOpen}
        editing={editing} workspaceId={wsId}
        onSaved={() => { setDialogOpen(false); refresh(); }} />
    </div>
  );
}

function WorkflowDialog({ open, onOpenChange, editing, workspaceId, onSaved }: {
  open: boolean; onOpenChange: (b: boolean) => void;
  editing: WorkflowRecord | null; workspaceId: string; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [triggerType, setTriggerType] = useState('topic_detected');
  const [triggerExtra, setTriggerExtra] = useState(''); // topic slug
  const [steps, setSteps] = useState<Step[]>([]);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<WorkflowPreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (editing) {
      setName(editing.name);
      setDescription(editing.description || '');
      setTriggerType(String(editing.trigger_json?.type || 'topic_detected'));
      setTriggerExtra(String(editing.trigger_json?.topic_slug || ''));
      setSteps((editing.steps_json as unknown as Step[]) || []);
    } else {
      setName(''); setDescription(''); setTriggerType('topic_detected'); setTriggerExtra('');
      setSteps([{ type: 'action', action: { type: 'handoff' } }]);
    }
    setPreview(null);
  }, [editing, open]);

  function buildDraft() {
    const trigger_json: Record<string, unknown> = { type: triggerType };
    if (triggerType === 'topic_detected') trigger_json.topic_slug = triggerExtra.trim() || undefined;
    return { name: name.trim(), description: description.trim() || null, trigger_json, steps_json: steps };
  }

  async function runPreview() {
    setPreviewing(true);
    try {
      const r = await aiAgentApi.previewWorkflow({
        workspaceId,
        workflowDraft: buildDraft(),
        sampleMessage: 'قیمت پلن چنده؟',
        sampleContext: { detectedTopicSlug: triggerExtra || 'pricing', language: 'fa' },
      });
      setPreview(r);
    } catch (e) { toast({ title: t('aiAgent.workflow.toast.previewFailed'), description: messageOf(e), variant: 'destructive' }); }
    finally { setPreviewing(false); }
  }

  async function save() {
    if (!name.trim()) { toast({ title: t('aiAgent.workflow.toast.nameRequired'), variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const draft = buildDraft();
      if (editing) await aiAgentApi.updateWorkflow(editing.id, draft);
      else await aiAgentApi.createWorkflow({ workspaceId, ...draft });
      onSaved();
    } catch (e) { toast({ title: t('aiAgent.workflow.toast.saveFailed'), description: messageOf(e), variant: 'destructive' }); }
    finally { setSaving(false); }
  }

  function updateStep(i: number, patch: Partial<Step['action']>) {
    setSteps((s) => s.map((st, idx) => idx === i ? { ...st, action: { ...st.action, ...patch } } : st));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{editing ? t('aiAgent.workflow.dialog.editTitle') : t('aiAgent.workflow.newWorkflow')}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('aiAgent.workflow.dialog.name')}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('aiAgent.workflow.dialog.namePlaceholder')} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('aiAgent.workflow.dialog.trigger')}</Label>
              <Select value={triggerType} onValueChange={setTriggerType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{TRIGGERS.map((o) => <SelectItem key={o.value} value={o.value}>{t(o.label)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          {triggerType === 'topic_detected' && (
            <div className="space-y-1.5">
              <Label>{t('aiAgent.workflow.dialog.topicSlug')}</Label>
              <Input value={triggerExtra} onChange={(e) => setTriggerExtra(e.target.value)} placeholder={t('aiAgent.workflow.dialog.topicSlugPlaceholder')} />
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{t('aiAgent.workflow.dialog.description')}</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('aiAgent.workflow.dialog.descriptionPlaceholder')} />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('aiAgent.workflow.dialog.steps')}</Label>
              <Button size="sm" variant="outline"
                onClick={() => setSteps((s) => [...s, { type: 'action', action: { type: 'handoff' } }])}>
                <Plus className="h-3.5 w-3.5 me-1" /> {t('aiAgent.workflow.dialog.addStep')}
              </Button>
            </div>
            {steps.map((s, i) => (
              <Card key={i}>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">{t('aiAgent.workflow.dialog.step', { number: i + 1 })}</span>
                    <Select value={s.action.type} onValueChange={(v) => updateStep(i, { type: v })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>{ACTIONS.map((a) => <SelectItem key={a.value} value={a.value}>{t(a.label)}</SelectItem>)}</SelectContent>
                    </Select>
                    <Button size="icon" variant="ghost" className="ms-auto" title={t('aiAgent.workflow.dialog.removeStep')}
                      onClick={() => setSteps((arr) => arr.filter((_, idx) => idx !== i))}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                  {s.action.type === 'send_ai_message' && (
                    <Textarea rows={2} placeholder={t('aiAgent.workflow.dialog.messagePlaceholder')} value={s.action.message || ''}
                      onChange={(e) => updateStep(i, { message: e.target.value })} />
                  )}
                  {s.action.type === 'assign_team' && (
                    <Input placeholder={t('aiAgent.workflow.dialog.teamIdPlaceholder')} value={s.action.team_id || ''}
                      onChange={(e) => updateStep(i, { team_id: e.target.value })} />
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="rounded-md border p-3 bg-muted/30">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium">{t('aiAgent.workflow.dialog.previewTitle')}</span>
              <Button size="sm" variant="outline" onClick={runPreview} disabled={previewing}>
                {previewing ? <Loader2 className="h-3.5 w-3.5 me-1 animate-spin" /> : <Eye className="h-3.5 w-3.5 me-1" />}
                {t('aiAgent.workflow.dialog.preview')}
              </Button>
            </div>
            {preview && (
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  {preview.valid
                    ? <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-500/30"><CheckCircle2 className="h-3 w-3 me-1" />{t('aiAgent.workflow.dialog.valid')}</Badge>
                    : <Badge className="bg-destructive/15 text-destructive border-destructive/30"><AlertTriangle className="h-3 w-3 me-1" />{t('aiAgent.workflow.dialog.invalid')}</Badge>}
                  {preview.wouldTrigger
                    ? <Badge variant="secondary">{t('aiAgent.workflow.dialog.wouldTrigger')}</Badge>
                    : <Badge variant="outline">{t('aiAgent.workflow.dialog.wouldNotTrigger')}</Badge>}
                </div>
                {preview.errors.length > 0 && (
                  <ul className="list-disc ps-5 text-destructive">{preview.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                )}
                {preview.plannedActions.length > 0 && (
                  <div>
                    <p className="text-muted-foreground mb-1">{t('aiAgent.workflow.dialog.plannedActions')}</p>
                    <ul className="list-disc ps-5">{preview.plannedActions.map((a, i) => <li key={i}>{optionLabel(ACTIONS, a.type, t)}</li>)}</ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('aiAgent.workflow.dialog.cancel')}</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
            {editing ? t('aiAgent.workflow.dialog.saveChanges') : t('aiAgent.workflow.dialog.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
