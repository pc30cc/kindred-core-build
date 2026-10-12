import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  useAdminPlans,
  useCreatePlan,
  useUpdatePlan,
  useDeletePlan,
  useAdminSubscriptions,
  useAssignPlan,
  useRevokePlan,
} from '@/hooks/usePlans';
import type { PlanRow, SubscriptionRow } from '@/hooks/usePlans';
import { useAdminWorkspaces } from '@/hooks/useAdmin';
import { fetchPlatformPublicConfig } from '@/lib/platformPublicConfig';
import {
  useCapabilityCatalog,
  useWorkspaceEffectiveEntitlements,
  useEntitlementDiagnostics,
} from '@/hooks/useEntitlements';
import {
  validatePlanPayload,
  type PlanValidationIssue,
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
  Plus,
  Edit2,
  Trash2,
  Shield,
  CreditCard,
  Users,
  Loader2,
  CheckCircle2,
  XCircle,
  Crown,
  Globe,
  AlertTriangle,
  Activity,
  SlidersHorizontal,
  Settings2,
  RefreshCw,
  Info,
  RotateCcw,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { useQuery } from '@tanstack/react-query';
import { useAdminAccount, useSimpleBillingSettings } from '@/lib/adminSimpleBillingApi';
import { AI_PACK_CURRENCIES } from '../../../shared/aiPacks';
import { PLAN_RETENTION_DAYS } from '../../../shared/simpleBillingAdmin';
import type { Edition } from '../../../shared/edition';
import BillingSettingsPanel from '@/components/admin/BillingSettingsPanel';
import AiPacksPanel from '@/components/admin/AiPacksPanel';
import { useTranslation, type TranslationKey } from '@/i18n';
import {
  capabilityLabel,
  capabilityDescription,
  capabilityGroupLabel,
  capabilityUnitLabel,
} from '@/lib/capability-i18n';
import {
  PLAN_PRICE_CURRENCIES,
  formatPlanPrice,
  parsePlanPriceInput,
  planPriceFromDisplay,
  planPriceInputValue,
  planPriceUnitLabel,
} from '@/lib/planPrice';
import { useEdition } from '@/hooks/useEdition';

// ─── Constants ───
const CURRENCIES = PLAN_PRICE_CURRENCIES;
/** The page's tabs, as `?tab=` names them. */
const PAGE_TABS = ['plans', 'subscriptions', 'assign', 'effective', 'diagnostics', 'billing-settings'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRICE_INTERVALS = ['monthly', 'yearly'] as const;
type PriceInterval = (typeof PRICE_INTERVALS)[number];
/** What the admin typed in each price field, in the unit people read. */
type PriceDrafts = Record<string, Record<PriceInterval, string>>;

/** Price fields seeded from stored amounts (minor units / Rial) as major units / Toman. */
function priceDraftsFrom(prices: PlanFormData['prices']): PriceDrafts {
  return Object.fromEntries(
    CURRENCIES.map((cur) => [
      cur,
      {
        monthly: planPriceInputValue(prices[cur]?.monthly, cur),
        yearly: planPriceInputValue(prices[cur]?.yearly, cur),
      },
    ]),
  );
}
const LOCALE_FLAGS: Record<string, string> = {
  en: '🇬🇧',
  tr: '🇹🇷',
  fa: '🇮🇷',
  de: '🇩🇪',
  fr: '🇫🇷',
  ar: '🇸🇦',
};

interface LocalizedPlan {
  name: string;
  description: string;
}

/** A `billing_plans` row as the Super Admin plan endpoints return it. */
type AdminPlan = PlanRow;

/** A `workspace_subscriptions` row with its plan, as /admin/subscriptions returns it. */
type AdminSubscription = SubscriptionRow;

/** The message of a thrown error, if it has one. */
function errorText(e: unknown): string | undefined {
  return e instanceof Error && e.message ? e.message : undefined;
}

/** A status label; a status the translations do not know yet shows as it is. */
function statusLabel(t: (key: TranslationKey) => string, status: string | null | undefined): string {
  if (!status) return t('admin.plans.statuses.none');
  const key = `admin.plans.statuses.${status}` as TranslationKey;
  const label = t(key);
  return label && label !== key ? label : status;
}

/** A plan's name in the admin's language (its own translations), else its base name. */
function planName(plan: { name?: string | null; localized?: Record<string, { name?: string | null } | null | undefined> | null } | null | undefined, locale: string): string {
  return plan?.localized?.[locale]?.name?.trim() || plan?.name || '—';
}

/** A capability's name and description in the admin's language (src/lib/capability-i18n.ts). */
const capName = (cap: CapabilityDefinition, locale: string) => capabilityLabel(cap.key, locale, cap.label);
const capText = (cap: CapabilityDefinition, locale: string) => capabilityDescription(cap.key, locale, cap.description);

/** A currency's name in the admin's language with its code, e.g. «دلار آمریکا (USD)». */
function currencyName(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'currency' }).of(code);
    return name && name !== code ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

/** A language's name in the admin's language, e.g. `en` → «انگلیسی». */
function languageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

interface PlanFormData {
  name: string;
  slug: string;
  description: string;
  is_free: boolean;
  is_active: boolean;
  is_hidden: boolean;
  sort_order: number;
  trial_days: number;
  default_currency: string;
  prices: Record<string, { monthly: number; yearly: number }>;
  entitlements: Record<string, boolean>;
  limits: Record<string, number>;
  provider_price_ids: Record<string, unknown>;
  localized: Record<string, LocalizedPlan>;
  /** Keys present in DB but not in current registry — preserved verbatim. */
  legacyEntitlements: Record<string, unknown>;
  legacyLimits: Record<string, unknown>;
  /** Days a locked workspace's data is kept, as typed; empty = never deleted (D18). */
  locked_data_retention_days: string;
  /** Monthly AI credit per currency, as typed in the unit people read (Toman / dollars / lira) (D17). */
  ai_allowance: Record<string, string>;
  /** The stored `ai_allowance`, so a currency this edition does not edit is kept as it is. */
  storedAiAllowance: Record<string, number>;
  /**
   * Lock limits (LOCK_LIMIT_KEYS) an existing plan does not name, with the
   * registry default the form shows for them: saved only once changed.
   */
  absentLockLimits: Record<string, number>;
  /** Lock limits the admin edited in this form: saved even when back at the shown default. */
  touchedLockLimits: string[];
}

/**
 * Limits that lock data over them (phase 4, "only explicit limits lock"): a
 * plan that does not name one locks nothing by it. The form shows every
 * limit with its registry default, so saving such a plan unchanged must not
 * write that default (the Trial plan would get max_agents 1 and pause every
 * agent; data_retention_days 30 would lock every older chat).
 */
const LOCK_LIMIT_KEYS = ['max_agents', 'max_contacts', 'max_kb_articles', 'data_retention_days'] as const;

/**
 * The limit older readers still take the monthly AI credit from. Where the
 * form edits `ai_allowance.IRR` under Pricing (Iran), the limits editor hides
 * it (one value is never edited in two places) and the payload mirrors it;
 * elsewhere the limit stays in the limits editor and `ai_allowance.IRR`
 * follows it.
 */
const AI_ALLOWANCE_LIMIT_KEY = 'included_ai_allowance_irr';

/**
 * The `ai_allowance` currencies the monthly grant reads
 * (billing_plan_ai_allowance: the override, `ai_allowance.IRR`, then the
 * limit). A USD or TRY value would be stored and shown but never granted, so
 * the form does not offer one.
 */
const GRANTED_AI_ALLOWANCE_CURRENCIES: readonly string[] = ['IRR'];

/** The retention field's value: null when empty (never deleted), NaN when it is not PLAN_RETENTION_DAYS whole days. */
function retentionDaysValue(text: string): number | null {
  if (!text.trim()) return null;
  const n = parsePlanPriceInput(text);
  return n !== null && Number.isInteger(n) && n >= PLAN_RETENTION_DAYS.min && n <= PLAN_RETENTION_DAYS.max ? n : Number.NaN;
}

/** A monthly AI credit field's stored value (Rial / minor units), or null when it is not an amount. */
function aiAllowanceValue(text: string, currency: string): number | null {
  const n = parsePlanPriceInput(text);
  return n === null ? null : planPriceFromDisplay(n, currency);
}

/**
 * The currencies whose monthly AI credit the plan form edits under Pricing:
 * the AI credit currencies of the edition that the monthly grant reads. In
 * the international edition (USD, TRY) none: there the credit is the
 * `included_ai_allowance_irr` limit, edited with the other limits.
 */
function aiAllowanceCurrencies(edition: Edition, fromSettings: readonly string[] | undefined): string[] {
  const list = fromSettings?.length ? fromSettings : AI_PACK_CURRENCIES[edition] ?? ['IRR'];
  return list.filter((cur) => GRANTED_AI_ALLOWANCE_CURRENCIES.includes(cur));
}

/** A 400 from the plan endpoints as validation issues the form lists (its `issues`, whichever shape). */
function serverIssues(e: unknown): PlanValidationIssue[] {
  const body = (e as { body?: { issues?: unknown } } | null)?.body;
  if (!Array.isArray(body?.issues)) return [];
  return body.issues.flatMap((raw): PlanValidationIssue[] => {
    if (!raw || typeof raw !== 'object') return [];
    const i = raw as Record<string, unknown>;
    const key = typeof i.key === 'string' ? i.key : typeof i.path === 'string' ? i.path : '';
    const level = i.level === 'warning' ? 'warning' : 'error';
    const message = typeof i.message === 'string' ? i.message : '';
    // Registry issues carry a known `code`; zod and price issues only a path and a message.
    const code = typeof i.code === 'string' && typeof i.key === 'string' ? (i.code as PlanValidationIssue['code']) : undefined;
    return [{ level, key: key || '—', code, message } as PlanValidationIssue];
  });
}

function usePlatformLocales() {
  return useQuery({
    queryKey: ['platform-settings-locales'],
    queryFn: async () => {
      const data = await fetchPlatformPublicConfig().then((c) => c.region, () => null);
      return { locales: (data?.active_locales || ['en']) as string[] };
    },
  });
}

// ─── Registry-aware form helpers ───

function buildFormFromRegistry(
  capabilities: CapabilityDefinition[],
  locales: string[],
  plan?: AdminPlan | null,
  aiCurrencies: readonly string[] = ['IRR'],
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
  const storedAiAllowance: Record<string, number> = {};
  for (const [cur, v] of Object.entries(plan?.ai_allowance || {})) {
    if (typeof v === 'number' && Number.isFinite(v)) storedAiAllowance[cur] = v;
  }
  // A plan saved before `ai_allowance` existed has its IRR credit only in the limit.
  const legacyIrr = Number(planLim[AI_ALLOWANCE_LIMIT_KEY]);
  if (storedAiAllowance.IRR === undefined && Number.isFinite(legacyIrr) && legacyIrr > 0) storedAiAllowance.IRR = legacyIrr;
  const retention = plan?.locked_data_retention_days;
  return {
    name: plan?.name || '',
    slug: plan?.slug || '',
    description: plan?.description || '',
    is_free: plan?.is_free || false,
    is_active: plan ? plan.is_active !== false : true,
    is_hidden: plan?.is_hidden || false,
    sort_order: plan?.sort_order || 0,
    trial_days: plan?.trial_days || 0,
    default_currency: plan?.default_currency || 'USD',
    prices: {
      ...Object.fromEntries(CURRENCIES.map((c) => [c, { monthly: 0, yearly: 0 }])),
      ...(plan?.prices || {}),
    },
    entitlements,
    limits,
    provider_price_ids: plan?.provider_price_ids || {},
    localized: Object.fromEntries(locales.map((l) => [l, existingLocalized[l] || { name: '', description: '' }])),
    legacyEntitlements,
    legacyLimits,
    locked_data_retention_days: typeof retention === 'number' && retention > 0 ? String(retention) : '',
    ai_allowance: Object.fromEntries(aiCurrencies.map((cur) => [cur, planPriceInputValue(storedAiAllowance[cur], cur)])),
    storedAiAllowance,
    absentLockLimits: plan?.id
      ? Object.fromEntries(LOCK_LIMIT_KEYS.filter((k) => knownKeys.has(k) && !(k in planLim)).map((k) => [k, limits[k]]))
      : {},
    touchedLockLimits: [],
  };
}

/**
 * Compose final JSON payload, preserving legacy keys. The monthly AI credit
 * keeps every stored currency and overwrites the edited ones. When IRR is
 * edited under Pricing its value is mirrored into the limit older readers use
 * (the server does the same); when it is not (international), the limit is
 * what the admin edits, and `ai_allowance.IRR`, which the grant reads first,
 * takes the limit's value so the two never disagree.
 */
function formToPayload(form: PlanFormData) {
  const aiAllowance: Record<string, number> = { ...form.storedAiAllowance };
  for (const [cur, text] of Object.entries(form.ai_allowance)) {
    const value = aiAllowanceValue(text, cur);
    if (value !== null) aiAllowance[cur] = value;
  }
  const limits: Record<string, unknown> = { ...form.legacyLimits, ...form.limits };
  const limitValue = form.limits[AI_ALLOWANCE_LIMIT_KEY];
  if (!('IRR' in form.ai_allowance) && typeof limitValue === 'number' && Number.isFinite(limitValue)) {
    aiAllowance.IRR = limitValue;
  }
  if (typeof aiAllowance.IRR === 'number') limits[AI_ALLOWANCE_LIMIT_KEY] = aiAllowance.IRR;
  // A lock limit the plan did not name stays unnamed unless the admin edited
  // it (typing the default itself makes it explicit, so it locks).
  for (const [key, shown] of Object.entries(form.absentLockLimits)) {
    if (!form.touchedLockLimits.includes(key) && limits[key] === shown) delete limits[key];
  }
  const retention = retentionDaysValue(form.locked_data_retention_days);
  return {
    name: form.name,
    slug: form.slug,
    description: form.description,
    is_free: form.is_free,
    is_active: form.is_active,
    is_hidden: form.is_hidden,
    sort_order: form.sort_order,
    trial_days: form.trial_days,
    default_currency: form.default_currency,
    prices: form.prices,
    entitlements: { ...form.legacyEntitlements, ...form.entitlements },
    limits,
    provider_price_ids: form.provider_price_ids,
    localized: form.localized,
    locked_data_retention_days: retention !== null && Number.isNaN(retention) ? null : retention,
    ai_allowance: aiAllowance,
  };
}

// ─── Plan Form Dialog (registry-driven) ───
function PlanFormDialog({
  plan,
  onClose,
  locales,
  capabilities,
  onOpenBillingSettings,
}: {
  plan?: AdminPlan | null;
  onClose: () => void;
  locales: string[];
  capabilities: CapabilityDefinition[];
  /** Leaves the form for Plans → Billing settings (where VAT is set). */
  onOpenBillingSettings?: () => void;
}) {
  const { t, locale } = useTranslation();
  // The Rial (Toman) price card exists in the Iranian edition only; a stored
  // IRR price is kept untouched (never shown or edited) elsewhere.
  const edition = useEdition();
  const shownCurrencies = CURRENCIES.filter((cur) => edition.allowsCurrency(cur));
  // VAT is per currency in Billing settings (D16): shown here read-only.
  const { data: billingSettings } = useSimpleBillingSettings();
  const aiCurrencies = aiAllowanceCurrencies(edition.edition, billingSettings?.ai_currencies);
  const aiEditsIrr = aiCurrencies.includes('IRR');
  const [form, setForm] = useState<PlanFormData>(() =>
    buildFormFromRegistry(capabilities, locales, plan, aiAllowanceCurrencies(edition.edition, undefined)),
  );
  const [priceDrafts, setPriceDrafts] = useState<PriceDrafts>(() => priceDraftsFrom(form.prices));
  const [activeSection, setActiveSection] = useState('general');
  const [issues, setIssues] = useState<PlanValidationIssue[]>([]);
  const createPlan = useCreatePlan();
  const updatePlan = useUpdatePlan();
  const isEdit = !!plan?.id;
  const isPending = createPlan.isPending || updatePlan.isPending;

  // Partition capabilities by type. Deprecated / non-plan-configurable keys
  // (e.g. the legacy `remove_powered_by` inverse) never render a toggle —
  // the canonical key is the only thing a plan can set.
  const byType = useMemo(() => {
    const editable = capabilities.filter((c) => !c.deprecated && c.planConfigurable !== false);
    return {
      module: editable.filter((c) => c.type === 'module').sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
      channel: editable.filter((c) => c.type === 'channel').sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
      feature: editable.filter((c) => c.type === 'feature'),
      // Where the monthly AI credit is edited under Pricing (ai_allowance.IRR), never here too.
      limit: editable.filter((c) => c.type === 'limit' && (c.key !== AI_ALLOWANCE_LIMIT_KEY || !aiEditsIrr)),
    };
  }, [capabilities, aiEditsIrr]);

  const featuresByGroup = useMemo(() => groupCapabilities(byType.feature), [byType.feature]);
  const limitsByGroup = useMemo(() => groupCapabilities(byType.limit), [byType.limit]);

  async function handleSubmit() {
    if (!form.name || !form.slug) {
      toast.error(t('admin.plans.validation.nameSlugRequired'));
      return;
    }
    const badPrice = CURRENCIES.some((cur) =>
      PRICE_INTERVALS.some((iv) => parsePlanPriceInput(priceDrafts[cur]?.[iv] ?? '') === null),
    );
    if (badPrice) {
      setActiveSection('pricing');
      toast.error(t('admin.plans.validation.invalidPrice'));
      return;
    }
    if (Object.entries(form.ai_allowance).some(([cur, text]) => aiAllowanceValue(text, cur) === null)) {
      setActiveSection('pricing');
      toast.error(t('admin.plans.form.priceInvalid'));
      return;
    }
    if (Number.isNaN(retentionDaysValue(form.locked_data_retention_days) as number)) {
      setActiveSection('general');
      toast.error(t('admin.billingLocks.planRetention.invalid'));
      return;
    }
    const payload = formToPayload(form);
    // Soft validation
    try {
      const v = await validatePlanPayload({ entitlements: payload.entitlements, limits: payload.limits });
      setIssues(v.issues);
      const errs = v.issues.filter((i) => i.level === 'error');
      if (errs.length) {
        toast.error(t('admin.plans.validation.errors', { count: errs.length }));
        return;
      }
      const warns = v.issues.filter((i) => i.level === 'warning');
      if (warns.length) {
        toast.warning(t('admin.plans.validation.unknownKeys', { count: warns.length }), {
          description: warns.map((w) => w.key).join('، '),
        });
      }
    } catch (e) {
      // Validation endpoint failure is non-fatal
      console.warn('Validation skipped:', errorText(e));
    }
    try {
      if (isEdit) {
        await updatePlan.mutateAsync({ planId: plan.id, ...payload });
        toast.success(t('admin.plans.messages.updated'));
      } else {
        await createPlan.mutateAsync(payload);
        toast.success(t('admin.plans.messages.created'));
      }
      onClose();
    } catch (e) {
      // A 400 names what is wrong (unknown key, price, retention…): list it under the form.
      const fromServer = serverIssues(e);
      if (fromServer.length) setIssues(fromServer);
      if ((e as { body?: { error?: string } })?.body?.error === 'INVALID_PRICE') {
        setActiveSection('pricing');
        toast.error(t('admin.plans.validation.invalidPrice'));
        return;
      }
      toast.error(errorText(e) ?? t('admin.plans.messages.actionFailed'));
    }
  }

  function setBool(key: string, val: boolean) {
    setForm((f) => ({ ...f, entitlements: { ...f.entitlements, [key]: val } }));
  }
  /** Keeps the typed text and stores its value in minor units / Rial. */
  function setPrice(cur: string, interval: PriceInterval, text: string) {
    setPriceDrafts((d) => ({ ...d, [cur]: { ...d[cur], [interval]: text } }));
    const value = parsePlanPriceInput(text);
    if (value === null) return;
    setForm((f) => ({
      ...f,
      prices: { ...f.prices, [cur]: { ...f.prices[cur], [interval]: planPriceFromDisplay(value, cur) } },
    }));
  }
  function setLimit(key: string, val: number) {
    setForm((f) => ({
      ...f,
      limits: { ...f.limits, [key]: val },
      touchedLockLimits: key in f.absentLockLimits && !f.touchedLockLimits.includes(key)
        ? [...f.touchedLockLimits, key]
        : f.touchedLockLimits,
    }));
  }
  function updateLocalized(locale: string, field: string, value: string) {
    setForm((f) => ({ ...f, localized: { ...f.localized, [locale]: { ...f.localized[locale], [field]: value } } }));
  }

  const hasLegacy = Object.keys(form.legacyEntitlements).length + Object.keys(form.legacyLimits).length > 0;
  const retentionInvalid = Number.isNaN(retentionDaysValue(form.locked_data_retention_days) as number);
  const aiAllowanceText = (cur: string) => form.ai_allowance[cur] ?? planPriceInputValue(form.storedAiAllowance[cur], cur);
  const vatCurrencies = shownCurrencies.filter((cur) => billingSettings?.vat_currencies?.includes(cur));
  const vatPercent = (cur: string): number | null => {
    const v = billingSettings?.vat_percent?.[cur];
    return typeof v === 'number' ? v : null;
  };

  const sections = [
    { id: 'general', label: t('admin.plans.form.sections.general') },
    { id: 'modules', label: t('admin.plans.form.sections.modules', { count: byType.module.length }) },
    { id: 'channels', label: t('admin.plans.form.sections.channels', { count: byType.channel.length }) },
    { id: 'features', label: t('admin.plans.form.sections.features', { count: byType.feature.length }) },
    { id: 'limits', label: t('admin.plans.form.sections.limits', { count: byType.limit.length }) },
    { id: 'pricing', label: t('admin.plans.form.sections.pricing') },
    { id: 'locales', label: t('admin.plans.form.sections.translations') },
    ...(hasLegacy ? [{ id: 'legacy', label: t('admin.plans.form.sections.legacy') }] : []),
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
                <span className={`text-sm font-medium ${enabled ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {capName(cap, locale)}
                </span>
                <Badge variant="outline" className="text-[10px] font-mono">
                  {cap.key}
                </Badge>
                {!cap.workspaceOverridable && (
                  <Badge variant="secondary" className="text-[9px]">
                    {t('admin.plans.badges.noOverride')}
                  </Badge>
                )}
                {cap.internalOnly && (
                  <Badge variant="secondary" className="text-[9px]">
                    {t('admin.plans.badges.internal')}
                  </Badge>
                )}
              </div>
              {capText(cap, locale) && <p className="text-[11px] text-muted-foreground mt-0.5">{capText(cap, locale)}</p>}
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
                  <Label>{t('admin.plans.form.planName')}</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Pro"
                  />
                </div>
                <div>
                  <Label>{t('admin.plans.form.slug')}</Label>
                  <Input
                    value={form.slug}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') }))
                    }
                    placeholder="pro"
                    disabled={isEdit}
                  />
                </div>
              </div>
              <div>
                <Label>{t('admin.plans.form.description')}</Label>
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  rows={2}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>{t('admin.plans.form.sortOrder')}</Label>
                  <Input
                    type="number"
                    value={form.sort_order}
                    onChange={(e) => setForm((f) => ({ ...f, sort_order: parseInt(e.target.value) || 0 }))}
                  />
                </div>
                <div>
                  <Label>{t('admin.plans.form.trialDays')}</Label>
                  <Input
                    type="number"
                    value={form.trial_days}
                    onChange={(e) => setForm((f) => ({ ...f, trial_days: parseInt(e.target.value) || 0 }))}
                  />
                </div>
              </div>
              <div className="space-y-1 sm:max-w-[50%]">
                <Label htmlFor="plan-retention-days">{t('admin.billingLocks.planRetention.label')}</Label>
                <Input
                  id="plan-retention-days"
                  type="text"
                  inputMode="numeric"
                  dir="ltr"
                  placeholder={t('admin.billingLocks.planRetention.never')}
                  value={form.locked_data_retention_days}
                  aria-invalid={retentionInvalid || undefined}
                  onChange={(e) => setForm((f) => ({ ...f, locked_data_retention_days: e.target.value }))}
                  data-testid="plan-locked-retention"
                />
                <p className={`text-[10px] ${retentionInvalid ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {t('admin.simpleBilling.plans.retentionHint')}
                </p>
                <p className="text-[10px] text-muted-foreground">{t('admin.billingLocks.planRetention.hint')}</p>
              </div>
              <Separator />
              <div className="flex gap-6">
                <div className="flex items-center gap-2">
                  <Switch checked={form.is_free} onCheckedChange={(v) => setForm((f) => ({ ...f, is_free: v }))} />
                  <Label>{t('admin.plans.form.freePlan')}</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={form.is_active} onCheckedChange={(v) => setForm((f) => ({ ...f, is_active: v }))} />
                  <Label>{t('admin.plans.active')}</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={form.is_hidden} onCheckedChange={(v) => setForm((f) => ({ ...f, is_hidden: v }))} />
                  <Label>{t('admin.plans.form.hidden')}</Label>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'modules' && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('admin.plans.form.modulesHint')}</p>
              {renderBoolList(byType.module)}
            </div>
          )}

          {activeSection === 'channels' && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('admin.plans.form.channelsHint')}</p>
              {renderBoolList(byType.channel)}
            </div>
          )}

          {activeSection === 'features' && (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">{t('admin.plans.form.featuresHint')}</p>
              {Object.entries(featuresByGroup).map(([group, caps]) => (
                <div key={group} className="space-y-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{capabilityGroupLabel(group, locale)}</p>
                  {renderBoolList(caps)}
                </div>
              ))}
            </div>
          )}

          {activeSection === 'limits' && (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {t('admin.plans.form.limitsHintBefore')} <code className="bg-muted px-1 rounded">-1</code>{' '}
                {t('admin.plans.form.limitsHintAfter')}
              </p>
              {Object.entries(limitsByGroup).map(([group, caps]) => (
                <div key={group} className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{capabilityGroupLabel(group, locale)}</p>
                  <div className="grid grid-cols-2 gap-3">
                    {caps.map((cap) => (
                      <div key={cap.key} className="space-y-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Label className="text-xs">{capName(cap, locale)}</Label>
                          {cap.unit && (
                            <Badge variant="outline" className="text-[9px] font-normal">
                              {capabilityUnitLabel(cap.unit, locale)}
                            </Badge>
                          )}
                        </div>
                        <Input
                          type="number"
                          value={form.limits[cap.key] ?? 0}
                          onChange={(e) => setLimit(cap.key, parseInt(e.target.value) || 0)}
                        />
                        {capText(cap, locale) && <p className="text-[10px] text-muted-foreground">{capText(cap, locale)}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeSection === 'pricing' && (
            <div className="space-y-3">
              {/* The Iranian hints name Toman and per-locale gateways; elsewhere neutral wording. */}
              <p className="text-xs text-muted-foreground">
                {t(edition.isIran ? 'admin.plans.form.pricingHint' : 'admin.plans.form.pricingHintIntl')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(edition.isIran ? 'admin.plans.form.priceUnitHint' : 'admin.plans.form.priceUnitHintIntl')}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {shownCurrencies.map((cur) => {
                  const unit = planPriceUnitLabel(cur, locale);
                  return (
                    <Card key={cur} className="bg-muted/20 border-border">
                      <CardContent className="pt-3 pb-3 space-y-2">
                        <p className="text-xs font-bold text-foreground">{currencyName(cur, locale)}</p>
                        <div className="grid grid-cols-2 gap-2">
                          {PRICE_INTERVALS.map((iv) => {
                            const id = `plan-price-${cur}-${iv}`;
                            const text = priceDrafts[cur]?.[iv] ?? '';
                            const invalid = parsePlanPriceInput(text) === null;
                            return (
                              <div key={iv} className="space-y-1">
                                <Label htmlFor={id} className="text-[11px]">
                                  {t(iv === 'monthly' ? 'admin.plans.monthly' : 'admin.plans.yearly')} ({unit})
                                </Label>
                                <div className="relative" dir="ltr">
                                  <Input
                                    id={id}
                                    type="text"
                                    inputMode={cur === 'IRR' ? 'numeric' : 'decimal'}
                                    dir="ltr"
                                    className={cur === 'IRR' ? 'pe-14' : 'ps-7'}
                                    aria-invalid={invalid || undefined}
                                    value={text}
                                    onChange={(e) => setPrice(cur, iv, e.target.value)}
                                  />
                                  <span
                                    className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-xs text-muted-foreground ${
                                      cur === 'IRR' ? 'end-3' : 'start-3'
                                    }`}
                                    aria-hidden
                                  >
                                    {unit}
                                  </span>
                                </div>
                                <p
                                  className={`text-[10px] ${invalid ? 'text-destructive' : 'text-muted-foreground'}`}
                                  data-testid={`${id}-preview`}
                                >
                                  {invalid ? t('admin.plans.form.priceInvalid') : formatPlanPrice(form.prices[cur]?.[iv], cur, locale)}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {vatCurrencies.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs" data-testid="plan-vat-line">
                  {vatCurrencies.map((cur) => (
                    <span key={cur} className="text-muted-foreground">
                      <span className="font-medium text-foreground">{currencyName(cur, locale)}:</span>{' '}
                      {vatPercent(cur) === null
                        ? t('admin.simpleBilling.plans.vatNone')
                        : t('admin.simpleBilling.plans.vatFromSettings', { percent: vatPercent(cur)!.toLocaleString(locale) })}
                    </span>
                  ))}
                  {onOpenBillingSettings && (
                    <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onOpenBillingSettings}>
                      {t('admin.simpleBilling.plans.editVat')}
                    </Button>
                  )}
                </div>
              )}

              {aiCurrencies.length > 0 && <Separator />}
              {aiCurrencies.length > 0 && <div className="space-y-2">
                <p className="text-xs font-bold text-foreground">{t('admin.simpleBilling.plans.aiAllowance')}</p>
                <p className="text-xs text-muted-foreground">{t('admin.simpleBilling.plans.aiAllowanceHint')}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {aiCurrencies.map((cur) => {
                    const id = `plan-ai-allowance-${cur}`;
                    const unit = planPriceUnitLabel(cur, locale);
                    const text = aiAllowanceText(cur);
                    const value = aiAllowanceValue(text, cur);
                    return (
                      <div key={cur} className="space-y-1">
                        <Label htmlFor={id} className="text-[11px]">
                          {currencyName(cur, locale)} ({unit})
                        </Label>
                        <Input
                          id={id}
                          type="text"
                          inputMode={cur === 'IRR' ? 'numeric' : 'decimal'}
                          dir="ltr"
                          aria-invalid={value === null || undefined}
                          value={text}
                          onChange={(e) => setForm((f) => ({ ...f, ai_allowance: { ...f.ai_allowance, [cur]: e.target.value } }))}
                        />
                        <p className={`text-[10px] ${value === null ? 'text-destructive' : 'text-muted-foreground'}`} data-testid={`${id}-preview`}>
                          {value === null ? t('admin.plans.form.priceInvalid') : formatPlanPrice(value, cur, locale)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>}
            </div>
          )}

          {activeSection === 'locales' && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">{t('admin.plans.form.translationsHint')}</p>
              {locales.map((loc) => (
                <Card key={loc} className="bg-muted/20 border-border">
                  <CardContent className="pt-3 pb-3 space-y-2">
                    <p className="text-xs font-bold text-foreground">
                      {LOCALE_FLAGS[loc]} {languageName(loc, locale)}
                    </p>
                    <Input
                      value={form.localized[loc]?.name || ''}
                      onChange={(e) => updateLocalized(loc, 'name', e.target.value)}
                      placeholder={t('admin.plans.form.localizedName', { locale: languageName(loc, locale) })}
                      dir={loc === 'fa' || loc === 'ar' ? 'rtl' : 'ltr'}
                    />
                    <Textarea
                      value={form.localized[loc]?.description || ''}
                      onChange={(e) => updateLocalized(loc, 'description', e.target.value)}
                      placeholder={t('admin.plans.form.localizedDescription', { locale: languageName(loc, locale) })}
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
                <div className="text-xs text-muted-foreground">{t('admin.plans.form.legacyHint')}</div>
              </div>
              {Object.keys(form.legacyEntitlements).length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                    {t('admin.plans.form.legacyEntitlements')}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(form.legacyEntitlements).map(([k, v]) => (
                      <Badge key={k} variant="outline" className="text-[11px] font-mono">
                        {k} = {String(v)}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {Object.keys(form.legacyLimits).length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                    {t('admin.plans.form.legacyLimits')}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(form.legacyLimits).map(([k, v]) => (
                      <Badge key={k} variant="outline" className="text-[11px] font-mono">
                        {k} = {String(v)}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {issues.length > 0 && (
            <div className="space-y-1 border-t border-border pt-3">
              <p className="text-[11px] font-semibold text-muted-foreground">
                {t('admin.plans.validation.title')}
              </p>
              {issues.map((i, idx) => (
                <div
                  key={idx}
                  className={`text-[11px] flex items-start gap-1.5 ${i.level === 'error' ? 'text-destructive' : 'text-amber-500'}`}
                >
                  {i.level === 'error' ? (
                    <XCircle className="w-3 h-3 mt-0.5" />
                  ) : (
                    <AlertTriangle className="w-3 h-3 mt-0.5" />
                  )}
                  <span>
                    <code className="font-mono">{i.key}</code> — {i.code ? t(`admin.plans.validation.issues.${i.code}` as TranslationKey) : i.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-border px-5 py-3 bg-background flex items-center justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            {t('admin.plans.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending && <Loader2 className="w-4 h-4 animate-spin me-2" />}
            {isEdit ? t('admin.plans.form.updatePlan') : t('admin.plans.form.createPlan')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Effective Console & Overrides ───
function WorkspaceConsole({ capabilities }: { capabilities: CapabilityDefinition[] }) {
  const { t, locale } = useTranslation();
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
        setLimitOvIds(
          Object.fromEntries(
            (res.limits || []).map((o) => [o.limit_key!, { id: o.id, value: Number(o.limit_value ?? 0) }]),
          ),
        );
      })
      .catch(() => {
        /* non-fatal — clear UI just won't appear */
      });
    return () => {
      cancelled = true;
    };
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
        await setWorkspaceModuleOverride({
          workspaceId,
          moduleKey: key,
          enabled: !current,
          adminNotes: 'Toggled from admin console',
        });
      } else {
        await setWorkspaceChannelOverride({
          workspaceId,
          channelKey: key,
          enabled: !current,
          adminNotes: 'Toggled from admin console',
        });
      }
      toast.success(t('admin.plans.console.overrideApplied'));
      reload();
    } catch (e) {
      toast.error(errorText(e) || t('admin.plans.console.overrideFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function clearOverride(kind: 'module' | 'channel', key: string) {
    if (!workspaceId) return;
    const id = kind === 'module' ? moduleOvIds[key] : channelOvIds[key];
    if (!id) {
      toast.error(t('admin.plans.console.overrideIdMissing'));
      return;
    }
    if (!window.confirm(t('admin.plans.console.confirmClear'))) return;
    setBusy(`clear:${kind}:${key}`);
    try {
      if (kind === 'module') await deleteWorkspaceModuleOverride(id);
      else await deleteWorkspaceChannelOverride(id);
      toast.success(t('admin.plans.console.overrideCleared'));
      reload();
    } catch (e) {
      toast.error(errorText(e) || t('admin.plans.console.clearFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function applyLimitOverride(key: string, raw: string) {
    if (!workspaceId) return;
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') {
      toast.error(t('admin.plans.console.enterLimit'));
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < -1) {
      toast.error(t('admin.plans.console.invalidLimit'));
      return;
    }
    setBusy(`limit:${key}`);
    try {
      await setWorkspaceLimitOverride({
        workspaceId,
        limitKey: key,
        limitValue: n,
        adminNotes: 'Set from admin console',
      });
      toast.success(t('admin.plans.console.limitApplied'));
      setLimitDrafts((d) => {
        const { [key]: _drop, ...rest } = d;
        return rest;
      });
      reload();
    } catch (e) {
      toast.error(errorText(e) || t('admin.plans.console.overrideFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function clearLimitOverride(key: string) {
    if (!workspaceId) return;
    const entry = limitOvIds[key];
    if (!entry) {
      toast.error(t('admin.plans.console.overrideIdMissing'));
      return;
    }
    if (!window.confirm(t('admin.plans.console.confirmClear'))) return;
    setBusy(`clear:limit:${key}`);
    try {
      await deleteWorkspaceLimitOverride(entry.id);
      toast.success(t('admin.plans.console.limitCleared'));
      setLimitDrafts((d) => {
        const { [key]: _drop, ...rest } = d;
        return rest;
      });
      reload();
    } catch (e) {
      toast.error(errorText(e) || t('admin.plans.console.clearFailed'));
    } finally {
      setBusy(null);
    }
  }

  const sourceBadge = (source: string) => {
    const cls =
      source === 'override'
        ? 'bg-amber-500/15 text-amber-600 border-amber-500/30'
        : source === 'plan'
          ? 'bg-primary/10 text-primary border-primary/20'
          : 'bg-muted text-muted-foreground border-transparent';
    return (
      <Badge variant="outline" className={`text-[9px] ${cls}`}>
        {t(`admin.plans.sources.${source}` as TranslationKey)}
      </Badge>
    );
  };

  const renderBoolBlock = (
    title: string,
    caps: CapabilityDefinition[],
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
            <div
              key={cap.key}
              className={`flex items-center justify-between gap-2 px-3 py-2 rounded-md border ${rowCls}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  {value ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-muted-foreground opacity-50" />
                  )}
                  <span className="text-sm">{capName(cap, locale)}</span>
                  <Badge variant="outline" className="text-[9px] font-mono">
                    {cap.key}
                  </Badge>
                  {eff && sourceBadge(eff.source)}
                  {isOverride && (
                    <span className="text-[10px] text-amber-600">
                      {value ? t('admin.plans.console.forcedOn') : t('admin.plans.console.forcedOff')}
                    </span>
                  )}
                  {!cap.workspaceOverridable && (
                    <Badge variant="secondary" className="text-[9px]">
                      {t('admin.plans.badges.locked')}
                    </Badge>
                  )}
                </div>
                {eff?.note && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {t('admin.plans.console.note')}: {eff.note}
                  </p>
                )}
              </div>
              {canOverride && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[11px] h-7"
                    disabled={busy === `${kind}:${cap.key}`}
                    onClick={() => toggleOverride(kind!, cap.key, value)}
                    title={
                      value
                        ? t('admin.plans.console.forceOffTitle')
                        : t('admin.plans.console.forceOnTitle')
                    }
                  >
                    {busy === `${kind}:${cap.key}` ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : value ? (
                      t('admin.plans.console.forceOff')
                    ) : (
                      t('admin.plans.console.forceOn')
                    )}
                  </Button>
                  {isOverride && (kind === 'module' ? moduleOvIds[cap.key] : channelOvIds[cap.key]) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-[11px] h-7 text-amber-600 hover:text-amber-700 hover:bg-amber-500/10"
                      disabled={busy === `clear:${kind}:${cap.key}`}
                      onClick={() => clearOverride(kind!, cap.key)}
                      title={t('admin.plans.console.clearTitle')}
                    >
                      {busy === `clear:${kind}:${cap.key}` ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <>
                          <RotateCcw className="w-3 h-3 me-1" /> {t('admin.plans.console.clear')}
                        </>
                      )}
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
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="w-4 h-4" /> {t('admin.plans.console.title')}
        </CardTitle>
        <CardDescription>{t('admin.plans.console.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 items-end flex-wrap">
          <div className="min-w-[280px]">
            <Label>{t('admin.plans.workspace')}</Label>
            <Select value={workspaceId} onValueChange={setWorkspaceId}>
              <SelectTrigger>
                <SelectValue placeholder={t('admin.plans.selectWorkspace')} />
              </SelectTrigger>
              <SelectContent>
                {(workspaces || []).map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name} ({w.slug})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" disabled={!workspaceId || loading} onClick={reload}>
            <RefreshCw className={`w-3.5 h-3.5 me-1.5 ${loading ? 'animate-spin' : ''}`} />{' '}
            {t('admin.plans.reload')}
          </Button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
        {!workspaceId && <p className="text-xs text-muted-foreground">{t('admin.plans.console.selectHint')}</p>}

        {data && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3 text-xs">
              <div className="px-3 py-2 rounded-lg bg-muted/40">
                <span className="text-muted-foreground">{t('admin.plans.plan')}:</span>{' '}
                <span className="font-medium text-foreground">{planName(data.plan, locale)}</span>
                {data.plan?.slug && (
                  <Badge variant="outline" className="ml-1.5 text-[10px] font-mono">
                    {data.plan.slug}
                  </Badge>
                )}
              </div>
              <div className="px-3 py-2 rounded-lg bg-muted/40">
                <span className="text-muted-foreground">{t('admin.plans.subscription')}:</span>{' '}
                <span className="font-medium text-foreground">
                  {data.subscription?.status
                    ? statusLabel(t, data.subscription.status)
                    : t('admin.plans.statuses.none')}
                </span>
              </div>
              {data.subscription?.current_period_end && (
                <div className="px-3 py-2 rounded-lg bg-muted/40">
                  <span className="text-muted-foreground">{t('admin.plans.console.renews')}:</span>{' '}
                  <span className="font-medium text-foreground">
                    {new Date(data.subscription.current_period_end).toLocaleDateString(locale)}
                  </span>
                </div>
              )}
            </div>

            <Separator />
            {renderBoolBlock(t('admin.plans.modules'), moduleCaps, data.modules, 'module')}
            {renderBoolBlock(t('admin.plans.channels'), channelCaps, data.channels, 'channel')}
            {renderBoolBlock(t('admin.plans.features'), featureCaps, data.features)}

            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('admin.plans.limits')}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {t('admin.plans.console.limitHintBefore')} <code className="bg-muted px-1 rounded">-1</code>{' '}
                {t('admin.plans.console.limitHintAfter')}
              </p>
              <div className="grid grid-cols-1 gap-1.5">
                {limitCaps.map((cap) => {
                  const eff = data.limits?.[cap.key];
                  const val = eff?.value;
                  const display =
                    val === -1
                      ? t('admin.plans.unlimited')
                      : val == null
                        ? '—'
                        : Number(val).toLocaleString(locale);
                  const isOverride = eff?.source === 'override';
                  const ov = limitOvIds[cap.key];
                  const draft = limitDrafts[cap.key] ?? '';
                  const canOverride = cap.workspaceOverridable;
                  const rowCls = isOverride
                    ? 'border-amber-500/30 bg-amber-500/5'
                    : 'border-transparent bg-muted/30 hover:border-border';
                  return (
                    <div
                      key={cap.key}
                      className={`flex items-center justify-between gap-2 px-3 py-2 rounded-md border ${rowCls}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs text-foreground">{capName(cap, locale)}</span>
                          <Badge variant="outline" className="text-[9px] font-mono">
                            {cap.key}
                          </Badge>
                          {eff && sourceBadge(eff.source)}
                          {isOverride && (
                            <span className="text-[10px] text-amber-600">
                              {t('admin.plans.console.overrideActive')}
                            </span>
                          )}
                          {!canOverride && (
                            <Badge variant="secondary" className="text-[9px]">
                              {t('admin.plans.badges.locked')}
                            </Badge>
                          )}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {t('admin.plans.console.effective')}:{' '}
                          <span className="font-mono text-foreground">{display}</span>
                          {cap.unit ? ` ${capabilityUnitLabel(cap.unit, locale)}` : ''}
                        </div>
                        {eff?.note && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {t('admin.plans.console.note')}: {eff.note}
                          </p>
                        )}
                      </div>
                      {canOverride && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Input
                            type="number"
                            step={1}
                            min={-1}
                            className="h-7 w-24 text-xs font-mono"
                            placeholder={ov ? String(ov.value) : typeof val === 'number' ? String(val) : ''}
                            value={draft}
                            onChange={(e) => setLimitDrafts((d) => ({ ...d, [cap.key]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') applyLimitOverride(cap.key, draft);
                            }}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-[11px] h-7"
                            disabled={busy === `limit:${cap.key}` || draft.trim() === ''}
                            onClick={() => applyLimitOverride(cap.key, draft)}
                            title={t('admin.plans.console.setLimitTitle')}
                          >
                            {busy === `limit:${cap.key}` ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : ov ? (
                              t('admin.plans.update')
                            ) : (
                              t('admin.plans.set')
                            )}
                          </Button>
                          {isOverride && ov && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-[11px] h-7 text-amber-600 hover:text-amber-700 hover:bg-amber-500/10"
                              disabled={busy === `clear:limit:${cap.key}`}
                              onClick={() => clearLimitOverride(cap.key)}
                              title={t('admin.plans.console.clearTitle')}
                            >
                              {busy === `clear:limit:${cap.key}` ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <>
                                  <RotateCcw className="w-3 h-3 me-1" /> {t('admin.plans.console.clear')}
                                </>
                              )}
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
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                  {t('admin.plans.console.usageSnapshot')}
                </p>
                <ScrollArea className="max-h-40">
                  <pre className="text-[11px] text-muted-foreground bg-muted/30 rounded p-2">
                    {JSON.stringify(data.usage, null, 2)}
                  </pre>
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
  const { t, locale } = useTranslation();
  const { data, loading, error, reload } = useEntitlementDiagnostics();
  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Settings2 className="w-4 h-4" /> {t('admin.plans.diagnostics.title')}
            </CardTitle>
            <CardDescription>{t('admin.plans.diagnostics.description')}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 me-1.5 ${loading ? 'animate-spin' : ''}`} />{' '}
            {t('admin.plans.reload')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!data && loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
        {data && (
          <>
            <div className="flex gap-3 flex-wrap text-xs">
              <div className="px-3 py-2 rounded-lg bg-muted/40">
                <span className="text-muted-foreground">{t('admin.plans.diagnostics.registry')}:</span>{' '}
                <span className="font-medium text-foreground">{data.registrySize}</span>
              </div>
              <div className="px-3 py-2 rounded-lg bg-muted/40">
                <span className="text-muted-foreground">{t('admin.plans.diagnostics.plansChecked')}:</span>{' '}
                <span className="font-medium text-foreground">{data.plansChecked}</span>
              </div>
              <div className="px-3 py-2 rounded-lg bg-muted/40">
                <span className="text-muted-foreground">{t('admin.plans.diagnostics.unknownKeys')}:</span>{' '}
                <span className="font-medium text-foreground">{data.unknownKeysInDb.length}</span>
              </div>
              <div className="px-3 py-2 rounded-lg bg-muted/40">
                <span className="text-muted-foreground">{t('admin.plans.diagnostics.missingKeys')}:</span>{' '}
                <span className="font-medium text-foreground">{data.registryKeysMissingEverywhere.length}</span>
              </div>
              <div className="px-3 py-2 rounded-lg bg-muted/40">
                <span className="text-muted-foreground">{t('admin.plans.diagnostics.invalidLimits')}:</span>{' '}
                <span className="font-medium text-foreground">{data.invalidLimitValues.length}</span>
              </div>
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                {t('admin.plans.diagnostics.unknownTitle')}
              </p>
              {data.unknownKeysInDb.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('admin.plans.diagnostics.noUnknown')}</p>
              ) : (
                <div className="space-y-1">
                  {data.unknownKeysInDb.map((u, i) => (
                    <div key={i} className="text-xs flex items-center gap-2">
                      <AlertTriangle className="w-3 h-3 text-amber-500" />
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {u.planSlug}
                      </Badge>
                      <span className="font-mono">{u.key}</span>
                      <Badge variant="secondary" className="text-[9px]">
                        {u.bucket}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                {t('admin.plans.diagnostics.unusedTitle')}
              </p>
              {data.registryKeysMissingEverywhere.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('admin.plans.diagnostics.allUsed')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {data.registryKeysMissingEverywhere.map((k) => (
                    <Badge key={k} variant="outline" className="text-[10px] font-mono">
                      {k}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {data.invalidLimitValues.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                  {t('admin.plans.diagnostics.invalidTitle')}
                </p>
                <div className="space-y-1">
                  {data.invalidLimitValues.map((v, i) => (
                    <div key={i} className="text-xs flex items-center gap-2 text-destructive">
                      <XCircle className="w-3 h-3" />
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {v.planSlug}
                      </Badge>
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
  const { t, locale } = useTranslation();
  // The Rial (Toman) price is shown and edited in the Iranian edition only.
  const edition = useEdition();
  const shownCurrencies = CURRENCIES.filter((cur) => edition.allowsCurrency(cur));
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

  const [editPlan, setEditPlan] = useState<AdminPlan | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // Deep links: ?tab=<tab> opens a tab; ?tab=assign&workspace=<uuid> preselects
  // the workspace (Finance → account detail links here). An unknown tab or a
  // malformed id is ignored.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab = rawTab && (PAGE_TABS as readonly string[]).includes(rawTab) ? rawTab : 'plans';
  const rawWorkspace = searchParams.get('workspace');
  const linkedWorkspaceId = rawWorkspace && UUID_RE.test(rawWorkspace) ? rawWorkspace : '';
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'plans') params.delete('tab');
    else params.set('tab', next);
    if (next !== 'assign') params.delete('workspace');
    setSearchParams(params, { replace: true });
  };
  const [assignForm, setAssignForm] = useState({ workspaceId: linkedWorkspaceId, planId: '' });
  useEffect(() => {
    if (linkedWorkspaceId) setAssignForm((f) => ({ ...f, workspaceId: linkedWorkspaceId }));
  }, [linkedWorkspaceId]);
  // The linked workspace may be outside the first page of workspaces: its name comes from its billing account.
  const linkedListed = !linkedWorkspaceId || (workspaces || []).some((w) => w.id === linkedWorkspaceId);
  const { data: linkedAccount } = useAdminAccount(linkedListed ? null : linkedWorkspaceId);
  const openBillingSettings = () => {
    setEditPlan(null);
    setShowCreate(false);
    setTab('billing-settings');
  };

  // Derived per-card view, registry-aware
  const moduleKeys = useMemo(() => new Set(caps.filter((c) => c.type === 'module').map((c) => c.key)), [caps]);
  const channelKeys = useMemo(() => new Set(caps.filter((c) => c.type === 'channel').map((c) => c.key)), [caps]);
  const featureKeys = useMemo(() => new Set(caps.filter((c) => c.type === 'feature').map((c) => c.key)), [caps]);
  const limitDefs = useMemo(() => caps.filter((c) => c.type === 'limit'), [caps]);
  const aiCardCurrencies = aiAllowanceCurrencies(edition.edition, undefined);
  const capByKey = useMemo(() => new Map(caps.map((c) => [c.key, c])), [caps]);

  if (isLoading || catLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (catError) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="py-6 text-sm text-destructive flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {t('admin.plans.registryLoadFailed')}: {catError}
        </CardContent>
      </Card>
    );
  }

  async function handleDelete(planId: string) {
    if (!confirm(t('admin.plans.confirmDeactivate'))) return;
    try {
      await deletePlan.mutateAsync(planId);
      toast.success(t('admin.plans.messages.deactivated'));
    } catch (e) {
      toast.error(errorText(e) ?? t('admin.plans.messages.actionFailed'));
    }
  }

  async function handleAssign() {
    if (!assignForm.workspaceId || !assignForm.planId) return;
    try {
      await assignPlan.mutateAsync({ workspaceId: assignForm.workspaceId, planId: assignForm.planId });
      toast.success(t('admin.plans.messages.assigned'));
      setAssignForm({ workspaceId: '', planId: '' });
      if (linkedWorkspaceId) {
        const params = new URLSearchParams(searchParams);
        params.delete('workspace');
        setSearchParams(params, { replace: true });
      }
    } catch (e) {
      toast.error(errorText(e) ?? t('admin.plans.messages.actionFailed'));
    }
  }

  async function handleRevoke(wsId: string) {
    if (!confirm(t('admin.plans.confirmRevoke'))) return;
    try {
      await revokePlan.mutateAsync(wsId);
      toast.success(t('admin.plans.messages.revoked'));
    } catch (e) {
      toast.error(errorText(e) ?? t('admin.plans.messages.actionFailed'));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('admin.plans.title')}</h1>
          <p className="text-muted-foreground text-sm flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5" />
            {t('admin.plans.capabilitiesLoaded', { count: caps.length })}
          </p>
        </div>
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="w-4 h-4 me-2" /> {t('admin.plans.createPlan')}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-5xl w-[95vw] p-0 gap-0 max-h-[90vh] flex flex-col overflow-hidden">
            <DialogHeader className="px-5 py-4 border-b border-border shrink-0">
              <DialogTitle>{t('admin.plans.createNewPlan')}</DialogTitle>
            </DialogHeader>
            <PlanFormDialog
              onClose={() => setShowCreate(false)}
              locales={locales}
              capabilities={caps}
              onOpenBillingSettings={openBillingSettings}
            />
          </DialogContent>
        </Dialog>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-muted">
          <TabsTrigger value="plans">
            <CreditCard className="w-3.5 h-3.5 me-1.5" />{' '}
            {t('admin.plans.tabs.plans', { count: plans?.length || 0 })}
          </TabsTrigger>
          <TabsTrigger value="subscriptions">
            <Users className="w-3.5 h-3.5 me-1.5" />{' '}
            {t('admin.plans.tabs.subscriptions', { count: subscriptions?.length || 0 })}
          </TabsTrigger>
          <TabsTrigger value="assign">
            <Shield className="w-3.5 h-3.5 me-1.5" /> {t('admin.plans.tabs.assign')}
          </TabsTrigger>
          <TabsTrigger value="effective">
            <Activity className="w-3.5 h-3.5 me-1.5" /> {t('admin.plans.tabs.console')}
          </TabsTrigger>
          <TabsTrigger value="diagnostics">
            <SlidersHorizontal className="w-3.5 h-3.5 me-1.5" /> {t('admin.plans.tabs.diagnostics')}
          </TabsTrigger>
          <TabsTrigger value="billing-settings">
            <CreditCard className="w-3.5 h-3.5 me-1.5" /> {t('admin.simpleBilling.tab')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="billing-settings" className="space-y-4">
          <BillingSettingsPanel />
          <AiPacksPanel />
        </TabsContent>

        {/* ─── Plans Tab (registry-aware cards) ─── */}
        <TabsContent value="plans" className="space-y-4">
          {!plans || plans.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="py-16 text-center text-muted-foreground">
                <CreditCard className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-lg font-medium">{t('admin.plans.empty')}</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {(plans as AdminPlan[]).map((plan) => {
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
                          <div
                            className={`w-10 h-10 rounded-xl flex items-center justify-center ${plan.is_free ? 'bg-muted' : 'bg-primary/10'}`}
                          >
                            <Crown className={`w-5 h-5 ${plan.is_free ? 'text-muted-foreground' : 'text-primary'}`} />
                          </div>
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <CardTitle className="text-lg">{planName(plan, locale)}</CardTitle>
                              <Badge variant="outline" className="text-[10px] font-mono">
                                {plan.slug}
                              </Badge>
                              {plan.is_free && (
                                <Badge variant="secondary" className="text-[10px]">
                                  {t('admin.plans.free')}
                                </Badge>
                              )}
                              {plan.trial_days > 0 && (
                                <Badge variant="outline" className="text-[10px]">
                                  {t('admin.plans.trialDays', { count: plan.trial_days })}
                                </Badge>
                              )}
                              {plan.is_hidden && (
                                <Badge variant="outline" className="text-[10px] border-purple-500/40 text-purple-600">
                                  {t('admin.plans.hidden')}
                                </Badge>
                              )}
                              {legacyCount > 0 && (
                                <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600">
                                  {t('admin.plans.legacyCount', { count: legacyCount })}
                                </Badge>
                              )}
                            </div>
                            <CardDescription className="text-xs mt-0.5">
                              {plan.description || t('admin.plans.noDescription')}
                            </CardDescription>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Badge variant={plan.is_active ? 'default' : 'destructive'} className="text-[10px]">
                            {plan.is_active ? t('admin.plans.active') : t('admin.plans.inactive')}
                          </Badge>
                          <Dialog open={editPlan?.id === plan.id} onOpenChange={(v) => !v && setEditPlan(null)}>
                            <DialogTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditPlan(plan)}>
                                <Edit2 className="w-3.5 h-3.5" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="max-w-5xl w-[95vw] p-0 gap-0 max-h-[90vh] flex flex-col overflow-hidden">
                              <DialogHeader className="px-5 py-4 border-b border-border shrink-0">
                                <DialogTitle>
                                  {t('admin.plans.editPlan')}: {planName(plan, locale)}
                                </DialogTitle>
                              </DialogHeader>
                              <PlanFormDialog
                                plan={plan}
                                onClose={() => setEditPlan(null)}
                                locales={locales}
                                capabilities={caps}
                                onOpenBillingSettings={openBillingSettings}
                              />
                            </DialogContent>
                          </Dialog>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handleDelete(plan.id)}
                            disabled={deletePlan.isPending}
                          >
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {Object.keys(localized).some((l) => localized[l]?.name) && (
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries(localized).map(([loc, d]) =>
                            d.name ? (
                              <Badge key={loc} variant="outline" className="text-[11px] gap-1 font-normal">
                                <Globe className="w-3 h-3" />
                                {LOCALE_FLAGS[loc] || loc} {d.name}
                              </Badge>
                            ) : null,
                          )}
                        </div>
                      )}

                      {!plan.is_free && (
                        <div className="flex flex-wrap gap-3">
                          {shownCurrencies.map((cur) => {
                            const p = plan.prices?.[cur];
                            if (!p?.monthly && !p?.yearly) return null;
                            return (
                              <div key={cur} className="bg-muted/40 rounded-lg px-3 py-1.5 text-sm">
                                <span className="font-bold text-foreground">{cur}</span>
                                <span className="text-muted-foreground ms-1.5">
                                  {formatPlanPrice(p.monthly, cur, locale)}/{t('admin.plans.monthShort')}
                                </span>
                                {p.yearly > 0 && (
                                  <span className="text-muted-foreground">
                                    {' '}
                                    · {formatPlanPrice(p.yearly, cur, locale)}/{t('admin.plans.yearShort')}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <div className="space-y-2">
                        <p className="text-[11px] text-muted-foreground font-medium">
                          {t('admin.plans.capabilitySummary', {
                            enabled: enabledTotal,
                            total: totalBool,
                            modules: enabledModules.length,
                            channels: enabledChannels.length,
                            features: enabledFeatures.length,
                          })}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {[...enabledModules, ...enabledChannels, ...enabledFeatures].map((k) => {
                            const c = capByKey.get(k);
                            if (!c) return null;
                            return (
                              <Badge
                                key={k}
                                variant="outline"
                                className="text-[10px] gap-1 bg-primary/5 text-primary border-primary/20"
                              >
                                <CheckCircle2 className="w-3 h-3" />
                                {capName(c, locale)}
                              </Badge>
                            );
                          })}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {limitDefs.filter((cap) => cap.key !== AI_ALLOWANCE_LIMIT_KEY || !(aiCardCurrencies.includes('IRR') && (plan.ai_allowance?.IRR ?? 0) > 0)).map((cap) => {
                          const val = limits[cap.key];
                          if (val === undefined) return null;
                          return (
                            <Badge key={cap.key} variant="secondary" className="text-[11px] font-normal">
                              {capName(cap, locale)}: {val === -1 ? '∞' : val?.toLocaleString(locale)}
                              {cap.unit ? ` ${capabilityUnitLabel(cap.unit, locale)}` : ''}
                            </Badge>
                          );
                        })}
                        {typeof plan.locked_data_retention_days === 'number' && plan.locked_data_retention_days > 0 && (
                          <Badge variant="secondary" className="text-[11px] font-normal">
                            {t('admin.simpleBilling.plans.retentionDays')}: {plan.locked_data_retention_days.toLocaleString(locale)}
                          </Badge>
                        )}
                        {aiCardCurrencies.map((cur) => {
                          const v = plan.ai_allowance?.[cur];
                          if (typeof v !== 'number' || v <= 0) return null;
                          return (
                            <Badge key={`ai-${cur}`} variant="secondary" className="text-[11px] font-normal">
                              {t('admin.simpleBilling.plans.aiAllowance')}: {formatPlanPrice(v, cur, locale)}
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
                  <TableHead>{t('admin.plans.workspace')}</TableHead>
                  <TableHead>{t('admin.plans.plan')}</TableHead>
                  <TableHead>{t('admin.plans.status')}</TableHead>
                  <TableHead>{t('admin.plans.provider')}</TableHead>
                  <TableHead>{t('admin.plans.periodEnd')}</TableHead>
                  <TableHead>{t('admin.plans.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!subscriptions || subscriptions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                      {t('admin.plans.noSubscriptions')}
                    </TableCell>
                  </TableRow>
                ) : (
                  (subscriptions as AdminSubscription[]).map((sub) => (
                    <TableRow key={sub.id} className="border-border hover:bg-muted/50">
                      <TableCell className="font-mono text-xs">{sub.workspace_id?.slice(0, 8)}...</TableCell>
                      <TableCell>{sub.billing_plans?.name || sub.plan_id?.slice(0, 8)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            sub.status === 'active'
                              ? 'default'
                              : sub.status === 'trialing'
                                ? 'secondary'
                                : 'destructive'
                          }
                        >
                          {statusLabel(t, sub.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{sub.provider_name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {sub.current_period_end ? new Date(sub.current_period_end).toLocaleDateString(locale) : '—'}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRevoke(sub.workspace_id)}
                          className="text-destructive text-xs"
                        >
                          {t('admin.plans.revoke')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="assign">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="w-4 h-4" /> {t('admin.plans.assign.title')}
              </CardTitle>
              <CardDescription>{t('admin.plans.assign.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label>{t('admin.plans.workspace')}</Label>
                  <Select
                    value={assignForm.workspaceId}
                    onValueChange={(v) => setAssignForm((f) => ({ ...f, workspaceId: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('admin.plans.selectWorkspace')} />
                    </SelectTrigger>
                    <SelectContent>
                      {!linkedListed && (
                        <SelectItem value={linkedWorkspaceId}>
                          {linkedAccount ? `${linkedAccount.workspace.name} (${linkedAccount.workspace.slug})` : linkedWorkspaceId}
                        </SelectItem>
                      )}
                      {(workspaces || []).map((w) => (
                        <SelectItem key={w.id} value={w.id}>
                          {w.name} ({w.slug})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>{t('admin.plans.plan')}</Label>
                  <Select value={assignForm.planId} onValueChange={(v) => setAssignForm((f) => ({ ...f, planId: v }))}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('admin.plans.selectPlan')} />
                    </SelectTrigger>
                    <SelectContent>
                      {(plans || [])
                        .filter((p: AdminPlan) => p.is_active)
                        .map((p: AdminPlan) => (
                          <SelectItem key={p.id} value={p.id}>
                            {planName(p, locale)}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end">
                  <Button
                    onClick={handleAssign}
                    disabled={!assignForm.workspaceId || !assignForm.planId || assignPlan.isPending}
                  >
                    {assignPlan.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin me-2" />
                    ) : (
                      <Users className="w-4 h-4 me-2" />
                    )}
                    {t('admin.plans.assign.button')}
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
