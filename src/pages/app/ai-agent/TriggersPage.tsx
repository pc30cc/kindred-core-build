import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi, type MessageTriggerRecord, type MessageTriggerEvent, type MessageTriggerAction } from '@/lib/ai-agent-api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { Bell, Plus, Pencil, Trash2, Loader2, Beaker } from 'lucide-react';

// Follow-up 9G.1 — `live` truthfully reflects the current runtime engine,
// not the DB CHECK constraint / API zod enum / UI, which accept ALL 8
// events and 6 actions for backward-compatible persistence. Only 4 events
// are ever actually passed to evaluateMessageTriggers() by the live engine
// (server/services/ai-agent/engine/automationStage.ts for the first 3,
// engine/helpers.ts for ai_no_answer) and only 2 actions have a real
// executor branch (server/services/ai-agent/runtime/actionExecutor.ts).
// conversation_started isn't even part of triggerRuntime.ts's
// TriggerEventType union — it can never match, by construction.
const EVENTS: { value: MessageTriggerEvent; label: string; live: boolean }[] = [
  { value: 'visitor_first_message', label: 'Visitor first message', live: true },
  { value: 'topic_detected', label: 'Topic detected', live: true },
  { value: 'human_requested', label: 'Human requested', live: true },
  { value: 'ai_no_answer', label: 'AI could not answer', live: true },
  { value: 'conversation_started', label: 'Conversation started', live: false },
  { value: 'after_prechat', label: 'After pre-chat form', live: false },
  { value: 'no_operator_online', label: 'No operator online', live: false },
  { value: 'business_hours_closed', label: 'Outside business hours', live: false },
];
const ACTIONS: { value: MessageTriggerAction; label: string; live: boolean }[] = [
  { value: 'send_message', label: 'Send AI message', live: true },
  { value: 'handoff', label: 'Handoff to human', live: true },
  { value: 'start_workflow', label: 'Start workflow', live: false },
  { value: 'assign', label: 'Assign', live: false },
  { value: 'tag', label: 'Add tag', live: false },
  { value: 'internal_note', label: 'Add internal note', live: false },
];
const LIVE_DEFAULT_EVENT: MessageTriggerEvent = 'visitor_first_message';

export default function MessageTriggersPage() {
  const ws = useCurrentWorkspace() as any;
  const wsId = ws?.id as string | undefined;
  const [items, setItems] = useState<MessageTriggerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MessageTriggerRecord | null>(null);

  async function refresh() {
    if (!wsId) return;
    setLoading(true);
    try { setItems((await aiAgentApi.listMessageTriggers(wsId)).items || []); }
    catch (e: any) { toast({ title: 'Failed to load triggers', description: e?.message, variant: 'destructive' }); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [wsId]);

  async function toggle(t: MessageTriggerRecord) {
    try {
      await aiAgentApi.updateMessageTrigger(t.id, { enabled: !t.enabled });
      setItems((it) => it.map((x) => x.id === t.id ? { ...x, enabled: !t.enabled } : x));
    } catch (e: any) { toast({ title: 'Update failed', description: e?.message, variant: 'destructive' }); }
  }
  async function remove(t: MessageTriggerRecord) {
    if (!confirm(`Delete trigger "${t.name}"?`)) return;
    try { await aiAgentApi.deleteMessageTrigger(t.id); setItems((it) => it.filter((x) => x.id !== t.id)); }
    catch (e: any) { toast({ title: 'Delete failed', description: e?.message, variant: 'destructive' }); }
  }
  async function test(t: MessageTriggerRecord) {
    try {
      const r = await aiAgentApi.testMessageTrigger(t.id);
      toast({ title: 'Dry run', description: r.note });
    } catch (e: any) { toast({ title: 'Test failed', description: e?.message, variant: 'destructive' }); }
  }

  if (!wsId) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Bell className="h-5 w-5 text-primary" /> Message triggers
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
            Proactive messages and small actions that fire on conversation events.
            Message Triggers run only for supported events and actions — options
            marked "coming soon" are saved for compatibility but are not executed
            by the runtime.
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
          <Plus className="h-4 w-4 mr-1.5" /> New trigger
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-4">
            <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 text-primary flex items-center justify-center">
              <Bell className="h-7 w-7" />
            </div>
            <div>
              <h2 className="text-lg font-medium">No triggers yet</h2>
              <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1">
                Add a trigger like “first visitor message → send welcome” or “human requested → handoff”.
              </p>
            </div>
            <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
              <Plus className="h-4 w-4 mr-1.5" /> New trigger
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((t) => {
            // Follow-up 9G.1 — enabled=true (a DB/persistence flag) does not
            // imply runtime-capable=true. A rule using a not-live event or a
            // planned action must never be visually presented as if it were
            // actually firing, no matter its enabled state.
            const eventLive = EVENTS.find((e) => e.value === t.event_type)?.live ?? false;
            const actionLive = ACTIONS.find((a) => a.value === t.action_type)?.live ?? false;
            const runtimeCapable = eventLive && actionLive;
            return (
            <Card key={t.id} className={t.enabled ? '' : 'opacity-70'}>
              <CardContent className="p-4 flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{t.name}</span>
                    <Badge variant="outline" className="text-[10px]">{EVENTS.find((e) => e.value === t.event_type)?.label || t.event_type}</Badge>
                    <Badge variant="secondary" className="text-[10px]">→ {ACTIONS.find((a) => a.value === t.action_type)?.label || t.action_type}</Badge>
                    {t.delay_seconds > 0 && (
                      <span className="text-[11px] text-muted-foreground">configured delay {t.delay_seconds}s — not enforced</span>
                    )}
                    {!t.enabled && <Badge variant="outline" className="text-[10px]">disabled</Badge>}
                    {!runtimeCapable && (
                      <Badge variant="outline" className="text-[10px] text-amber-600 dark:text-amber-400 border-amber-600/40">
                        not runtime-capable
                      </Badge>
                    )}
                  </div>
                  {t.description && <p className="text-xs text-muted-foreground mt-1">{t.description}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={t.enabled} onCheckedChange={() => toggle(t)} />
                  <Button variant="ghost" size="icon" onClick={() => test(t)} title="Dry-run"><Beaker className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => { setEditing(t); setDialogOpen(true); }}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => remove(t)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </div>
              </CardContent>
            </Card>
            );
          })}
        </div>
      )}

      <TriggerDialog
        open={dialogOpen} onOpenChange={setDialogOpen}
        editing={editing} workspaceId={wsId}
        onSaved={() => { setDialogOpen(false); refresh(); }} />
    </div>
  );
}

function TriggerDialog({ open, onOpenChange, editing, workspaceId, onSaved }: {
  open: boolean; onOpenChange: (b: boolean) => void;
  editing: MessageTriggerRecord | null; workspaceId: string; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: '', description: '',
    event_type: LIVE_DEFAULT_EVENT,
    action_type: 'send_message' as MessageTriggerAction,
    message: '', delay_seconds: 0, enabled: false,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) {
      setForm({
        name: editing.name, description: editing.description || '',
        event_type: editing.event_type, action_type: editing.action_type,
        message: String((editing.action_json as any)?.message || ''),
        delay_seconds: editing.delay_seconds, enabled: editing.enabled,
      });
    } else {
      setForm({ name: '', description: '', event_type: LIVE_DEFAULT_EVENT, action_type: 'send_message', message: '', delay_seconds: 0, enabled: false });
    }
  }, [editing, open]);

  async function save() {
    if (!form.name.trim()) { toast({ title: 'Name required', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      // action_json round-trip: send_message always reflects the live
      // Message field (the only editable payload this dialog exposes for
      // it). For any other action_type — none of which have an editable
      // payload field here — a brand-new rule or one whose action_type was
      // just changed gets a clean {}; an EXISTING row whose action_type is
      // unchanged preserves its persisted action_json exactly (e.g. a
      // legacy start_workflow row's workflow_id), instead of silently
      // wiping it on every unrelated save (Follow-up 9G.1).
      const actionChanged = editing ? form.action_type !== editing.action_type : false;
      let action_json: Record<string, unknown>;
      if (form.action_type === 'send_message') {
        action_json = { message: form.message };
      } else if (!editing || actionChanged) {
        action_json = {};
      } else {
        action_json = (editing.action_json as Record<string, unknown>) || {};
      }
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        event_type: form.event_type,
        action_type: form.action_type,
        action_json,
        delay_seconds: Number(form.delay_seconds) || 0,
        enabled: form.enabled,
      };
      if (editing) await aiAgentApi.updateMessageTrigger(editing.id, payload as any);
      else await aiAgentApi.createMessageTrigger({ workspaceId, ...payload });
      onSaved();
    } catch (e: any) { toast({ title: 'Save failed', description: e?.message, variant: 'destructive' }); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{editing ? 'Edit trigger' : 'New trigger'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Welcome after pre-chat" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Event</Label>
              <Select value={form.event_type} onValueChange={(v) => setForm((f) => ({ ...f, event_type: v as MessageTriggerEvent }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EVENTS.map((e) => (
                    <SelectItem key={e.value} value={e.value} disabled={!e.live}>
                      {e.label}{!e.live ? ' — coming soon' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!EVENTS.find((e) => e.value === form.event_type)?.live && (
                <p className="text-xs text-muted-foreground">
                  This event is not currently emitted by the runtime.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Action</Label>
              <Select value={form.action_type} onValueChange={(v) => setForm((f) => ({ ...f, action_type: v as MessageTriggerAction }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ACTIONS.map((a) => (
                    <SelectItem key={a.value} value={a.value} disabled={!a.live}>
                      {a.label}{!a.live ? ' — coming soon' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!ACTIONS.find((a) => a.value === form.action_type)?.live && (
                <p className="text-xs text-muted-foreground">
                  This action is not currently executed by the runtime.
                </p>
              )}
            </div>
          </div>
          {form.action_type === 'send_message' && (
            <div className="space-y-1.5">
              <Label>Message</Label>
              <Textarea rows={3} value={form.message} onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
                placeholder="Hi! How can I help you today?" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="trigger-delay">Delay (seconds)</Label>
              <Input id="trigger-delay" type="number" min={0} max={86400} value={form.delay_seconds} disabled
                onChange={(e) => setForm((f) => ({ ...f, delay_seconds: parseInt(e.target.value || '0', 10) }))} />
              <p className="text-xs text-muted-foreground">
                Delay is not currently enforced. Live triggers execute immediately.
              </p>
            </div>
            <div className="flex items-end gap-2 pb-1">
              <Switch checked={form.enabled} onCheckedChange={(b) => setForm((f) => ({ ...f, enabled: b }))} />
              <span className="text-sm">Enabled</span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Optional" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {editing ? 'Save changes' : 'Create trigger'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}