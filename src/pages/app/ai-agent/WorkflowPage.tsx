import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi, type WorkflowRecord, type WorkflowPreviewResult } from '@/lib/ai-agent-api';
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

const TRIGGERS = [
  'conversation_started','after_prechat','visitor_first_message',
  'topic_detected','ai_no_answer','human_requested',
  'no_operator_online','business_hours_closed',
];
const ACTIONS = [
  'send_ai_message','ask_visitor_question','handoff','assign_main_inbox',
  'assign_team','add_internal_note','mark_priority','add_tag','create_ticket',
];

function statusBadge(s: WorkflowRecord['status']) {
  switch (s) {
    case 'active': return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30';
    case 'paused': return 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30';
    case 'archived': return 'bg-muted text-muted-foreground';
    default: return 'bg-primary/10 text-primary border-primary/20';
  }
}

export default function WorkflowBuilderPage() {
  const ws = useCurrentWorkspace() as any;
  const wsId = ws?.id as string | undefined;
  const [items, setItems] = useState<WorkflowRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowRecord | null>(null);

  async function refresh() {
    if (!wsId) return;
    setLoading(true);
    try { setItems((await aiAgentApi.listWorkflows(wsId)).items || []); }
    catch (e: any) { toast({ title: 'Failed to load workflows', description: e?.message, variant: 'destructive' }); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [wsId]);

  async function remove(w: WorkflowRecord) {
    if (!confirm(`Delete workflow "${w.name}"?`)) return;
    try { await aiAgentApi.deleteWorkflow(w.id); setItems((it) => it.filter((x) => x.id !== w.id)); }
    catch (e: any) { toast({ title: 'Delete failed', description: e?.message, variant: 'destructive' }); }
  }
  async function duplicate(w: WorkflowRecord) {
    try { await aiAgentApi.duplicateWorkflow(w.id); refresh(); }
    catch (e: any) { toast({ title: 'Duplicate failed', description: e?.message, variant: 'destructive' }); }
  }
  async function toggleEnabled(w: WorkflowRecord) {
    try {
      const updated = await aiAgentApi.updateWorkflow(w.id, { enabled: !w.enabled, status: !w.enabled ? 'active' : 'paused' });
      setItems((it) => it.map((x) => x.id === w.id ? updated.item : x));
    } catch (e: any) {
      toast({ title: 'Could not enable', description: e?.message, variant: 'destructive' });
    }
  }

  if (!wsId) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Workflow className="h-5 w-5 text-primary" /> Workflow builder
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Compose safe automations: a trigger, optional conditions, and a list of allowed actions.
            External tool calls and arbitrary code are not allowed in this version.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">Runtime execution: opt-in</Badge>
          <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
            <Plus className="h-4 w-4 mr-1.5" /> New workflow
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-4">
            <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 text-primary flex items-center justify-center">
              <Workflow className="h-7 w-7" />
            </div>
            <div>
              <h2 className="text-lg font-medium">No workflows yet</h2>
              <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1">
                Create a workflow that reacts to events like “topic detected: pricing” and routes the visitor.
              </p>
            </div>
            <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
              <Plus className="h-4 w-4 mr-1.5" /> New workflow
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
                    <Badge variant="outline" className={`text-[10px] ${statusBadge(w.status)}`}>{w.status}</Badge>
                    <Badge variant="outline" className="text-[10px]">v{w.version}</Badge>
                    {w.trigger_json?.type && <Badge variant="secondary" className="text-[10px]">{String(w.trigger_json.type)}</Badge>}
                    <span className="text-[11px] text-muted-foreground">{(w.steps_json || []).length} step(s)</span>
                  </div>
                  {w.description && <p className="text-xs text-muted-foreground mt-1">{w.description}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={w.enabled} onCheckedChange={() => toggleEnabled(w)} />
                  <Button variant="ghost" size="icon" onClick={() => duplicate(w)} title="Duplicate"><Copy className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => { setEditing(w); setDialogOpen(true); }}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => remove(w)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
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
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [triggerType, setTriggerType] = useState('topic_detected');
  const [triggerExtra, setTriggerExtra] = useState(''); // topic slug
  const [steps, setSteps] = useState<Array<{ type: 'action'; action: { type: string; message?: string; team_id?: string } }>>([]);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<WorkflowPreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (editing) {
      setName(editing.name);
      setDescription(editing.description || '');
      setTriggerType(String(editing.trigger_json?.type || 'topic_detected'));
      setTriggerExtra(String((editing.trigger_json as any)?.topic_slug || ''));
      setSteps((editing.steps_json as any) || []);
    } else {
      setName(''); setDescription(''); setTriggerType('topic_detected'); setTriggerExtra('');
      setSteps([{ type: 'action', action: { type: 'handoff' } }]);
    }
    setPreview(null);
  }, [editing, open]);

  function buildDraft() {
    const trigger_json: any = { type: triggerType };
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
    } catch (e: any) { toast({ title: 'Preview failed', description: e?.message, variant: 'destructive' }); }
    finally { setPreviewing(false); }
  }

  async function save() {
    if (!name.trim()) { toast({ title: 'Name required', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const draft = buildDraft();
      if (editing) await aiAgentApi.updateWorkflow(editing.id, draft as any);
      else await aiAgentApi.createWorkflow({ workspaceId, ...(draft as any) });
      onSaved();
    } catch (e: any) { toast({ title: 'Save failed', description: e?.message, variant: 'destructive' }); }
    finally { setSaving(false); }
  }

  function updateStep(i: number, patch: any) {
    setSteps((s) => s.map((st, idx) => idx === i ? { ...st, action: { ...st.action, ...patch } } : st));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{editing ? 'Edit workflow' : 'New workflow'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pricing → Sales handoff" />
            </div>
            <div className="space-y-1.5">
              <Label>Trigger</Label>
              <Select value={triggerType} onValueChange={setTriggerType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{TRIGGERS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          {triggerType === 'topic_detected' && (
            <div className="space-y-1.5">
              <Label>Topic slug</Label>
              <Input value={triggerExtra} onChange={(e) => setTriggerExtra(e.target.value)} placeholder="e.g. pricing" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Steps</Label>
              <Button size="sm" variant="outline"
                onClick={() => setSteps((s) => [...s, { type: 'action', action: { type: 'handoff' } }])}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add step
              </Button>
            </div>
            {steps.map((s, i) => (
              <Card key={i}>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">Step {i + 1}</span>
                    <Select value={s.action.type} onValueChange={(v) => updateStep(i, { type: v })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>{ACTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
                    </Select>
                    <Button size="icon" variant="ghost" className="ml-auto"
                      onClick={() => setSteps((arr) => arr.filter((_, idx) => idx !== i))}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                  {s.action.type === 'send_ai_message' && (
                    <Textarea rows={2} placeholder="Message template…" value={s.action.message || ''}
                      onChange={(e) => updateStep(i, { message: e.target.value })} />
                  )}
                  {s.action.type === 'assign_team' && (
                    <Input placeholder="team_id" value={s.action.team_id || ''}
                      onChange={(e) => updateStep(i, { team_id: e.target.value })} />
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="rounded-md border p-3 bg-muted/30">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium">Validation & preview</span>
              <Button size="sm" variant="outline" onClick={runPreview} disabled={previewing}>
                {previewing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Eye className="h-3.5 w-3.5 mr-1" />}
                Preview
              </Button>
            </div>
            {preview && (
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  {preview.valid
                    ? <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-500/30"><CheckCircle2 className="h-3 w-3 mr-1" />Valid</Badge>
                    : <Badge className="bg-destructive/15 text-destructive border-destructive/30"><AlertTriangle className="h-3 w-3 mr-1" />Invalid</Badge>}
                  {preview.wouldTrigger
                    ? <Badge variant="secondary">Would trigger</Badge>
                    : <Badge variant="outline">Would not trigger</Badge>}
                </div>
                {preview.errors.length > 0 && (
                  <ul className="list-disc pl-5 text-destructive">{preview.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                )}
                {preview.plannedActions.length > 0 && (
                  <div>
                    <p className="text-muted-foreground mb-1">Planned actions:</p>
                    <ul className="list-disc pl-5">{preview.plannedActions.map((a, i) => <li key={i}>{a.type}</li>)}</ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {editing ? 'Save changes' : 'Create workflow'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}