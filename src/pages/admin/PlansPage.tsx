import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  useAdminPlans, useCreatePlan, useUpdatePlan, useDeletePlan,
  useAdminSubscriptions, useAssignPlan, useRevokePlan,
} from '@/hooks/usePlans';
import { useAdminWorkspaces } from '@/hooks/useAdmin';
import { supabase } from '@/lib/supabase';
import {
  useCapabilityCatalog,
  useWorkspaceEffectiveEntitlements,
  useEntitlementDiagnostics,
} from '@/hooks/useEntitlements';
import {
  validatePlanPayload,
  setWorkspaceModuleOverride,
  setWorkspaceChannelOverride,
  deleteWorkspaceModuleOverride,
  deleteWorkspaceChannelOverride,
  setWorkspaceLimitOverride,
  deleteWorkspaceLimitOverride,
  fetchWorkspaceOverrides,
  groupCapabilities,
  type CapabilityDefinition,
} from '@/lib/entitlements-api';
import {
  Plus, Edit2, Trash2, Shield, CreditCard, Users, Loader2,
  CheckCircle2, XCircle, Crown, Globe, AlertTriangle, Activity,
  SlidersHorizontal, Settings2, RefreshCw, Info, RotateCcw,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { useQuery } from '@tanstack/react-query';

// ─── Constants ───
const CURRENCIES = ['USD', 'EUR', 'TRY', 'IRR'];
const LOCALE_LABELS: Record<string, string> = {
  en: '🇬🇧 English', tr: '🇹🇷 Türkçe', fa: '🇮🇷 فارسی',
  de: '🇩🇪 Deutsch', fr: '🇫🇷 Français', ar: '🇸🇦 العربية',
};

interface LocalizedPlan { name: string; description: string; }

interface PlanFormData {
  name: string; slug: string; description: string;
  is_free: boolean; is_active: boolean; is_hidden: boolean; sort_order: number; trial_days: number;
  default_currency: string;
  prices: Record<string, { monthly: number; yearly: number }>;
  entitlements: Record<string, boolean>;
  limits: Record<string, number>;
  provider_price_ids: Record<string, any>;
  localized: Record<string, LocalizedPlan>;
  /** Keys present in DB but not in current registry — preserved verbatim. */
  legacyEntitlements: Record<string, unknown>;
  legacyLimits: Record<string, unknown>;
}

function usePlatformLocales() {
  return useQuery({
    queryKey: ['platform-settings-locales'],
    queryFn: async () => {
      const { data } = await supabase
        .from('platform_settings').select('active_locales').limit(1).maybeSingle();
      return { locales: (data?.active_locales || ['en']) as string[] };
    },
  });
}

// ─── Registry-aware form helpers ───

function buildFormFromRegistry(
  capabilities: CapabilityDefinition[],
  locales: string[],
  plan?: any,
): PlanFormData {
  const knownKeys = new Set(capabilities.map((c) => c.key));
  const entitlements: Record<string, boolean> = {};
  const limits: Record<string, number> = {};
  const legacyEntitlements: Record<string, unknown> = {};
  const legacyLimits: Record<string, unknown> = {};

  // Seed from registry defaults (booleans -> entitlements; numerics -> limits)
  for (const cap of capabilities) {
    if (cap.type === 'limit') {
      limits[cap.key] = typeof cap.defaultValue === 'number' ? cap.defaultValue : 0;
    } else {
      entitlements[cap.key] = typeof cap.defaultValue === 'boolean' ? cap.defaultValue : false;
    }
  }

  // Merge plan values, preserving legacy keys verbatim
  const planEnt = (plan?.entitlements || {}) as Record<string, unknown>;
  const planLim = (plan?.limits || {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(planEnt)) {
    if (knownKeys.has(k)) entitlements[k] = Boolean(v);
    else legacyEntitlements[k] = v;
  }
  for (const [k, v] of Object.entries(planLim)) {
    if (knownKeys.has(k)) limits[k] = typeof v === 'number' ? v : Number(v) || 0;
    else legacyLimits[k] = v;
  }

  const existingLocalized = (plan?.localized || {}) as Record<string, LocalizedPlan>;
  return {
    name: plan?.name || '', slug: plan?.slug || '', description: plan?.description || '',
    is_free: plan?.is_free || false, is_active: plan ? plan.is_active !== false : true,
    is_hidden: plan?.is_hidden || false,
    sort_order: plan?.sort_order || 0, trial_days: plan?.trial_days || 0,
    default_currency: plan?.default_currency || 'USD',
    prices: {
      ...Object.fromEntries(CURRENCIES.map((c) => [c, { monthly: 0, yearly: 0 }])),
      ...(plan?.prices || {}),
    },
    entitlements, limits,
    provider_price_ids: plan?.provider_price_ids || {},
    localized: Object.fromEntries(locales.map((l) => [l, existingLocalized[l] || { name: '', description: '' }])),
    legacyEntitlements, legacyLimits,
  };
}

/** Compose final JSON payload, preserving legacy keys. */
function formToPayload(form: PlanFormData) {
  return {
    name: form.name, slug: form.slug, description: form.description,
    is_free: form.is_free, is_active: form.is_active, is_hidden: form.is_hidden,
    sort_order: form.sort_order, trial_days: form.trial_days,
    default_currency: form.default_currency,
    prices: form.prices,
    entitlements: { ...form.legacyEntitlements, ...form.entitlements },
    limits: { ...form.legacyLimits, ...form.limits },
    provider_price_ids: form.provider_price_ids,
    localized: form.localized,
  };
}

// ─── Plan Form Dialog (registry-driven) ───
function PlanFormDialog({
  plan, onClose, locales, capabilities,
}: {
  plan?: any; onClose: () => void; locales: string[]; capabilities: CapabilityDefinition[];
}) {
  const [form, setForm] = useState<PlanFormData>(() => buildFormFromRegistry(capabilities, locales, plan));
  const [activeSection, setActiveSection] = useState('general');
  const [issues, setIssues] = useState<Array<{ level: 'error' | 'warning'; key: string; message: string }>>([]);
  const createPlan = useCreatePlan();
  const updatePlan = useUpdatePlan();
  const isEdit = !!plan?.id;
  const isPending = createPlan.isPending || updatePlan.isPending;

  // Partition capabilities by type
  const byType = useMemo(() => ({
    module: capabilities.filter((c) => c.type === 'module').sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    channel: capabilities.filter((c) => c.type === 'channel').sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    feature: capabilities.filter((c) => c.type === 'feature'),
    limit: capabilities.filter((c) => c.type === 'limit'),
  }), [capabilities]);

  const featuresByGroup = useMemo(() => groupCapabilities(byType.feature), [byType.feature]);
  const limitsByGroup = useMemo(() => groupCapabilities(byType.limit), [byType.limit]);

  async function handleSubmit() {
    if (!form.name || !form.slug) { toast.error('Name and slug are required'); return; }
    const payload = formToPayload(form);
    // Soft validation
    try {
      const v = await validatePlanPayload({ entitlements: payload.entitlements, limits: payload.limits });
      setIssues(v.issues);
      const errs = v.issues.filter((i) => i.level === 'error');
      if (errs.length) {
        toast.error(`${errs.length} validation error(s)`);
        return;
      }
      const warns = v.issues.filter((i) => i.level === 'warning');
      if (warns.length) toast.warning(`${warns.length} warning(s) — saving anyway`);
    } catch (e: any) {
      // Validation endpoint failure is non-fatal
      console.warn('Validation skipped:', e?.message);
    }
    try {
      if (isEdit) {
        await updatePlan.mutateAsync({ planId: plan.id, ...payload });
        toast.success('Plan updated');
      } else {
        await createPlan.mutateAsync(payload);
        toast.success('Plan created');
      }
      onClose();
    } catch (e: any) { toast.error(e.message); }
  }

  function setBool(key: string, val: boolean) {
    setForm((f) => ({ ...f, entitlements: { ...f.entitlements, [key]: val } }));
  }
  function setLimit(key: string, val: number) {
    setForm((f) => ({ ...f, limits: { ...f.limits, [key]: val } }));
  }
  function updateLocalized(locale: string, field: string, value: string) {
    setForm((f) => ({ ...f, localized: { ...f.localized, [locale]: { ...f.localized[locale], [field]: value } } }));
  }

  const hasLegacy = Object.keys(form.legacyEntitlements).length + Object.keys(form.legacyLimits).length > 0;

  const sections = [
    { id: 'general', label: 'General' },
    { id: 'modules', label: `Modules (${byType.module.length})` },
    { id: 'channels', label: `Channels (${byType.channel.length})` },
    { id: 'features', label: `Features (${byType.feature.length})` },
    { id: 'limits', label: `Limits (${byType.limit.length})` },
    { id: 'pricing', label: 'Pricing' },
    { id: 'locales', label: 'Translations' },
    ...(hasLegacy ? [{ id: 'legacy', label: '⚠ Legacy' }] : []),
  ];

  const renderBoolList = (caps: CapabilityDefinition[]) => (
    <div className="grid grid-cols-1 gap-1">
      {caps.map((cap) => {
        const enabled = !!form.entitlements[cap.key];
        return (
          <div
            key={cap.key}
            className={`flex items-start justify-between gap-3 px-3 py-2.5 rounded-lg border transition-colors ${enabled ? 'border-primary/30 bg-primary/5' : 'border-transparent bg-muted/30 hover:bg-muted/50'}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-sm font-medium ${enabled ? 'text-foreground' : 'text-muted-foreground'}`}>{cap.label}</span>
                <Badge variant="outline" className="text-[10px] font-mono">{cap.key}</Badge>
                {!cap.workspaceOverridable && <Badge variant="secondary" className="text-[9px]">no-override</Badge>}
                {cap.internalOnly && <Badge variant="secondary" className="text-[9px]">internal</Badge>}
              </div>
              {cap.description && <p className="text-[11px] text-muted-foreground mt-0.5">{cap.description}</p>}
            </div>
            <Switch checked={enabled} onCheckedChange={(v) => setBool(cap.key, v)} />
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
      {/* Sidebar nav */}
      <aside className="md:w-56 shrink-0 border-b md:border-b-0 md:border-e border-border bg-muted/30 p-2 md:p-3 overflow-x-auto md:overflow-y-auto">
        <nav className="flex md:flex-col gap-1">
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveSection(s.id)}
              className={`text-start text-xs px-3 py-2 rounded-md whitespace-nowrap transition-colors ${
                activeSection === s.id
                  ? 'bg-primary text-primary-foreground font-medium shadow-sm'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Body + footer */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 overflow-y-auto p-5 space-y-4 min-h-0">
        {activeSection === 'general' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Plan Name</Label>
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Pro" />
              </div>
              <div>
                <Label>Slug</Label>
                <Input value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') }))} placeholder="pro" disabled={isEdit} />
              </div>
            </div>
            <div>
              <Label>Description</Label>
              <Textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Sort Order</Label>
                <Input type="number" value={form.sort_order} onChange={(e) => setForm((f) => ({ ...f, sort_order: parseInt(e.target.value) || 0 }))} />
              </div>
              <div>
                <Label>Trial Days</Label>
                <Input type="number" value={form.trial_days} onChange={(e) => setForm((f) => ({ ...f, trial_days: parseInt(e.target.value) || 0 }))} />
              </div>
            </div>
            <Separator />
            <div className="flex gap-6">
              <div className="flex items-center gap-2">
                <Switch checked={form.is_free} onCheckedChange={(v) => setForm((f) => ({ ...f, is_free: v }))} />
                <Label>Free Plan</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={form.is_active} onCheckedChange={(v) => setForm((f) => ({ ...f, is_active: v }))} />
                <Label>Active</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={form.is_hidden} onCheckedChange={(v) => setForm((f) => ({ ...f, is_hidden: v }))} />
                <Label>Hidden from users</Label>
              </div>
            </div>
          </div>
        )}

        {activeSection === 'modules' && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Top-level modules included in this plan. Sourced from capability registry.</p>
            {renderBoolList(byType.module)}
          </div>
        )}

        {activeSection === 'channels' && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Messaging channels available to workspaces on this plan.</p>
            {renderBoolList(byType.channel)}
          </div>
        )}

        {activeSection === 'features' && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">Boolean feature flags, grouped by domain.</p>
            {Object.entries(featuresByGroup).map(([group, caps]) => (
              <div key={group} className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</p>
                {renderBoolList(caps)}
              </div>
            ))}
          </div>
        )}

        {activeSection === 'limits' && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">Numeric limits. Use <code className="bg-muted px-1 rounded">-1</code> for unlimited.</p>
            {Object.entries(limitsByGroup).map(([group, caps]) => (
              <div key={group} className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</p>
                <div className="grid grid-cols-2 gap-3">
                  {caps.map((cap) => (
                    <div key={cap.key} className="space-y-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Label className="text-xs">{cap.label}</Label>
                        {cap.unit && <Badge variant="outline" className="text-[9px] font-normal">{cap.unit}</Badge>}
                      </div>
                      <Input
                        type="number"
                        value={form.limits[cap.key] ?? 0}
                        onChange={(e) => setLimit(cap.key, parseInt(e.target.value) || 0)}
                      />
                      {cap.description && <p className="text-[10px] text-muted-foreground">{cap.description}</p>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {activeSection === 'pricing' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Pricing per currency. Payment gateway auto-selected per locale.</p>
            <div className="grid grid-cols-2 gap-3">
              {CURRENCIES.map((cur) => (
                <Card key={cur} className="bg-muted/20 border-border">
                  <CardContent className="pt-3 pb-3 space-y-2">
                    <p className="text-xs font-bold text-foreground">{cur}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-[11px]">Monthly</Label>
                        <Input type="number" value={form.prices[cur]?.monthly || 0}
                          onChange={(e) => setForm((f) => ({ ...f, prices: { ...f.prices, [cur]: { ...f.prices[cur], monthly: parseInt(e.target.value) || 0 } } }))} />
                      </div>
                      <div>
                        <Label className="text-[11px]">Yearly</Label>
                        <Input type="number" value={form.prices[cur]?.yearly || 0}
                          onChange={(e) => setForm((f) => ({ ...f, prices: { ...f.prices, [cur]: { ...f.prices[cur], yearly: parseInt(e.target.value) || 0 } } }))} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {activeSection === 'locales' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Localized plan names per language.</p>
            {locales.map((loc) => (
              <Card key={loc} className="bg-muted/20 border-border">
                <CardContent className="pt-3 pb-3 space-y-2">
                  <p className="text-xs font-bold text-foreground">{LOCALE_LABELS[loc] || loc.toUpperCase()}</p>
                  <Input
                    value={form.localized[loc]?.name || ''}
                    onChange={(e) => updateLocalized(loc, 'name', e.target.value)}
                    placeholder={`Plan name in ${loc}`}
                    dir={loc === 'fa' || loc === 'ar' ? 'rtl' : 'ltr'}
                  />
                  <Textarea
                    value={form.localized[loc]?.description || ''}
                    onChange={(e) => updateLocalized(loc, 'description', e.target.value)}
                    placeholder={`Description in ${loc}`}
                    rows={2}
                    dir={loc === 'fa' || loc === 'ar' ? 'rtl' : 'ltr'}
                  />
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {activeSection === 'legacy' && hasLegacy && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
              <div className="text-xs text-muted-foreground">
                These keys are stored on this plan but not present in the current capability registry.
                They are preserved verbatim on save and not edited here — see Diagnostics tab.
              </div>
            </div>
            {Object.keys(form.legacyEntitlements).length > 0 && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Legacy entitlements</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(form.legacyEntitlements).map(([k, v]) => (
                    <Badge key={k} variant="outline" className="text-[11px] font-mono">{k} = {String(v)}</Badge>
                  ))}
                </div>
              </div>
            )}
            {Object.keys(form.legacyLimits).length > 0 && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Legacy limits</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(form.legacyLimits).map(([k, v]) => (
                    <Badge key={k} variant="outline" className="text-[11px] font-mono">{k} = {String(v)}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {issues.length > 0 && (
          <div className="space-y-1 border-t border-border pt-3">
            <p className="text-[11px] font-semibold text-muted-foreground">Validation</p>
            {issues.map((i, idx) => (
              <div key={idx} className={`text-[11px] flex items-start gap-1.5 ${i.level === 'error' ? 'text-destructive' : 'text-amber-500'}`}>
                {i.level === 'error' ? <XCircle className="w-3 h-3 mt-0.5" /> : <AlertTriangle className="w-3 h-3 mt-0.5" />}
                <span><code className="font-mono">{i.key}</code> — {i.message}</span>
              </div>
            ))}
          </div>
        )}
        </div>

        <div className="border-t border-border px-5 py-3 bg-background flex items-center justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending && <Loader2 className="w-4 h-4 animate-spin me-2" />}
            {isEdit ? 'Update Plan' : 'Create Plan'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Effective Console & Overrides ───
function WorkspaceConsole({ capabilities }: { capabilities: CapabilityDefinition[] }) {
  const { data: workspaces } = useAdminWorkspaces();
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const { data, loading, error, reload } = useWorkspaceEffectiveEntitlements(workspaceId || null);
  const [busy, setBusy] = useState<string | null>(null);
  const [moduleOvIds, setModuleOvIds] = useState<Record<string, string>>({});
  const [channelOvIds, setChannelOvIds] = useState<Record<string, string>>({});
  const [limitOvIds, setLimitOvIds] = useState<Record<string, { id: string; value: number }>>({});
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({});

  // Load override IDs (needed for DELETE) whenever workspace or effective data changes.
  useEffect(() => {
    let cancelled = false;
    if (!workspaceId) {
      setModuleOvIds({});
      setChannelOvIds({});
      return;
    }
    fetchWorkspaceOverrides(workspaceId)
      .then((res) => {
        if (cancelled) return;
        setModuleOvIds(Object.fromEntries((res.modules || []).map((o) => [o.module_key!, o.id])));
        setChannelOvIds(Object.fromEntries((res.channels || []).map((o) => [o.channel_key!, o.id])));
        setLimitOvIds(Object.fromEntries(
          (res.limits || []).map((o) => [o.limit_key!, { id: o.id, value: Number(o.limit_value ?? 0) }]),
        ));
      })
      .catch(() => { /* non-fatal — clear UI just won't appear */ });
    return () => { cancelled = true; };
  }, [workspaceId, data]);

  const moduleCaps = capabilities.filter((c) => c.type === 'module');
  const channelCaps = capabilities.filter((c) => c.type === 'channel');
  const featureCaps = capabilities.filter((c) => c.type === 'feature');
  const limitCaps = capabilities.filter((c) => c.type === 'limit');

  async function toggleOverride(kind: 'module' | 'channel', key: string, current: boolean) {
    if (!workspaceId) return;
    setBusy(`${kind}:${key}`);
    try {
      if (kind === 'module') {
        await setWorkspaceModuleOverride({ workspaceId, moduleKey: key, enabled: !current, adminNotes: 'Toggled from admin console' });
      } else {
        await setWorkspaceChannelOverride({ workspaceId, channelKey: key, enabled: !current, adminNotes: 'Toggled from admin console' });
      }
      toast.success(`${kind} override applied`);
      reload();
    } catch (e: any) {
      toast.error(e?.message || 'Override failed');
    } finally {
      setBusy(null);
    }
  }

  async function clearOverride(kind: 'module' | 'channel', key: string) {
    if (!workspaceId) return;
    const id = kind === 'module' ? moduleOvIds[key] : channelOvIds[key];
    if (!id) {
      toast.error('Override id not found — please reload');
      return;
    }
    if (!window.confirm(`Remove this ${kind} override? The workspace will inherit from the plan / registry default.`)) return;
    setBusy(`clear:${kind}:${key}`);
    try {
      if (kind === 'module') await deleteWorkspaceModuleOverride(id);
      else await deleteWorkspaceChannelOverride(id);
      toast.success(`${kind} override removed — inheriting from plan`);
      reload();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to clear override');
    } finally {
      setBusy(null);
    }
  }

  async function applyLimitOverride(key: string, raw: string) {
    if (!workspaceId) return;
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') {
      toast.error('Enter a value (use -1 for unlimited)');
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < -1) {
      toast.error('Value must be -1 (unlimited) or a non-negative integer');
      return;
    }
    setBusy(`limit:${key}`);
    try {
      await setWorkspaceLimitOverride({
        workspaceId, limitKey: key, limitValue: n,
        adminNotes: 'Set from admin console',
      });
      toast.success('Limit override applied');
      setLimitDrafts((d) => { const { [key]: _drop, ...rest } = d; return rest; });
      reload();
    } catch (e: any) {
      toast.error(e?.message || 'Override failed');
    } finally {
      setBusy(null);
    }
  }

  async function clearLimitOverride(key: string) {
    if (!workspaceId) return;
    const entry = limitOvIds[key];
    if (!entry) {
      toast.error('Override id not found — please reload');
      return;
    }
    if (!window.confirm('Remove this limit override? The workspace will inherit from the plan / registry default.')) return;
    setBusy(`clear:limit:${key}`);
    try {
      await deleteWorkspaceLimitOverride(entry.id);
      toast.success('Limit override removed — inheriting from plan');
      setLimitDrafts((d) => { const { [key]: _drop, ...rest } = d; return rest; });
      reload();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to clear override');
    } finally {
      setBusy(null);
    }
  }

  const sourceBadge = (source: string) => {
    const cls =
      source === 'override' ? 'bg-amber-500/15 text-amber-600 border-amber-500/30' :
      source === 'plan' ? 'bg-primary/10 text-primary border-primary/20' :
      'bg-muted text-muted-foreground border-transparent';
    return <Badge variant="outline" className={`text-[9px] ${cls}`}>{source}</Badge>;
  };

  const renderBoolBlock = (
    title: string, caps: CapabilityDefinition[],
    bucket: Record<string, { value: boolean; source: string; note?: string | null }> | undefined,
    kind?: 'module' | 'channel',
  ) => (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="grid grid-cols-1 gap-1">
        {caps.map((cap) => {
          const eff = bucket?.[cap.key];
          const value = !!eff?.value;
          const canOverride = kind && cap.workspaceOverridable;
          const isOverride = eff?.source === 'override';
          const rowCls = isOverride
            ? 'border-amber-500/30 bg-amber-500/5'
            : 'border-transparent bg-muted/30 hover:border-border';
          return (
            <div key={cap.key} className={`flex items-center justify-between gap-2 px-3 py-2 rounded-md border ${rowCls}`}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  {value ? <CheckCircle2 className="w-3.5 h-3.5 text-primary" /> : <XCircle className="w-3.5 h-3.5 text-muted-foreground opacity-50" />}
                  <span className="text-sm">{cap.label}</span>
                  <Badge variant="outline" className="text-[9px] font-mono">{cap.key}</Badge>
                  {eff && sourceBadge(eff.source)}
                  {isOverride && (
                    <span className="text-[10px] text-amber-600">override active — {value ? 'forced on' : 'forced off'}</span>
                  )}
                  {!cap.workspaceOverridable && <Badge variant="secondary" className="text-[9px]">locked</Badge>}
                </div>
                {eff?.note && <p className="text-[10px] text-muted-foreground mt-0.5">Note: {eff.note}</p>}
              </div>
              {canOverride && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    size="sm" variant="outline" className="text-[11px] h-7"
                    disabled={busy === `${kind}:${cap.key}`}
                    onClick={() => toggleOverride(kind!, cap.key, value)}
                    title={value ? 'Force this capability off for this workspace' : 'Force this capability on for this workspace'}
                  >
                    {busy === `${kind}:${cap.key}` ? <Loader2 className="w-3 h-3 animate-spin" /> : (value ? 'Force off' : 'Force on')}
                  </Button>
                  {isOverride && (kind === 'module' ? moduleOvIds[cap.key] : channelOvIds[cap.key]) && (
                    <Button
                      size="sm" variant="ghost"
                      className="text-[11px] h-7 text-amber-600 hover:text-amber-700 hover:bg-amber-500/10"
                      disabled={busy === `clear:${kind}:${cap.key}`}
                      onClick={() => clearOverride(kind!, cap.key)}
                      title="Remove override — workspace will inherit from plan / registry default"
                    >
                      {busy === `clear:${kind}:${cap.key}`
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : (<><RotateCcw className="w-3 h-3 mr-1" /> Clear</>)}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Activity className="w-4 h-4" /> Workspace Effective Entitlements</CardTitle>
        <CardDescription>
          Pick a workspace to inspect the resolved plan + overrides + usage. Source badges show where each value comes from:
          <span className="ml-1"><Badge variant="outline" className="text-[9px] bg-amber-500/15 text-amber-600 border-amber-500/30">override</Badge> = manually forced,
          <Badge variant="outline" className="ml-1 text-[9px] bg-primary/10 text-primary border-primary/20">plan</Badge> = from plan,
          <Badge variant="outline" className="ml-1 text-[9px] bg-muted text-muted-foreground border-transparent">default</Badge> = registry default.</span>
          {' '}Use <em>Clear</em> on an override row to revert that capability to the plan / default.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 items-end flex-wrap">
          <div className="min-w-[280px]">
            <Label>Workspace</Label>
            <Select value={workspaceId} onValueChange={setWorkspaceId}>
              <SelectTrigger><SelectValue placeholder="Select workspace" /></SelectTrigger>
              <SelectContent>
                {(workspaces || []).map((w: any) => (
                  <SelectItem key={w.id} value={w.id}>{w.name} ({w.slug})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" disabled={!workspaceId || loading} onClick={reload}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Reload
          </Button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
        {!workspaceId && <p className="text-xs text-muted-foreground">Select a workspace above to view its effective entitlements.</p>}

        {data && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3 text-xs">
              <div className="px-3 py-2 rounded-lg bg-muted/40">
                <span className="text-muted-foreground">Plan:</span>{' '}
                <span className="font-medium text-foreground">{data.plan?.name || '—'}</span>
                {data.plan?.slug && <Badge variant="outline" className="ml-1.5 text-[10px] font-mono">{data.plan.slug}</Badge>}
              </div>
              <div className="px-3 py-2 rounded-lg bg-muted/40">
                <span className="text-muted-foreground">Subscription:</span>{' '}
                <span className="font-medium text-foreground">{data.subscription?.status || 'none'}</span>
              </div>
              {data.subscription?.current_period_end && (
                <div className="px-3 py-2 rounded-lg bg-muted/40">
                  <span className="text-muted-foreground">Renews:</span>{' '}
                  <span className="font-medium text-foreground">{new Date(data.subscription.current_period_end).toLocaleDateString()}</span>
                </div>
              )}
            </div>

            <Separator />
            {renderBoolBlock('Modules', moduleCaps, data.modules as any, 'module')}
            {renderBoolBlock('Channels', channelCaps, data.channels as any, 'channel')}
            {renderBoolBlock('Features', featureCaps, data.features as any)}

            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Limits</p>
              <p className="text-[10px] text-muted-foreground">
                Use <code className="bg-muted px-1 rounded">-1</code> for unlimited. Setting a value here overrides the plan limit for this workspace; clearing reverts to the plan / registry default.
              </p>
              <div className="grid grid-cols-1 gap-1.5">
                {limitCaps.map((cap) => {
                  const eff = data.limits?.[cap.key];
                  const val = eff?.value;
                  const display = val === -1 ? '∞ (unlimited)' : val == null ? '—' : Number(val).toLocaleString();
                  const isOverride = eff?.source === 'override';
                  const ov = limitOvIds[cap.key];
                  const draft = limitDrafts[cap.key] ?? '';
                  const canOverride = cap.workspaceOverridable;
                  const rowCls = isOverride
                    ? 'border-amber-500/30 bg-amber-500/5'
                    : 'border-transparent bg-muted/30 hover:border-border';
                  return (
                    <div key={cap.key} className={`flex items-center justify-between gap-2 px-3 py-2 rounded-md border ${rowCls}`}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs text-foreground">{cap.label}</span>
                          <Badge variant="outline" className="text-[9px] font-mono">{cap.key}</Badge>
                          {eff && sourceBadge(eff.source)}
                          {isOverride && (
                            <span className="text-[10px] text-amber-600">override active</span>
                          )}
                          {!canOverride && <Badge variant="secondary" className="text-[9px]">locked</Badge>}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          Effective: <span className="font-mono text-foreground">{display}</span>
                          {cap.unit ? ` ${cap.unit}` : ''}
                        </div>
                        {eff?.note && <p className="text-[10px] text-muted-foreground mt-0.5">Note: {eff.note}</p>}
                      </div>
                      {canOverride && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Input
                            type="number"
                            step={1}
                            min={-1}
                            className="h-7 w-24 text-xs font-mono"
                            placeholder={ov ? String(ov.value) : (typeof val === 'number' ? String(val) : '')}
                            value={draft}
                            onChange={(e) => setLimitDrafts((d) => ({ ...d, [cap.key]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === 'Enter') applyLimitOverride(cap.key, draft); }}
                          />
                          <Button
                            size="sm" variant="outline" className="text-[11px] h-7"
                            disabled={busy === `limit:${cap.key}` || draft.trim() === ''}
                            onClick={() => applyLimitOverride(cap.key, draft)}
                            title="Set workspace override for this limit"
                          >
                            {busy === `limit:${cap.key}` ? <Loader2 className="w-3 h-3 animate-spin" /> : (ov ? 'Update' : 'Set')}
                          </Button>
                          {isOverride && ov && (
                            <Button
                              size="sm" variant="ghost"
                              className="text-[11px] h-7 text-amber-600 hover:text-amber-700 hover:bg-amber-500/10"
                              disabled={busy === `clear:limit:${cap.key}`}
                              onClick={() => clearLimitOverride(cap.key)}
                              title="Remove override — workspace will inherit from plan / registry default"
                            >
                              {busy === `clear:limit:${cap.key}`
                                ? <Loader2 className="w-3 h-3 animate-spin" />
                                : (<><RotateCcw className="w-3 h-3 mr-1" /> Clear</>)}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {data.usage && Object.keys(data.usage).length > 0 && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Usage snapshot</p>
                <ScrollArea className="max-h-40">
                  <pre className="text-[11px] text-muted-foreground bg-muted/30 rounded p-2">{JSON.stringify(data.usage, null, 2)}</pre>
                </ScrollArea>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Diagnostics ───
function DiagnosticsPanel() {
  const { data, loading, error, reload } = useEntitlementDiagnostics();
  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2"><Settings2 className="w-4 h-4" /> Entitlement Diagnostics</CardTitle>
            <CardDescription>Drift between persisted plan JSON and the capability registry.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Reload
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!data && loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
        {data && (
          <>
            <div className="flex gap-3 flex-wrap text-xs">
              <div className="px-3 py-2 rounded-lg bg-muted/40"><span className="text-muted-foreground">Registry:</span> <span className="font-medium text-foreground">{data.registrySize}</span></div>
              <div className="px-3 py-2 rounded-lg bg-muted/40"><span className="text-muted-foreground">Plans checked:</span> <span className="font-medium text-foreground">{data.plansChecked}</span></div>
              <div className="px-3 py-2 rounded-lg bg-muted/40"><span className="text-muted-foreground">Unknown DB keys:</span> <span className="font-medium text-foreground">{data.unknownKeysInDb.length}</span></div>
              <div className="px-3 py-2 rounded-lg bg-muted/40"><span className="text-muted-foreground">Missing registry keys:</span> <span className="font-medium text-foreground">{data.registryKeysMissingEverywhere.length}</span></div>
              <div className="px-3 py-2 rounded-lg bg-muted/40"><span className="text-muted-foreground">Invalid limits:</span> <span className="font-medium text-foreground">{data.invalidLimitValues.length}</span></div>
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Unknown keys in DB (legacy or drift)</p>
              {data.unknownKeysInDb.length === 0 ? (
                <p className="text-xs text-muted-foreground">None — all stored keys match the registry.</p>
              ) : (
                <div className="space-y-1">
                  {data.unknownKeysInDb.map((u, i) => (
                    <div key={i} className="text-xs flex items-center gap-2">
                      <AlertTriangle className="w-3 h-3 text-amber-500" />
                      <Badge variant="outline" className="font-mono text-[10px]">{u.planSlug}</Badge>
                      <span className="font-mono">{u.key}</span>
                      <Badge variant="secondary" className="text-[9px]">{u.bucket}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Registry keys not used by any plan</p>
              {data.registryKeysMissingEverywhere.length === 0 ? (
                <p className="text-xs text-muted-foreground">All registry keys appear in at least one plan.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {data.registryKeysMissingEverywhere.map((k) => (
                    <Badge key={k} variant="outline" className="text-[10px] font-mono">{k}</Badge>
                  ))}
                </div>
              )}
            </div>

            {data.invalidLimitValues.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Invalid limit values</p>
                <div className="space-y-1">
                  {data.invalidLimitValues.map((v, i) => (
                    <div key={i} className="text-xs flex items-center gap-2 text-destructive">
                      <XCircle className="w-3 h-3" />
                      <Badge variant="outline" className="font-mono text-[10px]">{v.planSlug}</Badge>
                      <span className="font-mono">{v.key}</span>
                      <span>= {String(v.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main Page ───
export default function AdminPlansPage() {
  const { data: plans, isLoading } = useAdminPlans();
  const { data: subscriptions } = useAdminSubscriptions();
  const { data: workspaces } = useAdminWorkspaces();
  const { data: platformConfig } = usePlatformLocales();
  const deletePlan = useDeletePlan();
  const assignPlan = useAssignPlan();
  const revokePlan = useRevokePlan();

  // Registry-driven capability catalog
  const { capabilities, loading: catLoading, error: catError } = useCapabilityCatalog();
  const caps = capabilities || [];

  const locales = platformConfig?.locales || ['en'];

  const [editPlan, setEditPlan] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [assignForm, setAssignForm] = useState({ workspaceId: '', planId: '' });

  // Derived per-card view, registry-aware
  const moduleKeys = useMemo(() => new Set(caps.filter((c) => c.type === 'module').map((c) => c.key)), [caps]);
  const channelKeys = useMemo(() => new Set(caps.filter((c) => c.type === 'channel').map((c) => c.key)), [caps]);
  const featureKeys = useMemo(() => new Set(caps.filter((c) => c.type === 'feature').map((c) => c.key)), [caps]);
  const limitDefs = useMemo(() => caps.filter((c) => c.type === 'limit'), [caps]);
  const capByKey = useMemo(() => new Map(caps.map((c) => [c.key, c])), [caps]);

  if (isLoading || catLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  if (catError) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="py-6 text-sm text-destructive flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> Failed to load capability registry: {catError}
        </CardContent>
      </Card>
    );
  }

  async function handleDelete(planId: string) {
    if (!confirm('Deactivate this plan?')) return;
    try { await deletePlan.mutateAsync(planId); toast.success('Plan deactivated'); } catch (e: any) { toast.error(e.message); }
  }

  async function handleAssign() {
    if (!assignForm.workspaceId || !assignForm.planId) return;
    try {
      await assignPlan.mutateAsync({ workspaceId: assignForm.workspaceId, planId: assignForm.planId });
      toast.success('Plan assigned');
      setAssignForm({ workspaceId: '', planId: '' });
    } catch (e: any) { toast.error(e.message); }
  }

  async function handleRevoke(wsId: string) {
    if (!confirm('Revoke this workspace subscription?')) return;
    try { await revokePlan.mutateAsync(wsId); toast.success('Revoked'); } catch (e: any) { toast.error(e.message); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Plan Management</h1>
          <p className="text-muted-foreground text-sm flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5" />
            Registry-driven · {caps.length} capabilities loaded
          </p>
        </div>
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-2" /> Create Plan</Button>
          </DialogTrigger>
          <DialogContent className="max-w-5xl w-[95vw] p-0 gap-0 max-h-[90vh] flex flex-col overflow-hidden">
            <DialogHeader className="px-5 py-4 border-b border-border shrink-0">
              <DialogTitle>Create New Plan</DialogTitle>
            </DialogHeader>
            <PlanFormDialog onClose={() => setShowCreate(false)} locales={locales} capabilities={caps} />
          </DialogContent>
        </Dialog>
      </div>

      <Tabs defaultValue="plans">
        <TabsList className="bg-muted">
          <TabsTrigger value="plans"><CreditCard className="w-3.5 h-3.5 mr-1.5" /> Plans ({plans?.length || 0})</TabsTrigger>
          <TabsTrigger value="subscriptions"><Users className="w-3.5 h-3.5 mr-1.5" /> Subscriptions ({subscriptions?.length || 0})</TabsTrigger>
          <TabsTrigger value="assign"><Shield className="w-3.5 h-3.5 mr-1.5" /> Assign</TabsTrigger>
          <TabsTrigger value="effective"><Activity className="w-3.5 h-3.5 mr-1.5" /> Workspace Console</TabsTrigger>
          <TabsTrigger value="diagnostics"><SlidersHorizontal className="w-3.5 h-3.5 mr-1.5" /> Diagnostics</TabsTrigger>
        </TabsList>

        {/* ─── Plans Tab (registry-aware cards) ─── */}
        <TabsContent value="plans" className="space-y-4">
          {(!plans || plans.length === 0) ? (
            <Card className="bg-card border-border">
              <CardContent className="py-16 text-center text-muted-foreground">
                <CreditCard className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-lg font-medium">No plans yet</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {plans!.map((plan: any) => {
                const localized = (plan.localized || {}) as Record<string, LocalizedPlan>;
                const entitlements = (plan.entitlements || {}) as Record<string, boolean>;
                const limits = (plan.limits || {}) as Record<string, number>;

                const enabledModules = [...moduleKeys].filter((k) => entitlements[k]);
                const enabledChannels = [...channelKeys].filter((k) => entitlements[k]);
                const enabledFeatures = [...featureKeys].filter((k) => entitlements[k]);
                const totalBool = moduleKeys.size + channelKeys.size + featureKeys.size;
                const enabledTotal = enabledModules.length + enabledChannels.length + enabledFeatures.length;

                const allKeysInPlan = new Set([...Object.keys(entitlements), ...Object.keys(limits)]);
                const legacyCount = [...allKeysInPlan].filter((k) => !capByKey.has(k)).length;

                return (
                  <Card key={plan.id} className={`bg-card border-border ${!plan.is_active ? 'opacity-50' : ''}`}>
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${plan.is_free ? 'bg-muted' : 'bg-primary/10'}`}>
                            <Crown className={`w-5 h-5 ${plan.is_free ? 'text-muted-foreground' : 'text-primary'}`} />
                          </div>
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <CardTitle className="text-lg">{plan.name}</CardTitle>
                              <Badge variant="outline" className="text-[10px] font-mono">{plan.slug}</Badge>
                              {plan.is_free && <Badge variant="secondary" className="text-[10px]">Free</Badge>}
                              {plan.trial_days > 0 && <Badge variant="outline" className="text-[10px]">{plan.trial_days}d trial</Badge>}
                              {plan.is_hidden && <Badge variant="outline" className="text-[10px] border-purple-500/40 text-purple-600">Hidden</Badge>}
                              {legacyCount > 0 && <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600">{legacyCount} legacy</Badge>}
                            </div>
                            <CardDescription className="text-xs mt-0.5">{plan.description || 'No description'}</CardDescription>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Badge variant={plan.is_active ? 'default' : 'destructive'} className="text-[10px]">
                            {plan.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                          <Dialog open={editPlan?.id === plan.id} onOpenChange={(v) => !v && setEditPlan(null)}>
                            <DialogTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditPlan(plan)}>
                                <Edit2 className="w-3.5 h-3.5" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="max-w-5xl w-[95vw] p-0 gap-0 max-h-[90vh] flex flex-col overflow-hidden">
                              <DialogHeader className="px-5 py-4 border-b border-border shrink-0">
                                <DialogTitle>Edit: {plan.name}</DialogTitle>
                              </DialogHeader>
                              <PlanFormDialog plan={plan} onClose={() => setEditPlan(null)} locales={locales} capabilities={caps} />
                            </DialogContent>
                          </Dialog>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleDelete(plan.id)} disabled={deletePlan.isPending}>
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {Object.keys(localized).some((l) => localized[l]?.name) && (
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries(localized).map(([loc, d]) => d.name ? (
                            <Badge key={loc} variant="outline" className="text-[11px] gap-1 font-normal">
                              <Globe className="w-3 h-3" />
                              {LOCALE_LABELS[loc]?.split(' ')[0] || loc} {d.name}
                            </Badge>
                          ) : null)}
                        </div>
                      )}

                      {!plan.is_free && (
                        <div className="flex flex-wrap gap-3">
                          {CURRENCIES.map((cur) => {
                            const p = plan.prices?.[cur];
                            if (!p?.monthly && !p?.yearly) return null;
                            return (
                              <div key={cur} className="bg-muted/40 rounded-lg px-3 py-1.5 text-sm">
                                <span className="font-bold text-foreground">{cur}</span>
                                <span className="text-muted-foreground ml-1.5">{p.monthly?.toLocaleString()}/mo</span>
                                {p.yearly > 0 && <span className="text-muted-foreground"> · {p.yearly?.toLocaleString()}/yr</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <div className="space-y-2">
                        <p className="text-[11px] text-muted-foreground font-medium">
                          Capabilities ({enabledTotal}/{totalBool}) · {enabledModules.length} modules · {enabledChannels.length} channels · {enabledFeatures.length} features
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {[...enabledModules, ...enabledChannels, ...enabledFeatures].map((k) => {
                            const c = capByKey.get(k);
                            if (!c) return null;
                            return (
                              <Badge key={k} variant="outline" className="text-[10px] gap-1 bg-primary/5 text-primary border-primary/20">
                                <CheckCircle2 className="w-3 h-3" />{c.label}
                              </Badge>
                            );
                          })}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {limitDefs.map((cap) => {
                          const val = limits[cap.key];
                          if (val === undefined) return null;
                          return (
                            <Badge key={cap.key} variant="secondary" className="text-[11px] font-normal">
                              {cap.label}: {val === -1 ? '∞' : val?.toLocaleString()}{cap.unit ? ` ${cap.unit}` : ''}
                            </Badge>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="subscriptions">
          <Card className="bg-card border-border">
            <Table>
              <TableHeader>
                <TableRow className="border-border">
                  <TableHead>Workspace</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Period End</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(!subscriptions || subscriptions.length === 0) ? (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No subscriptions</TableCell></TableRow>
                ) : subscriptions.map((sub: any) => (
                  <TableRow key={sub.id} className="border-border hover:bg-muted/50">
                    <TableCell className="font-mono text-xs">{sub.workspace_id?.slice(0, 8)}...</TableCell>
                    <TableCell>{sub.billing_plans?.name || sub.plan_id?.slice(0, 8)}</TableCell>
                    <TableCell>
                      <Badge variant={sub.status === 'active' ? 'default' : sub.status === 'trialing' ? 'secondary' : 'destructive'}>{sub.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{sub.provider_name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {sub.current_period_end ? new Date(sub.current_period_end).toLocaleDateString() : '—'}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => handleRevoke(sub.workspace_id)} className="text-destructive text-xs">Revoke</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="assign">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><Shield className="w-4 h-4" /> Assign Plan to Workspace</CardTitle>
              <CardDescription>Manually assign a plan (bypasses payment).</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>Workspace</Label>
                  <Select value={assignForm.workspaceId} onValueChange={(v) => setAssignForm((f) => ({ ...f, workspaceId: v }))}>
                    <SelectTrigger><SelectValue placeholder="Select workspace" /></SelectTrigger>
                    <SelectContent>
                      {(workspaces || []).map((w: any) => (
                        <SelectItem key={w.id} value={w.id}>{w.name} ({w.slug})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Plan</Label>
                  <Select value={assignForm.planId} onValueChange={(v) => setAssignForm((f) => ({ ...f, planId: v }))}>
                    <SelectTrigger><SelectValue placeholder="Select plan" /></SelectTrigger>
                    <SelectContent>
                      {(plans || []).filter((p: any) => p.is_active).map((p: any) => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end">
                  <Button onClick={handleAssign} disabled={!assignForm.workspaceId || !assignForm.planId || assignPlan.isPending}>
                    {assignPlan.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Users className="w-4 h-4 mr-2" />}
                    Assign
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="effective">
          <WorkspaceConsole capabilities={caps} />
        </TabsContent>

        <TabsContent value="diagnostics">
          <DiagnosticsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}