import { useEffect, useState } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { aiAgentApi, type RoutingRule, type RoutingTrigger, type RoutingAction } from '@/lib/ai-agent-api';
import { useTranslation, type TranslationKey } from '@/i18n';
import { AiPageHeader } from '@/components/ai-agent/AiPageHeader';
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

type Translate = ReturnType<typeof useTranslation>['t'];

// Master label lookup for ALL 8 trigger types — used everywhere a persisted
// rule's trigger_type needs a human-readable label, including legacy rows
// that use a trigger type no longer offered for new rules (see
// UNSUPPORTED_NEW_TRIGGERS below). business_hours was wired by Follow-up 9C;
// low_confidence/no_answer were wired by Follow-up 9E.3 (post-strategy
// Routing) — none of the 6 live/wired triggers carry `unavailable` anymore.
// The label is a translation key (aiAgent.routing.triggers), read at render.
const TRIGGERS: { value: RoutingTrigger; labelKey: TranslationKey; unavailable?: boolean }[] = [
  { value: 'human_request', labelKey: 'aiAgent.routing.triggers.human_request' },
  { value: 'no_answer', labelKey: 'aiAgent.routing.triggers.no_answer' },
  { value: 'low_confidence', labelKey: 'aiAgent.routing.triggers.low_confidence' },
  { value: 'topic_detected', labelKey: 'aiAgent.routing.triggers.topic_detected' },
  { value: 'business_hours', labelKey: 'aiAgent.routing.triggers.business_hours' },
  { value: 'language', labelKey: 'aiAgent.routing.triggers.language' },
  { value: 'vip_customer', labelKey: 'aiAgent.routing.triggers.vip_customer' },
  { value: 'plan_limit', labelKey: 'aiAgent.routing.triggers.plan_limit' },
];
// Trigger types conclusively dead in the live engine with no data model to
// ever back them (plan_limit reads a field the answer strategy never
// populates; vip_customer has no canonical source of truth anywhere in the
// codebase — Follow-up 9B). Removed from the NEW-rule picker only; DB CHECK
// constraint, API zod enum, and existing persisted rows are untouched.
const UNSUPPORTED_NEW_TRIGGERS: RoutingTrigger[] = ['plan_limit', 'vip_customer'];

const ACTIONS: { value: RoutingAction; labelKey: TranslationKey; plannedOnly?: boolean }[] = [
  { value: 'handoff', labelKey: 'aiAgent.routing.actions.handoff' },
  { value: 'assign_team', labelKey: 'aiAgent.routing.actions.assign_team', plannedOnly: true },
  { value: 'assign_operator', labelKey: 'aiAgent.routing.actions.assign_operator', plannedOnly: true },
  { value: 'keep_ai', labelKey: 'aiAgent.routing.actions.keep_ai' },
  { value: 'create_ticket', labelKey: 'aiAgent.routing.actions.create_ticket', plannedOnly: true },
  { value: 'mark_priority', labelKey: 'aiAgent.routing.actions.mark_priority' },
];

// A persisted rule may carry a type this client does not know; it is shown
// as stored rather than hidden.
function triggerLabel(t: Translate, type: string): string {
  const def = TRIGGERS.find((x) => x.value === type);
  return def ? t(def.labelKey) : type;
}
function actionLabel(t: Translate, type: string): string {
  const def = ACTIONS.find((x) => x.value === type);
  return def ? t(def.labelKey) : type;
}

// What a failed request says, shown under a toast's title. It comes from the
// server or the network and is shown as it arrives.
function errorMessage(e: unknown): string | undefined {
  return (e as { message?: string } | null | undefined)?.message;
}

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
// The name and description are free text the owner can rename, so they are
// written in the dashboard's language when the rule is added.
type RoutingDraft = Omit<RoutingRule, 'id' | 'workspace_id' | 'created_at' | 'updated_at' | 'name' | 'description'>;
const DEFAULTS: Array<{ nameKey: TranslationKey; descriptionKey: TranslationKey; rule: RoutingDraft }> = [
  { nameKey: 'aiAgent.routing.defaults.humanRequestName', descriptionKey: 'aiAgent.routing.defaults.humanRequestDescription',
    rule: { trigger_type: 'human_request', conditions_json: {}, action_type: 'handoff', action_json: { target: 'main_inbox' }, priority: 10, enabled: true } },
];

export default function RoutingPage() {
  const { t } = useTranslation();
  const wsId = useCurrentWorkspace()?.id;
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
    } catch (e) {
      toast({ title: t('aiAgent.routing.toast.loadFailed'), description: errorMessage(e), variant: 'destructive' });
    } finally { setLoading(false); }
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the workspace changes
  }, [wsId]);

  async function toggle(r: RoutingRule) {
    try { await aiAgentApi.updateRouting(r.id, { enabled: !r.enabled });
      setItems((it) => it.map((x) => x.id === r.id ? { ...x, enabled: !r.enabled } : x));
    } catch (e) { toast({ title: t('aiAgent.routing.toast.updateFailed'), description: errorMessage(e), variant: 'destructive' }); }
  }
  async function remove(r: RoutingRule) {
    if (!confirm(t('aiAgent.routing.confirmDelete', { name: r.name }))) return;
    try { await aiAgentApi.deleteRouting(r.id); setItems((it) => it.filter((x) => x.id !== r.id));
    } catch (e) { toast({ title: t('aiAgent.routing.toast.deleteFailed'), description: errorMessage(e), variant: 'destructive' }); }
  }
  async function seed() {
    if (!wsId) return;
    try {
      for (const d of DEFAULTS) {
        await aiAgentApi.createRouting({ workspaceId: wsId, name: t(d.nameKey), description: t(d.descriptionKey), ...d.rule });
      }
      toast({ title: t('aiAgent.routing.toast.seeded') }); refresh();
    } catch (e) { toast({ title: t('aiAgent.routing.toast.seedFailed'), description: errorMessage(e), variant: 'destructive' }); }
  }

  if (!wsId) return null;

  return (
    <div className="space-y-6">
      <AiPageHeader
        icon={RouteIcon}
        accent="sky"
        title={t('aiAgent.routing.title')}
        subtitle={t('aiAgent.routing.subtitle')}
        actions={(
          <Button onClick={() => { setEditing(null); setOpen(true); }}>
            <Plus className="h-4 w-4 me-1.5" /> {t('aiAgent.routing.addRule')}
          </Button>
        )}
      />

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-4">
            <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 text-primary flex items-center justify-center">
              <RouteIcon className="h-7 w-7" />
            </div>
            <div>
              <h2 className="text-lg font-medium">{t('aiAgent.routing.empty.title')}</h2>
              <p className="text-sm text-muted-foreground max-w-md mx-auto mt-1">
                {t('aiAgent.routing.empty.description')}
              </p>
            </div>
            <div className="flex justify-center gap-2 pt-2">
              <Button variant="outline" onClick={seed}>{t('aiAgent.routing.empty.addDefaults')}</Button>
              <Button onClick={() => { setEditing(null); setOpen(true); }}>
                <Plus className="h-4 w-4 me-1.5" /> {t('aiAgent.routing.empty.addRule')}
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
                    <span className="text-[11px] text-muted-foreground">{t('aiAgent.routing.card.priority', { priority: r.priority })}</span>
                  </div>
                  {r.description && <p className="text-xs text-muted-foreground mt-1">{r.description}</p>}
                  <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
                    <Badge variant="outline">{t('aiAgent.routing.card.trigger', { label: triggerLabel(t, r.trigger_type) })}</Badge>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground rtl:rotate-180" />
                    <Badge variant="outline" className="bg-primary/5">{t('aiAgent.routing.card.action', { label: actionLabel(t, r.action_type) })}</Badge>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={r.enabled} onCheckedChange={() => toggle(r)} aria-label={t('aiAgent.routing.card.enabled')} />
                  <Button variant="ghost" size="icon" aria-label={t('aiAgent.routing.card.edit')} onClick={() => { setEditing(r); setOpen(true); }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={t('aiAgent.routing.card.delete')} onClick={() => remove(r)}>
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
  const { t } = useTranslation();
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
    (opt) => !UNSUPPORTED_NEW_TRIGGERS.includes(opt.value) || opt.value === editing?.trigger_type,
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
      const c = (editing.conditions_json || {}) as Record<string, unknown>;
      const a = (editing.action_json || {}) as Record<string, unknown>;
      const topicClass = editing.trigger_type === 'topic_detected' ? classifyTopicCondition(c) : null;
      setForm({
        name: editing.name, description: editing.description || '',
        trigger_type: editing.trigger_type, action_type: editing.action_type,
        priority: editing.priority, enabled: editing.enabled,
        // A legacy/dormant persisted filter is surfaced truthfully (not
        // always read from c.topic — Follow-up 9F.1); a genuinely dormant
        // row (no unambiguous single value) leaves the field blank.
        topic: topicClass && topicClass.kind !== 'dormant' ? topicClass.value : '',
        team_slug: (a.team_slug as string) || '',
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
    if (!form.name.trim()) { toast({ title: t('aiAgent.routing.toast.nameRequired'), variant: 'destructive' }); return; }

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
        toast({ title: t('aiAgent.routing.toast.invalidConfidence'), description: t('aiAgent.routing.toast.invalidConfidenceHint'), variant: 'destructive' });
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
      toast({ title: t('aiAgent.routing.toast.topicRequired'), description: t('aiAgent.routing.toast.topicRequiredHint'), variant: 'destructive' });
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
    } catch (e) {
      toast({ title: t('aiAgent.routing.toast.saveFailed'), description: errorMessage(e), variant: 'destructive' });
    } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? t('aiAgent.routing.dialog.editTitle') : t('aiAgent.routing.dialog.newTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="routing-rule-name">{t('aiAgent.routing.dialog.name')}</Label>
            <Input id="routing-rule-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('aiAgent.routing.dialog.description')}</Label>
            <Textarea rows={2} value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('aiAgent.routing.dialog.trigger')}</Label>
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
                  {triggerOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.unavailable
                        ? t('aiAgent.routing.option.notLiveYet', { label: t(opt.labelKey) })
                        : t(opt.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('aiAgent.routing.dialog.action')}</Label>
              <Select value={form.action_type} onValueChange={(v) => setForm((f) => ({ ...f, action_type: v as RoutingAction }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ACTIONS.map((a) => {
                    const illegalForTrigger = isActionIllegalForTrigger(a.value, form.trigger_type);
                    const disabled = a.plannedOnly || illegalForTrigger;
                    const label = t(a.labelKey);
                    return (
                      <SelectItem key={a.value} value={a.value} disabled={disabled}>
                        {a.plannedOnly
                          ? t('aiAgent.routing.option.comingSoon', { label })
                          : illegalForTrigger ? t('aiAgent.routing.option.notApplicable', { label }) : label}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {form.action_type === 'keep_ai' && (
                <p className="text-xs text-muted-foreground">
                  {t('aiAgent.routing.dialog.keepAiNote')}
                </p>
              )}
            </div>
          </div>
          {form.trigger_type === 'topic_detected' && (
            <div className="space-y-1.5">
              <Label htmlFor="routing-topic-name">{t('aiAgent.routing.dialog.topicName')}</Label>
              <Input id="routing-topic-name" required value={form.topic}
                onChange={(e) => {
                  setForm((f) => ({ ...f, topic: e.target.value }));
                  setTopicEdited(true);
                }}
                placeholder={t('aiAgent.routing.dialog.topicPlaceholder')} />
              <p className="text-xs text-muted-foreground">
                {t('aiAgent.routing.dialog.topicHint')}
              </p>
              {showTopicLegacyNote && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {topicEdited
                    ? t('aiAgent.routing.dialog.topicConvertPending')
                    : topicClassification?.kind === 'dormant'
                      ? t('aiAgent.routing.dialog.topicDormant')
                      : t('aiAgent.routing.dialog.topicLegacy')}
                </p>
              )}
            </div>
          )}
          {form.trigger_type === 'low_confidence' && (
            <div className="space-y-1.5">
              <Label htmlFor="routing-confidence-below">{t('aiAgent.routing.dialog.confidence')}</Label>
              <Input id="routing-confidence-below" type="number" min={0} max={1} step={0.05} required
                value={form.confidenceBelow}
                onChange={(e) => {
                  setForm((f) => ({ ...f, confidenceBelow: e.target.value }));
                  setConfidenceBelowEdited(true);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t('aiAgent.routing.dialog.confidenceHint')}
              </p>
              {showLegacyConversionNote && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {confidenceBelowEdited
                    ? t('aiAgent.routing.dialog.confidenceConvertPending')
                    : t('aiAgent.routing.dialog.confidenceLegacy')}
                </p>
              )}
            </div>
          )}
          {form.action_type === 'assign_team' && (
            <div className="space-y-1.5">
              <Label>{t('aiAgent.routing.dialog.teamSlug')}</Label>
              <Input value={form.team_slug} onChange={(e) => setForm((f) => ({ ...f, team_slug: e.target.value }))}
                placeholder={t('aiAgent.routing.dialog.teamSlugPlaceholder')} />
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>{t('aiAgent.routing.dialog.priority')}</Label>
              <Input type="number" min={0} max={10000} value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: parseInt(e.target.value || '100', 10) }))} />
            </div>
            <div className="flex items-end gap-2 pb-1">
              <Switch checked={form.enabled} onCheckedChange={(b) => setForm((f) => ({ ...f, enabled: b }))} />
              <span className="text-sm">{t('aiAgent.routing.dialog.enabled')}</span>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('aiAgent.routing.dialog.cancel')}</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 me-1.5 animate-spin" />}
            {editing ? t('aiAgent.routing.dialog.saveChanges') : t('aiAgent.routing.dialog.createRule')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
