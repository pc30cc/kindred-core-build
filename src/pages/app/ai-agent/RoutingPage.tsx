import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi, type RoutingRule, type RoutingTrigger, type RoutingAction } from '@/lib/ai-agent-api';
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
import { Route as RouteIcon, Plus, Pencil, Trash2, Loader2, ArrowRight } from 'lucide-react';

// Master label lookup for ALL 8 trigger types — used everywhere a persisted
// rule's trigger_type needs a human-readable label, including legacy rows
// that use a trigger type no longer offered for new rules (see
// UNSUPPORTED_NEW_TRIGGERS below). `unavailable` triggers are real,
// intended concepts that do not yet fire in the live engine (Follow-up 9B);
// they stay selectable for new rules but are labeled truthfully.
const TRIGGERS: { value: RoutingTrigger; label: string; unavailable?: boolean }[] = [
  { value: 'human_request', label: 'Visitor asks for a human' },
  { value: 'no_answer', label: 'AI cannot answer', unavailable: true },
  { value: 'low_confidence', label: 'AI confidence is low', unavailable: true },
  { value: 'topic_detected', label: 'A specific topic is detected' },
  { value: 'business_hours', label: 'Outside business hours', unavailable: true },
  { value: 'language', label: 'Visitor language matches' },
  { value: 'vip_customer', label: 'VIP customer' },
  { value: 'plan_limit', label: 'AI plan limit reached' },
];
// Trigger types conclusively dead in the live engine with no data model to
// ever back them (plan_limit reads a field the answer strategy never
// populates; vip_customer has no canonical source of truth anywhere in the
// codebase — Follow-up 9B). Removed from the NEW-rule picker only; DB CHECK
// constraint, API zod enum, and existing persisted rows are untouched.
const UNSUPPORTED_NEW_TRIGGERS: RoutingTrigger[] = ['plan_limit', 'vip_customer'];

const ACTIONS: { value: RoutingAction; label: string; plannedOnly?: boolean }[] = [
  { value: 'handoff', label: 'Hand off to a human (Main Inbox)' },
  { value: 'assign_team', label: 'Assign to a team', plannedOnly: true },
  { value: 'assign_operator', label: 'Assign to a specific operator', plannedOnly: true },
  { value: 'keep_ai', label: 'Keep the AI handling it' },
  { value: 'create_ticket', label: 'Create a ticket', plannedOnly: true },
  { value: 'mark_priority', label: 'Mark as priority' },
];

const DEFAULTS: Array<Omit<RoutingRule, 'id' | 'workspace_id' | 'created_at' | 'updated_at'>> = [
  { name: 'Visitor asks for a human → handoff', description: 'Always escalate when a visitor asks for a person',
    trigger_type: 'human_request', conditions_json: {}, action_type: 'handoff', action_json: { target: 'main_inbox' }, priority: 10, enabled: true },
  { name: 'Pricing topic → sales', description: 'Route exact-quote requests to Sales if a team exists',
    trigger_type: 'topic_detected', conditions_json: { topic: 'pricing' }, action_type: 'assign_team', action_json: { team_slug: 'sales', fallback: 'main_inbox' }, priority: 20, enabled: true },
  { name: 'Technical issue → support', description: 'Route bug/error reports to Support if a team exists',
    trigger_type: 'topic_detected', conditions_json: { topic: 'technical_issue' }, action_type: 'assign_team', action_json: { team_slug: 'support', fallback: 'main_inbox' }, priority: 30, enabled: true },
];

export default function RoutingPage() {
  const ws = useCurrentWorkspace() as any;
  const wsId = ws?.id as string | undefined;
  const [items, setItems] = useState<RoutingRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RoutingRule | null>(null);

  async function refresh() {
    if (!wsId) return;
    setLoading(true);
    try {
      const r = await aiAgentApi.listRouting(wsId);
      setItems(r.items || []);
    } catch (e: any) {
      toast({ title: 'Failed to load routing', description: e?.message, variant: 'destructive' });
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [wsId]);

  async function toggle(r: RoutingRule) {
    try { await aiAgentApi.updateRouting(r.id, { enabled: !r.enabled });
      setItems((it) => it.map((x) => x.id === r.id ? { ...x, enabled: !r.enabled } : x));
    } catch (e: any) { toast({ title: 'Update failed', description: e?.message, variant: 'destructive' }); }
  }
  async function remove(r: RoutingRule) {
    if (!confirm(`Delete routing rule "${r.name}"?`)) return;
    try { await aiAgentApi.deleteRouting(r.id); setItems((it) => it.filter((x) => x.id !== r.id));
    } catch (e: any) { toast({ title: 'Delete failed', description: e?.message, variant: 'destructive' }); }
  }
  async function seed() {
    if (!wsId) return;
    try {
      for (const d of DEFAULTS) await aiAgentApi.createRouting({ workspaceId: wsId, ...d });
      toast({ title: 'Default routing rules added' }); refresh();
    } catch (e: any) { toast({ title: 'Seeding failed', description: e?.message, variant: 'destructive' }); }
  }

  if (!wsId) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <RouteIcon className="h-5 w-5 text-primary" /> Routing
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Decide when the AI should answer, when to hand off, and which team or operator
            should receive the conversation.
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setOpen(true); }}>
          <Plus className="h-4 w-4 mr-1.5" /> Add rule
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-4">
            <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 text-primary flex items-center justify-center">
              <RouteIcon className="h-7 w-7" />
            </div>
            <div>
              <h2 className="text-lg font-medium">No routing rules yet</h2>
              <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1">
                Add rules to control when the AI hands off to humans. Start with safe defaults that match common cases.
              </p>
            </div>
            <div className="flex justify-center gap-2 pt-2">
              <Button variant="outline" onClick={seed}>Add default rules</Button>
              <Button onClick={() => { setEditing(null); setOpen(true); }}>
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
                    <span className="font-medium text-sm">{r.name}</span>
                    <span className="text-[11px] text-muted-foreground">priority {r.priority}</span>
                  </div>
                  {r.description && <p className="text-xs text-muted-foreground mt-1">{r.description}</p>}
                  <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
                    <Badge variant="outline">When: {TRIGGERS.find((t) => t.value === r.trigger_type)?.label || r.trigger_type}</Badge>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                    <Badge variant="outline" className="bg-primary/5">Do: {ACTIONS.find((a) => a.value === r.action_type)?.label || r.action_type}</Badge>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={r.enabled} onCheckedChange={() => toggle(r)} />
                  <Button variant="ghost" size="icon" onClick={() => { setEditing(r); setOpen(true); }}>
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

      <RoutingDialog open={open} onOpenChange={setOpen} editing={editing}
        workspaceId={wsId} onSaved={() => { setOpen(false); refresh(); }} />
    </div>
  );
}

function RoutingDialog({
  open, onOpenChange, editing, workspaceId, onSaved,
}: {
  open: boolean; onOpenChange: (b: boolean) => void; editing: RoutingRule | null;
  workspaceId: string; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: '', description: '',
    trigger_type: 'human_request' as RoutingTrigger,
    action_type: 'handoff' as RoutingAction,
    priority: 100, enabled: true,
    topic: '', team_slug: '',
  });
  const [saving, setSaving] = useState(false);

  // New rules can't use a conclusively-dead trigger type — but if we're
  // editing an existing rule that already persisted one, keep that single
  // option renderable so the Select can display the current value without
  // silently corrupting it (see Follow-up 9C).
  const triggerOptions = TRIGGERS.filter(
    (t) => !UNSUPPORTED_NEW_TRIGGERS.includes(t.value) || t.value === editing?.trigger_type,
  );

  useEffect(() => {
    if (editing) {
      const c = editing.conditions_json || {};
      const a = editing.action_json || {};
      setForm({
        name: editing.name, description: editing.description || '',
        trigger_type: editing.trigger_type, action_type: editing.action_type,
        priority: editing.priority, enabled: editing.enabled,
        topic: (c as any).topic || '', team_slug: (a as any).team_slug || '',
      });
    } else {
      setForm({ name: '', description: '', trigger_type: 'human_request', action_type: 'handoff',
        priority: 100, enabled: true, topic: '', team_slug: '' });
    }
  }, [editing, open]);

  async function save() {
    if (!form.name.trim()) { toast({ title: 'Name is required', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const conditions_json: Record<string, unknown> = {};
      if (form.trigger_type === 'topic_detected' && form.topic) conditions_json.topic = form.topic;
      const action_json: Record<string, unknown> = {};
      if (form.action_type === 'assign_team' && form.team_slug) action_json.team_slug = form.team_slug;
      if (form.action_type === 'handoff') action_json.target = 'main_inbox';
      const payload = {
        name: form.name, description: form.description,
        trigger_type: form.trigger_type, action_type: form.action_type,
        priority: form.priority, enabled: form.enabled,
        conditions_json, action_json,
      };
      if (editing) await aiAgentApi.updateRouting(editing.id, payload);
      else await aiAgentApi.createRouting({ workspaceId, ...payload });
      onSaved();
    } catch (e: any) {
      toast({ title: 'Save failed', description: e?.message, variant: 'destructive' });
    } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit routing rule' : 'New routing rule'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea rows={2} value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>When (trigger)</Label>
              <Select value={form.trigger_type} onValueChange={(v) => setForm((f) => ({ ...f, trigger_type: v as RoutingTrigger }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {triggerOptions.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}{t.unavailable ? ' — not live yet' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Do (action)</Label>
              <Select value={form.action_type} onValueChange={(v) => setForm((f) => ({ ...f, action_type: v as RoutingAction }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ACTIONS.map((a) => (
                    <SelectItem key={a.value} value={a.value} disabled={a.plannedOnly}>
                      {a.label}{a.plannedOnly ? ' — coming soon' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.trigger_type === 'topic_detected' && (
            <div className="space-y-1.5">
              <Label>Topic name</Label>
              <Input value={form.topic} onChange={(e) => setForm((f) => ({ ...f, topic: e.target.value }))}
                placeholder="e.g. pricing, technical_issue" />
            </div>
          )}
          {form.action_type === 'assign_team' && (
            <div className="space-y-1.5">
              <Label>Team slug (falls back to Main Inbox if missing)</Label>
              <Input value={form.team_slug} onChange={(e) => setForm((f) => ({ ...f, team_slug: e.target.value }))}
                placeholder="e.g. sales, support" />
            </div>
          )}
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