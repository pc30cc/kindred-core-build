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
// UNSUPPORTED_NEW_TRIGGERS below). business_hours was wired by Follow-up 9C;
// low_confidence/no_answer were wired by Follow-up 9E.3 (post-strategy
// Routing) — none of the 6 live/wired triggers carry `unavailable` anymore.
const TRIGGERS: { value: RoutingTrigger; label: string; unavailable?: boolean }[] = [
  { value: 'human_request', label: 'Visitor asks for a human' },
  { value: 'no_answer', label: 'AI cannot answer' },
  { value: 'low_confidence', label: 'AI confidence is low' },
  { value: 'topic_detected', label: 'A specific topic is detected' },
  { value: 'business_hours', label: 'Outside business hours' },
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
// no_answer -> keep_ai is not a valid runtime combination (there is no
// usable grounding to "keep the AI handling" with — Follow-up 9D.1/9E.2).
// UI disabling alone is not a full guarantee (the API/DB can still contain
// such a row), but it stops NEW creation of the combination.
function isActionIllegalForTrigger(action: RoutingAction, trigger: RoutingTrigger): boolean {
  return action === 'keep_ai' && trigger === 'no_answer';
}

// A starter/default rule must never use an action or trigger type the
// picker itself marks unavailable/coming-soon (Follow-up 9C.1) — the
// previous 'Pricing topic → sales' / 'Technical issue → support' defaults
// both used action_type=assign_team, which is planned-only and never
// executes. Removed outright rather than swapped to a different live
// action, to avoid silently changing their product semantics.
const DEFAULTS: Array<Omit<RoutingRule, 'id' | 'workspace_id' | 'created_at' | 'updated_at'>> = [
  { name: 'Visitor asks for a human → handoff', description: 'Always escalate when a visitor asks for a person',
    trigger_type: 'human_request', conditions_json: {}, action_type: 'handoff', action_json: { target: 'main_inbox' }, priority: 10, enabled: true },
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

// Legacy low_confidence rows persisted before Follow-up 9E.3 used
// {threshold, consecutive} instead of (or alongside) the canonical
// {confidence_below}. The runtime keeps ANY row carrying one of these keys
// dormant rather than reinterpreting or partially evaluating it — see
// routingRuntime.ts's LOW_CONFIDENCE_UNSUPPORTED_KEYS — so a mixed row like
// {confidence_below: 0.5, consecutive: 2} is still dormant, and the UI must
// not present it as a clean, active canonical rule (Follow-up 9E.3.1).
function isLegacyLowConfidenceConditions(cond: Record<string, unknown>): boolean {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(cond, k);
  return has('threshold') || has('consecutive');
}

function initialConditionsFor(triggerType: RoutingTrigger, topic: string, confidenceBelow: number): Record<string, unknown> {
  // topic is validated non-blank by save() before this is ever called for
  // topic_detected (Follow-up 9F.1) — a topic_detected rule can no longer
  // be saved with an empty {} filter.
  if (triggerType === 'topic_detected') return { topic };
  if (triggerType === 'low_confidence') return { confidence_below: confidenceBelow };
  return {};
}

const TOPIC_FILTER_KEYS = ['topic', 'topic_slug', 'topic_slugs'] as const;

// Mirrors server/services/ai-agent/runtime/routingRuntime.ts's
// classifyTopicFilter (Follow-up 9F.1) — kept as a small, self-contained
// client-side classifier (that file is server-only, not importable here) so
// the dialog can truthfully display and convert legacy/dormant rows instead
// of always reading only conditions_json.topic (which silently rendered
// blank for every legacy/malformed shape before this follow-up).
function classifyTopicCondition(cond: Record<string, unknown>):
  | { kind: 'canonical' | 'legacy_scalar' | 'legacy_plural'; value: string }
  | { kind: 'dormant' } {
  const keys = Object.keys(cond);
  const recognized = keys.filter((k) => (TOPIC_FILTER_KEYS as readonly string[]).includes(k));
  const unrecognized = keys.filter((k) => !(TOPIC_FILTER_KEYS as readonly string[]).includes(k));
  if (keys.length === 0 || recognized.length !== 1 || unrecognized.length > 0) return { kind: 'dormant' };

  const key = recognized[0] as typeof TOPIC_FILTER_KEYS[number];
  if (key === 'topic' || key === 'topic_slug') {
    const v = cond[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      return { kind: key === 'topic' ? 'canonical' : 'legacy_scalar', value: v.trim() };
    }
    return { kind: 'dormant' };
  }
  // key === 'topic_slugs' — narrow single-element-array compatibility only.
  const v = cond.topic_slugs;
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'string' && (v[0] as string).trim().length > 0) {
    return { kind: 'legacy_plural', value: (v[0] as string).trim() };
  }
  return { kind: 'dormant' };
}

function initialActionPayloadFor(actionType: RoutingAction, teamSlug: string): Record<string, unknown> {
  if (actionType === 'handoff') return { target: 'main_inbox' };
  if (actionType === 'assign_team') return teamSlug ? { team_slug: teamSlug } : {};
  return {};
}

// Follow-up 9E.3.1 — strict validation for explicit Save. 0.5 is a
// canonical DEFAULT (new rule / freshly-switched trigger / genuine runtime
// absence) but is NEVER an error-recovery value for malformed user input —
// returns null (rather than silently coercing to 0.5) for blank, non-finite,
// or out-of-[0,1]-range values, so the caller can block the API call.
function parseConfidenceBelowStrict(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
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
    topic: '', team_slug: '', confidenceBelow: '',
  });
  const [saving, setSaving] = useState(false);
  // Dirty-tracks only the confidence_below field — a plain unrelated save
  // (name/description/priority/enabled) must never convert a legacy
  // threshold/consecutive row; only an explicit edit of THIS field does
  // (Follow-up 9E.2/9E.3 canonical legacy conversion contract).
  const [confidenceBelowEdited, setConfidenceBelowEdited] = useState(false);
  // Same dirty-tracking pattern for the Topic name field (Follow-up 9F.1) —
  // a plain unrelated save must never convert a legacy topic_slug/
  // topic_slugs/dormant row; only an explicit edit of THIS field does.
  const [topicEdited, setTopicEdited] = useState(false);

  // New rules can't use a conclusively-dead trigger type — but if we're
  // editing an existing rule that already persisted one, keep that single
  // option renderable so the Select can display the current value without
  // silently corrupting it (see Follow-up 9C).
  const triggerOptions = TRIGGERS.filter(
    (t) => !UNSUPPORTED_NEW_TRIGGERS.includes(t.value) || t.value === editing?.trigger_type,
  );

  const editingConditions = (editing?.conditions_json || {}) as Record<string, unknown>;
  const showLegacyConversionNote =
    form.trigger_type === 'low_confidence'
    && editing?.trigger_type === 'low_confidence'
    && isLegacyLowConfidenceConditions(editingConditions);

  const topicClassification =
    editing?.trigger_type === 'topic_detected' ? classifyTopicCondition(editingConditions) : null;
  // Shown for legacy_scalar/legacy_plural (still works, compatibility note)
  // AND dormant (unsupported/ambiguous, currently inactive) — never for a
  // clean canonical row.
  const showTopicLegacyNote =
    form.trigger_type === 'topic_detected'
    && editing?.trigger_type === 'topic_detected'
    && !!topicClassification
    && topicClassification.kind !== 'canonical';

  useEffect(() => {
    if (editing) {
      const c = (editing.conditions_json || {}) as any;
      const a = (editing.action_json || {}) as any;
      const topicClass = editing.trigger_type === 'topic_detected' ? classifyTopicCondition(c) : null;
      setForm({
        name: editing.name, description: editing.description || '',
        trigger_type: editing.trigger_type, action_type: editing.action_type,
        priority: editing.priority, enabled: editing.enabled,
        // A legacy/dormant persisted filter is surfaced truthfully (not
        // always read from c.topic — Follow-up 9F.1); a genuinely dormant
        // row (no unambiguous single value) leaves the field blank.
        topic: topicClass && topicClass.kind !== 'dormant' ? topicClass.value : '',
        team_slug: a.team_slug || '',
        confidenceBelow: typeof c.confidence_below === 'number' ? String(c.confidence_below) : '',
      });
    } else {
      setForm({ name: '', description: '', trigger_type: 'human_request', action_type: 'handoff',
        priority: 100, enabled: true, topic: '', team_slug: '', confidenceBelow: '0.5' });
    }
    setConfidenceBelowEdited(false);
    setTopicEdited(false);
  }, [editing, open]);

  async function save() {
    if (!form.name.trim()) { toast({ title: 'Name is required', variant: 'destructive' }); return; }

    const triggerChanged = editing ? form.trigger_type !== editing.trigger_type : false;
    const actionChanged = editing ? form.action_type !== editing.action_type : false;

    // Follow-up 9E.3.1 — validate confidence_below strictly BEFORE any API
    // call, whenever THIS save is the one responsible for persisting it
    // (new rule, trigger freshly switched to low_confidence, or an explicit
    // edit of the field on an unchanged low_confidence rule). The
    // Input's type/min/max/required attributes do not block save() since
    // this dialog is not a native HTML form.
    const persistingCanonicalConfidence =
      form.trigger_type === 'low_confidence' && (!editing || triggerChanged || confidenceBelowEdited);
    let validatedConfidenceBelow: number | null = null;
    if (persistingCanonicalConfidence) {
      validatedConfidenceBelow = parseConfidenceBelowStrict(form.confidenceBelow);
      if (validatedConfidenceBelow === null) {
        toast({ title: 'Invalid confidence threshold', description: 'Enter a number between 0 and 1 (e.g. 0.5).', variant: 'destructive' });
        return;
      }
    }

    // Follow-up 9F.1 — same strict-validation-before-any-API-call pattern
    // for the Topic name field, whenever THIS save is the one responsible
    // for persisting it. conditions_json:{} for topic_detected is invalid/
    // incomplete configuration, not "match any detected topic" — it must
    // never be silently saved.
    const persistingCanonicalTopic =
      form.trigger_type === 'topic_detected' && (!editing || triggerChanged || topicEdited);
    const trimmedTopic = form.topic.trim();
    if (persistingCanonicalTopic && trimmedTopic === '') {
      toast({ title: 'Topic name is required', description: 'Enter the topic slug this rule should match (e.g. billing).', variant: 'destructive' });
      return;
    }

    setSaving(true);
    try {
      // conditions_json — round-trip contract (Follow-up 9E.2/9E.3/9F.1):
      //  - new rule, or trigger_type explicitly changed: drop any old
      //    trigger-specific payload, initialize ONLY the new trigger's
      //    canonical state.
      //  - trigger_type unchanged + explicit canonical-field edit: convert
      //    (drop legacy/unsupported keys, persist ONLY the canonical value).
      //  - otherwise (a genuinely unrelated edit): preserve the persisted
      //    conditions_json exactly, including unknown/legacy/dormant keys —
      //    no edit path may layer a canonical key onto stale legacy keys.
      let conditions_json: Record<string, unknown>;
      if (!editing || triggerChanged) {
        conditions_json = initialConditionsFor(form.trigger_type, trimmedTopic, validatedConfidenceBelow ?? 0.5);
      } else if (form.trigger_type === 'low_confidence' && confidenceBelowEdited) {
        conditions_json = { confidence_below: validatedConfidenceBelow as number };
      } else if (form.trigger_type === 'topic_detected' && topicEdited) {
        conditions_json = { topic: trimmedTopic };
      } else {
        conditions_json = { ...editingConditions };
      }

      // action_json — same round-trip contract, keyed on action_type change.
      let action_json: Record<string, unknown>;
      const editingAction = (editing?.action_json || {}) as Record<string, unknown>;
      if (!editing || actionChanged) {
        action_json = initialActionPayloadFor(form.action_type, form.team_slug);
      } else {
        action_json = { ...editingAction };
        if (form.action_type === 'assign_team' && form.team_slug !== (editingAction.team_slug || '')) {
          action_json = { ...action_json, team_slug: form.team_slug };
        }
      }

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
            <Label htmlFor="routing-rule-name">Name</Label>
            <Input id="routing-rule-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea rows={2} value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>When (trigger)</Label>
              <Select value={form.trigger_type} onValueChange={(v) => {
                const nextType = v as RoutingTrigger;
                setForm((f) => ({
                  ...f,
                  trigger_type: nextType,
                  // Switching to low_confidence always starts from the
                  // canonical default — never carries a stale value over
                  // from a different trigger (Follow-up 9E.3 LEG4).
                  confidenceBelow: nextType === 'low_confidence' ? '0.5' : f.confidenceBelow,
                  // no_answer + keep_ai is not a valid combination — clear
                  // the action back to a safe default when it would land there.
                  action_type: isActionIllegalForTrigger(f.action_type, nextType) ? 'handoff' : f.action_type,
                }));
                setConfidenceBelowEdited(false);
                setTopicEdited(false);
              }}>
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
                  {ACTIONS.map((a) => {
                    const illegalForTrigger = isActionIllegalForTrigger(a.value, form.trigger_type);
                    const disabled = a.plannedOnly || illegalForTrigger;
                    return (
                      <SelectItem key={a.value} value={a.value} disabled={disabled}>
                        {a.label}{a.plannedOnly ? ' — coming soon' : illegalForTrigger ? ' — not applicable' : ''}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {form.action_type === 'keep_ai' && (
                <p className="text-xs text-muted-foreground">
                  Has no effect when "Answer only from knowledge base" blocks an ungrounded reply.
                </p>
              )}
            </div>
          </div>
          {form.trigger_type === 'topic_detected' && (
            <div className="space-y-1.5">
              <Label htmlFor="routing-topic-name">Topic name</Label>
              <Input id="routing-topic-name" required value={form.topic}
                onChange={(e) => {
                  setForm((f) => ({ ...f, topic: e.target.value }));
                  setTopicEdited(true);
                }}
                placeholder="e.g. pricing, technical_issue" />
              <p className="text-xs text-muted-foreground">
                Match only when the AI detects this exact topic slug.
              </p>
              {showTopicLegacyNote && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {topicEdited
                    ? 'Saving will replace the legacy/unsupported filter with the topic value above.'
                    : topicClassification?.kind === 'dormant'
                      ? "This rule's topic filter is unsupported or ambiguous and is currently inactive. Enter a topic name above to convert it to the supported format — other edits will preserve the persisted filter as-is."
                      : 'This rule uses a legacy topic filter. It still works for compatibility. Changing the Topic name will convert it to the current format.'}
                </p>
              )}
            </div>
          )}
          {form.trigger_type === 'low_confidence' && (
            <div className="space-y-1.5">
              <Label htmlFor="routing-confidence-below">Confidence threshold</Label>
              <Input id="routing-confidence-below" type="number" min={0} max={1} step={0.05} required
                value={form.confidenceBelow}
                onChange={(e) => {
                  setForm((f) => ({ ...f, confidenceBelow: e.target.value }));
                  setConfidenceBelowEdited(true);
                }}
              />
              <p className="text-xs text-muted-foreground">
                Match when the AI's confidence score falls below this value (0 = no confidence, 1 = fully confident).
              </p>
              {showLegacyConversionNote && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {confidenceBelowEdited
                    ? 'Saving will replace the legacy condition with the confidence value above.'
                    : 'This rule uses an older, unsupported condition and is currently inactive. Change the confidence threshold above to convert it to the supported format — other edits will preserve the legacy condition as-is.'}
                </p>
              )}
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