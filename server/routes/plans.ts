/**
 * Plans & Feature Gating API Routes
 * Full plan info, usage data, module/channel status, upgrade/downgrade.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';
import { type SupabaseClient } from '@supabase/supabase-js';
import { serviceClientFor } from '../lib/serviceClient.js';
import type { ServerConfig } from '../config.js';
import {
  getWorkspacePlanInfoDetailed,
  clearEntitlementCache,
  checkEntitlementFromDB,
  checkModuleAccess,
  checkChannelAccess,
  SELF_HOST_UNLIMITED,
} from '../middleware/featureGating.js';
import { isRelationMissing } from '../services/billing/entitlementParse.js';
import {
  CAPABILITY_REGISTRY,
  type CapabilityType,
  listCapabilities,
  validatePlanPayload,
  diagnoseAgainstPlans,
  normalizePlanLimitsForCreate,
  USAGE_BACKED_LIMIT_KEYS,
} from '../services/billing/capabilityRegistry.js';
import { authorizeWorkspaceAccess, requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { getPlatformEditionOrNull } from '../services/platformRegion.js';
import { isChannelAllowedInEdition, isCurrencyAllowedInEdition, type Edition } from '../../shared/edition.js';
import { PLAN_RETENTION_DAYS } from '../../shared/simpleBillingAdmin.js';
import {
  handleWorkspaceEntitlementChanged,
  handlePlanDefinitionChanged,
} from '../services/billing/entitlementChange.js';
import {
  resolveEffectiveEntitlements,
  publicPlan,
  publicSubscription,
  unlimitedEntitlements,
} from '../services/billing/effectiveEntitlements.js';
import { isUsageSupported, resolveUsage } from '../services/billing/usageResolvers.js';
import { renewalDueNotice } from '../services/billing/account/renewalNotice.js';
import { afterAdminAssignment } from '../services/billing/account/plans.js';
import type { PlanDefinitionLike } from '../services/billing/entitlementFanout.js';
import { lockSummary } from '../services/billing/locks/state.js';


export const plansRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as Request & { serverConfig: ServerConfig }).serverConfig;
}

function getConfig(req: Request) {
  const c = serverConfigOf(req);
  return { url: c.supabaseUrl, key: c.supabaseServiceRoleKey };
}

/**
 * The admin revoke's `plan_change_log` row — the billing-dispute record of
 * what plan a workspace was on and when an admin changed it — so
 * COMPLIANCE_AUDIT_LOGGING has one place to stop. (The admin assign's row is
 * written by billing_account_write_subscription itself, like every simple
 * billing plan change.)
 *
 * Entitlements themselves are unaffected: the authoritative state lives on
 * `workspace_subscriptions` and is written above, and the entitlement-change
 * funnel runs either way. This row is evidence, not state.
 *
 * This router reads the URL/key pair rather than holding a ServerConfig, so
 * the flag is read off `req.serverConfig` the same way getConfig() does.
 */
async function insertPlanChangeLog(
  req: Request,
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<void> {
  const config = (req as Request & { serverConfig?: ServerConfig }).serverConfig;
  if (config?.complianceAuditLoggingEnabled === false) return;
  await supabase.from('plan_change_log').insert(row);
}

/**
 * Every `/admin/*` route below is Platform Super Admin only. The gate runs as
 * router-level middleware so no handler can perform a service-role query or
 * mutation before authorization.
 */
plansRouter.use('/admin', async (req, res, next) => {
  const adminId = await requirePlatformAdmin(req, res);
  if (!adminId) return;
  (req as Request & { adminUserId?: string }).adminUserId = adminId;
  next();
});

/** Public plan fields — never expose provider price ids or internal metadata. */
const PUBLIC_PLAN_COLUMNS =
  'id, name, slug, description, prices, entitlements, limits, is_free, is_active, sort_order, trial_days, default_currency, localized';

// ═══════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════

// GET /api/plans — list active plans
plansRouter.get('/', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const { data, error } = await supabase
    .from('billing_plans')
    .select(PUBLIC_PLAN_COLUMNS)
    .eq('is_active', true)
    .eq('is_hidden', false)
    .order('sort_order');
  if (error) return res.status(500).json({ error: 'Failed to load plans' });
  res.json({ plans: data || [] });
});

// ─────────────────────────────────────────────────────────────
// CAPABILITY CATALOG (registry-driven)
// Read-only. Safe to call from admin & app UI.
// ─────────────────────────────────────────────────────────────
plansRouter.get('/capabilities', async (req, res) => {
  const { type, group } = req.query as { type?: string; group?: string };
  const filter: { type?: CapabilityType; group?: string } = {};
  if (type === 'feature' || type === 'module' || type === 'channel' || type === 'limit') filter.type = type;
  if (typeof group === 'string' && group) filter.group = group;
  // Iranian-only channels (Bale) are not offered outside the Iranian edition
  // (an unknown edition lists everything, as before).
  const edition = await getPlatformEditionOrNull(serverConfigOf(req));
  res.json({
    capabilities: listCapabilities(filter).filter(
      (c) => c.type !== 'channel' || isChannelAllowedInEdition(c.key, edition ?? 'iran'),
    ),
    total: CAPABILITY_REGISTRY.length,
  });
});

// GET /api/plans/check — check single entitlement
plansRouter.get('/check', async (req, res) => {
  const { url, key } = getConfig(req);
  const workspaceId = req.query.workspaceId as string;
  const feature = req.query.feature as string;
  if (!workspaceId || !feature) return res.status(400).json({ error: 'Missing workspaceId or feature' });
  if (!(await authorizeWorkspaceAccess(req, res, workspaceId))) return;
  try {
    const result = await checkEntitlementFromDB(url, key, workspaceId, feature);
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Entitlement check failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// EFFECTIVE WORKSPACE ENTITLEMENTS
// The one snapshot every client renders its sections from. It resolves each
// capability exactly as server-side enforcement does (see
// services/billing/effectiveEntitlements.ts), so what a workspace is shown is
// what it may use.
// ─────────────────────────────────────────────────────────────
plansRouter.get('/workspace/:workspaceId/effective', async (req, res) => {
  const { url, key } = getConfig(req);
  const { workspaceId } = req.params;
  if (!(await authorizeWorkspaceAccess(req, res, workspaceId))) return;
  const supabase = serviceClientFor(url, key);
  try {
    // A self-host install without the billing subsystem enforces nothing
    // (featureGating's documented unlimited mode), so it is shown everything.
    if (serverConfigOf(req).selfHostBillingUnlimited === true) {
      const probe = await checkEntitlementFromDB(url, key, workspaceId, 'chat', { selfHostBillingUnlimited: true });
      if (probe.reason === SELF_HOST_UNLIMITED) return res.json({ workspaceId, ...unlimitedEntitlements() });
    }

    const resolved = await getWorkspacePlanInfoDetailed(url, key, workspaceId);
    if (!resolved.ok) return res.status(503).json(resolved);
    const info = resolved.value;

    const currentPeriod = new Date().toISOString().slice(0, 7);
    const [modulesRead, channelsRead, usageRead, renewal, locks] = await Promise.all([
      supabase.from('workspace_module_overrides').select('module_key, enabled, admin_notes').eq('workspace_id', workspaceId),
      supabase.from('workspace_channel_overrides').select('channel_key, enabled, admin_notes').eq('workspace_id', workspaceId),
      supabase.from('workspace_usage_counters').select('*').eq('workspace_id', workspaceId).eq('period', currentPeriod).maybeSingle(),
      // The panel's "plan ends in N days" banner; never fails the snapshot.
      renewalDueNotice(serverConfigOf(req), workspaceId).catch(() => null),
      // Computed locks over the plan's limits (phase 4); never fails the
      // snapshot: unreadable = nothing locked.
      lockSummary(serverConfigOf(req), workspaceId),
    ]);
    // Enforcement honours these overrides; a snapshot without them would show
    // a section the server refuses (or hide one it allows). A table that does
    // not exist (self-host) holds no overrides.
    if (
      (modulesRead.error && !isRelationMissing(modulesRead.error, 'workspace_module_overrides')) ||
      (channelsRead.error && !isRelationMissing(channelsRead.error, 'workspace_channel_overrides'))
    ) {
      return res.status(503).json({ ok: false, errorCode: 'plan_status_unavailable', retryable: true });
    }

    res.json({
      workspaceId,
      plan: publicPlan(info.plan),
      subscription: publicSubscription(info.subscription),
      ...resolveEffectiveEntitlements(info, modulesRead.error ? [] : modulesRead.data, channelsRead.error ? [] : channelsRead.data),
      usage: usageRead.data || null,
      // card_past_due: the saved card's renewal payment failed (phase 3b).
      renewal_due: renewal
        ? {
            days_left: renewal.days_left,
            period_end: renewal.period_end,
            ends_on_free: renewal.ends_on_free,
            card_past_due: renewal.card_past_due === true,
          }
        : null,
      // What the plan's limits lock now (counts per kind, the next deletion
      // date); `enabled: false` while the edition's billing locks are off.
      locks,
      // The plan's own JSON, for forward-compatible consumers.
      raw: { entitlements: info.entitlements, limits: info.planLimits },
    });
  } catch {
    res.status(500).json({ error: 'Failed to resolve entitlements' });
  }
});

// GET /api/plans/workspace/:workspaceId/limit-usage?keys=a,b — current usage
// per limit key, read by the same resolvers requireLimit enforces with, so a
// client can tell "at the cap" exactly as the server will.
plansRouter.get('/workspace/:workspaceId/limit-usage', async (req, res) => {
  const { workspaceId } = req.params;
  if (!(await authorizeWorkspaceAccess(req, res, workspaceId))) return;
  const requested = String(req.query.keys || '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k && isUsageSupported(k));
  const keys = [...new Set(requested)].slice(0, 20);
  const config = serverConfigOf(req);
  const usage: Record<string, { value: number; supported: boolean; period: string }> = {};
  await Promise.all(keys.map(async (limitKey) => {
    const r = await resolveUsage(config, workspaceId, limitKey);
    usage[limitKey] = { value: r.value, supported: r.supported, period: r.period };
  }));
  res.json({ workspaceId, usage });
});

// ═══════════════════════════════════════════════════════════
// WORKSPACE ROUTES
// ═══════════════════════════════════════════════════════════

// GET /api/plans/workspace/:workspaceId — full plan + usage
plansRouter.get('/workspace/:workspaceId', async (req, res) => {
  const { url, key } = getConfig(req);
  if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId))) return;
  try {
    const resolved = await getWorkspacePlanInfoDetailed(url, key, req.params.workspaceId);
    if (!resolved.ok) return res.status(503).json(resolved);
    const info = resolved.value;

    const supabase = serviceClientFor(url, key);
    const currentPeriod = new Date().toISOString().slice(0, 7);
    const { data: usage } = await supabase
      .from('workspace_usage_counters')
      .select('*')
      .eq('workspace_id', req.params.workspaceId)
      .eq('period', currentPeriod)
      .maybeSingle();

    res.json({
      plan: publicPlan(info.plan),
      subscription: publicSubscription(info.subscription),
      entitlements: info.entitlements,
      limits: info.limits,
      usage: usage || null,
    });
  } catch {
    res.status(500).json({ error: 'Failed to load workspace plan' });
  }
});

// GET /api/plans/workspace/:workspaceId/modules — all module access states
plansRouter.get('/workspace/:workspaceId/modules', async (req, res) => {
  const { url, key } = getConfig(req);
  const { workspaceId } = req.params;
  if (!(await authorizeWorkspaceAccess(req, res, workspaceId))) return;
  const modules = [
    'chat', 'knowledge_base', 'ai_assistant', 'visitor_tracking',
    'email_campaigns', 'automation', 'analytics', 'omnichannel',
    'custom_branding', 'api_access', 'voice_video', 'help_center',
  ];
  const results: Record<string, { allowed: boolean; source?: string }> = {};
  const selfHostBillingUnlimited = serverConfigOf(req).selfHostBillingUnlimited === true;
  await Promise.all(modules.map(async (m) => {
    const r = await checkModuleAccess(url, key, workspaceId, m, { selfHostBillingUnlimited });
    results[m] = { allowed: r.allowed, source: r.reason };
  }));
  res.json({ modules: results });
});

// GET /api/plans/workspace/:workspaceId/channels — all channel access
plansRouter.get('/workspace/:workspaceId/channels', async (req, res) => {
  const { url, key } = getConfig(req);
  const { workspaceId } = req.params;
  if (!(await authorizeWorkspaceAccess(req, res, workspaceId))) return;
  const channels = ['chat_widget', 'email', 'whatsapp', 'sms', 'instagram', 'telegram', 'voice', 'video'];
  const results: Record<string, { allowed: boolean; source?: string }> = {};
  const selfHostBillingUnlimited = serverConfigOf(req).selfHostBillingUnlimited === true;
  await Promise.all(channels.map(async (c) => {
    const r = await checkChannelAccess(url, key, workspaceId, c, { selfHostBillingUnlimited });
    results[c] = { allowed: r.allowed, source: r.reason };
  }));
  res.json({ channels: results });
});

// GET /api/plans/workspace/:workspaceId/usage — usage history
plansRouter.get('/workspace/:workspaceId/usage', async (req, res) => {
  const { url, key } = getConfig(req);
  if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId))) return;
  const supabase = serviceClientFor(url, key);
  const { data, error } = await supabase
    .from('workspace_usage_counters')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .order('period', { ascending: false })
    .limit(12);
  if (error) return res.status(500).json({ error: 'Failed to load usage' });
  res.json({ usage: data || [] });
});

// ═══════════════════════════════════════════════════════════
// ADMIN: Plan CRUD
// ═══════════════════════════════════════════════════════════

plansRouter.get('/admin/all', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const { data, error } = await supabase.from('billing_plans').select('*').order('sort_order');
  if (error) return res.status(500).json({ error: 'Request failed' });
  res.json({ plans: data || [] });
});

// ─── Plan bodies (phase 6, decision D19) ───────────────────────────────────
// A whitelist of billing_plans columns: an unknown key is refused (400
// INVALID_REQUEST with `issues`) instead of being written. Prices are
// `{CUR: {monthly, yearly}}` in minor units (IRR in whole Rial): a negative
// or fractional price of a currency the edition sells is refused (400
// INVALID_PRICE); a currency the edition does not sell is kept as it is
// (never shown or read there). The monthly AI credit is `ai_allowance`
// per currency (the AI wallet's unit); while its key is IRR it is mirrored
// into `limits.included_ai_allowance_irr`, which older readers still use
// until phase 7.
//
// The fields phase 4 validated (its former cleanPlanExtras) keep its rules
// and readable errors here, in the same schema:
//   locked_data_retention_days  days locked data is kept, then deleted after
//                               the 30/7-day notices: whole days from 1 to
//                               36500 (a digits-only string is read as that
//                               number); null or '' = never deleted
//   is_hidden                   boolean
//   ai_allowance                an object of whole amounts >= 0 per currency;
//                               null = {}
// A bad value of one of them answers 400 with phase 4's `error` text and
// `field`, plus the `issues` every other refusal carries.

const CURRENCY_KEY = /^[A-Z]{3}$/;
const jsonObject = z.record(z.string(), z.unknown());

const retentionDaysField = z.preprocess(
  (v) => (v === '' ? null : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v),
  z.number().int().min(PLAN_RETENTION_DAYS.min).max(PLAN_RETENTION_DAYS.max).nullable(),
);
const aiAllowanceField = z.preprocess(
  (v) => (v === null ? {} : v),
  z.record(z.string().regex(CURRENCY_KEY), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)),
);

/** Phase 4's readable error per plan field it validated. */
const PLAN_FIELD_ERRORS: Record<string, string> = {
  locked_data_retention_days: `locked_data_retention_days must be a whole number of days greater than 0 and at most ${PLAN_RETENTION_DAYS.max} (or empty: never deleted)`,
  is_hidden: 'is_hidden must be true or false',
  ai_allowance: 'ai_allowance must be a JSON object of whole amounts >= 0 per currency (e.g. {"USD": 500})',
};

const planAdminSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(100),
  description: z.string().max(5000).nullable().optional(),
  prices: jsonObject.optional(),
  entitlements: jsonObject.optional(),
  limits: jsonObject.optional(),
  is_free: z.boolean().optional(),
  is_active: z.boolean().optional(),
  is_hidden: z.boolean().optional(),
  sort_order: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  trial_days: z.number().int().min(0).max(3650).optional(),
  default_currency: z.string().regex(CURRENCY_KEY).optional(),
  provider_price_ids: jsonObject.optional(),
  localized: jsonObject.optional(),
  locked_data_retention_days: retentionDaysField.optional(),
  ai_allowance: aiAllowanceField.optional(),
});

const planCreateSchema = planAdminSchema.strict();
const planUpdateSchema = planAdminSchema.partial().strict();

export type PlanAdminBody = z.infer<typeof planAdminSchema>;

export type PlanBodyCheck =
  | { ok: true; data: Partial<PlanAdminBody> }
  | {
      ok: false;
      body: {
        /** INVALID_REQUEST / INVALID_PRICE, or phase 4's readable text for one of its fields. */
        error: string;
        code: 'INVALID_REQUEST' | 'INVALID_PRICE';
        /** The phase 4 field the first issue is about, if any. */
        field?: string;
        issues: Array<{ path: string; message: string }>;
      };
    };

const isPriceAmount = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Problems of `prices` for the currencies `edition` sells (every currency when the edition is unknown). */
export function planPriceIssues(prices: Record<string, unknown>, edition: Edition | null): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  for (const [currency, value] of Object.entries(prices)) {
    if (!CURRENCY_KEY.test(currency)) {
      issues.push({ path: `prices.${currency}`, message: 'currency' });
      continue;
    }
    if (edition && !isCurrencyAllowedInEdition(currency, edition)) continue;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push({ path: `prices.${currency}`, message: 'object' });
      continue;
    }
    for (const [interval, amount] of Object.entries(value as Record<string, unknown>)) {
      if (interval !== 'monthly' && interval !== 'yearly') continue;
      if (!isPriceAmount(amount)) issues.push({ path: `prices.${currency}.${interval}`, message: 'price' });
    }
  }
  return issues;
}

/** Validates a POST (`create`) or PUT (`update`) body against the whitelist and the price rules. */
export function checkPlanBody(raw: unknown, mode: 'create' | 'update', edition: Edition | null): PlanBodyCheck {
  const parsed = (mode === 'create' ? planCreateSchema : planUpdateSchema).safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.join('.') || (i.code === 'unrecognized_keys' ? (i as { keys?: string[] }).keys?.join(',') ?? '' : ''),
      message: i.code,
    }));
    const field = parsed.error.issues.map((i) => String(i.path[0] ?? '')).find((k) => k in PLAN_FIELD_ERRORS);
    if (field) return { ok: false, body: { error: PLAN_FIELD_ERRORS[field], code: 'INVALID_REQUEST', field, issues } };
    return { ok: false, body: { error: 'INVALID_REQUEST', code: 'INVALID_REQUEST', issues } };
  }
  if (parsed.data.prices) {
    const issues = planPriceIssues(parsed.data.prices, edition);
    if (issues.length) return { ok: false, body: { error: 'INVALID_PRICE', code: 'INVALID_PRICE', issues } };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Mirrors `ai_allowance.IRR` into `limits.included_ai_allowance_irr`
 * (decision D17). `limits` is the body's when it sent one, else the stored
 * limits (`stored`), so the mirror never drops another limit.
 */
export function withAllowanceMirror(
  body: Partial<PlanAdminBody>,
  stored: Record<string, unknown> | null,
): Partial<PlanAdminBody> {
  const irr = body.ai_allowance?.IRR;
  if (typeof irr !== 'number') return body;
  const limits = { ...(body.limits ?? stored ?? {}) };
  limits.included_ai_allowance_irr = irr;
  return { ...body, limits };
}

/**
 * Phase 4's check of the plan fields it added (locked_data_retention_days,
 * is_hidden, ai_allowance), now answered by the plan schema above so the
 * routes and this helper share one rule. Returns the cleaned values of the
 * fields present in `body`, or phase 4's readable error and the field.
 */
export interface PlanExtras {
  locked_data_retention_days?: number | null;
  is_hidden?: boolean;
  ai_allowance?: Record<string, number>;
}

const planExtrasSchema = planAdminSchema.pick({ locked_data_retention_days: true, is_hidden: true, ai_allowance: true });

export function cleanPlanExtras(body: Record<string, unknown>): { value: PlanExtras; error?: string; field?: string } {
  const picked: Record<string, unknown> = {};
  // A retention key with no value means never, as in phase 4; the others are skipped.
  if ('locked_data_retention_days' in body) picked.locked_data_retention_days = body.locked_data_retention_days ?? null;
  if (body.is_hidden !== undefined) picked.is_hidden = body.is_hidden;
  if (body.ai_allowance !== undefined) picked.ai_allowance = body.ai_allowance;
  const parsed = planExtrasSchema.safeParse(picked);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? '');
    return { value: {}, field, error: PLAN_FIELD_ERRORS[field] ?? 'invalid plan field' };
  }
  return { value: parsed.data };
}

plansRouter.post('/admin', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const edition = await getPlatformEditionOrNull(serverConfigOf(req)).catch(() => null);
  const checked = checkPlanBody(req.body, 'create', edition);
  if (checked.ok === false) return res.status(400).json(checked.body);
  const body = withAllowanceMirror(checked.data, null);
  const { name, slug, description, prices, entitlements, limits, is_free, is_active, is_hidden, sort_order, trial_days, default_currency, provider_price_ids, localized, locked_data_retention_days, ai_allowance } = body;

  // Soft validation: report registry issues but stay backward-compatible.
  const validation = validatePlanPayload({ entitlements, limits });
  if (!validation.valid) {
    return res.status(400).json({ error: 'Plan payload invalid', issues: validation.issues });
  }

  // Plan-data alignment (Phase: Limits Backfill): when creating a NEW plan,
  // ensure resolver-ready limit keys exist. Additive only — never overwrites
  // a value the admin supplied. Legacy/unknown keys pass through untouched.
  const normalizedLimits = normalizePlanLimitsForCreate(limits);

  const { data, error } = await supabase.from('billing_plans').insert({
    name, slug, description: description || null,
    prices: prices || {}, entitlements: entitlements || {}, limits: normalizedLimits,
    is_free: is_free || false, is_active: is_active !== false,
    is_hidden: is_hidden === true,
    sort_order: sort_order || 0, trial_days: trial_days || 0,
    default_currency: default_currency || 'USD',
    provider_price_ids: provider_price_ids || {},
    localized: localized || {},
    locked_data_retention_days: locked_data_retention_days ?? null,
    ai_allowance: ai_allowance || {},
  }).select().single();

  if (error) return res.status(500).json({ error: 'Request failed' });
  clearEntitlementCache();
  res.json({ plan: data, validation });
});

plansRouter.put('/admin/:planId', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const edition = await getPlatformEditionOrNull(serverConfigOf(req)).catch(() => null);
  const checked = checkPlanBody(req.body, 'update', edition);
  if (checked.ok === false) return res.status(400).json(checked.body);

  // Phase 6-S5-R6 — capture the PREVIOUS definition so the fan-out is only
  // queued when an AI-relevant entitlement or limit actually moved.
  const { data: previousPlan } = await supabase
    .from('billing_plans')
    .select('is_active, entitlements, limits')
    .eq('id', req.params.planId)
    .maybeSingle();

  const body = withAllowanceMirror(checked.data, ((previousPlan as { limits?: Record<string, unknown> } | null)?.limits) ?? null);
  const updates = { ...body, updated_at: new Date().toISOString() };

  // Soft validation when the body touches entitlements/limits (the stored
  // limits the allowance mirror carries along are not re-judged).
  let validation: ReturnType<typeof validatePlanPayload> | undefined;
  if (checked.data.entitlements || checked.data.limits) {
    validation = validatePlanPayload({ entitlements: updates.entitlements, limits: updates.limits });
    if (!validation.valid) {
      return res.status(400).json({ error: 'Plan payload invalid', issues: validation.issues });
    }
  }

  const { data, error } = await supabase.from('billing_plans').update(updates).eq('id', req.params.planId).select().single();
  if (error) return res.status(500).json({ error: 'Request failed' });
  // A plan-definition edit changes the effective entitlements of every
  // workspace on that plan. Queue a DURABLE fan-out job. A queueing failure
  // must NOT roll back the billing change, but it must be reported (sanitized).
  const refresh = await handlePlanDefinitionChanged(
    serverConfigOf(req),
    req.params.planId,
    { previous: previousPlan as PlanDefinitionLike | null, next: data as PlanDefinitionLike | null },
  );
  res.json({
    plan: data,
    validation,
    entitlement_refresh: refresh.ok
      ? { ok: true, backgrounded: refresh.backgrounded, skipped: refresh.skipped }
      : { ok: false, error: 'entitlement_catchup_enqueue_failed' },
  });
});

plansRouter.delete('/admin/:planId', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const { data: previousPlan } = await supabase
    .from('billing_plans')
    .select('is_active, entitlements, limits')
    .eq('id', req.params.planId)
    .maybeSingle();
  const { error } = await supabase.from('billing_plans').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', req.params.planId);
  if (error) return res.status(500).json({ error: 'Request failed' });
  // Phase 6-S5-R7 — deactivation is a PURE REVOCATION. It can only remove
  // access, so it clears entitlement caches but must never queue an index
  // fan-out: there is nothing new to index for anyone.
  const refresh = await handlePlanDefinitionChanged(
    serverConfigOf(req),
    req.params.planId,
    {
      previous: (previousPlan as PlanDefinitionLike | null) ?? { is_active: true },
      next: { ...((previousPlan as PlanDefinitionLike | null) ?? {}), is_active: false },
    },
  );
  res.json({
    success: true,
    entitlement_refresh: refresh.ok
      ? { ok: true, backgrounded: refresh.backgrounded }
      : { ok: false, error: 'entitlement_catchup_enqueue_failed' },
  });
});

// ═══════════════════════════════════════════════════════════
// ADMIN: Subscription management
// ═══════════════════════════════════════════════════════════

/**
 * The end of an assignment with no `expiresAt`: one month (or one year) on,
 * at the same time of day; the day overflows the way JavaScript's Date.UTC
 * does (31 Jan + 1 month = 3 Mar), as billing v2's admin grant did.
 */
export function adminAssignmentEnd(start: Date, interval: 'monthly' | 'yearly'): Date {
  return new Date(
    Date.UTC(
      start.getUTCFullYear() + (interval === 'yearly' ? 1 : 0),
      start.getUTCMonth() + (interval === 'yearly' ? 0 : 1),
      start.getUTCDate(),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
    ),
  );
}

const assignSchema = z.object({
  workspaceId: z.string().uuid(),
  planId: z.string().uuid(),
  /** An ISO date; the assignment ends then. Without it: one interval from now. */
  expiresAt: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'expiresAt must be an ISO date')
    .nullish(),
  interval: z.enum(['monthly', 'yearly']).default('monthly'),
  /** Only 'active': a Super Admin assignment is a running period. */
  status: z.string().nullish(),
});

/**
 * POST /api/plans/admin/assign — Super Admin puts a workspace on a plan with
 * no money moving (simple billing, phase 7; billing v2's comped period is
 * gone). Everything goes through the simple billing's own SQL:
 *   1. billing_account_write_subscription: the subscription row (active,
 *      from now to the end) and its plan_change_log row (change
 *      'admin_assign', the admin as actor);
 *   2. billing_account_admin_replaced (afterAdminAssignment): a prepayment of
 *      the replaced period's next period returns to the balance, and a change
 *      the customer had scheduled no longer applies;
 *   3. billing_account_grant_month: the month's AI credit, at once (it is
 *      idempotent per month, so the hourly job does not grant it again);
 *   4. the entitlement-change funnel.
 * All of these exist since migrations 261/264: the route works before and
 * after 267.
 */
plansRouter.post('/admin/assign', async (req, res) => {
  const parsed = assignSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_INPUT', details: parsed.error.flatten().fieldErrors });
  }
  const { workspaceId, planId, expiresAt, interval } = parsed.data;
  if (parsed.data.status != null && parsed.data.status !== 'active') {
    return res.status(400).json({ error: 'INVALID_STATUS', message: 'Only an active assignment is supported' });
  }

  const start = new Date();
  const end = expiresAt ? new Date(expiresAt) : adminAssignmentEnd(start, interval);
  if (!(end.getTime() > start.getTime())) {
    return res.status(400).json({ error: 'INVALID_EXPIRES_AT', message: 'expiresAt must be in the future' });
  }

  const config = serverConfigOf(req);
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const adminId = (req as Request & { adminUserId?: string }).adminUserId ?? null;

  const { data: plan, error: planError } = await supabase
    .from('billing_plans')
    .select('id')
    .eq('id', planId)
    .maybeSingle();
  if (planError) return res.status(500).json({ error: 'Request failed' });
  if (!plan) return res.status(404).json({ error: 'UNKNOWN_PLAN' });

  const { error: writeError } = await supabase.rpc('billing_account_write_subscription', {
    p_workspace_id: workspaceId,
    p_plan_id: planId,
    p_interval: interval,
    p_start: start.toISOString(),
    p_end: end.toISOString(),
    p_status: 'active',
    p_change: 'admin_assign',
    p_actor: adminId,
    p_details: { source: 'admin_assign' },
  });
  if (writeError) {
    console.warn('[plans] admin assign failed:', writeError.message);
    return res.status(500).json({ error: 'Request failed' });
  }

  // The period was replaced: a prepayment for the old one's next period
  // returns, a change the customer scheduled no longer applies.
  await afterAdminAssignment(config, workspaceId);

  // The month's AI credit, granted now rather than at the next hourly tick.
  // `p_at` is the period's own start, so a database clock a moment behind
  // this server's cannot place "now" before the period and skip the grant.
  const { data: granted, error: grantError } = await supabase.rpc('billing_account_grant_month', {
    p_workspace_id: workspaceId,
    p_plan_id: planId,
    p_period_start: start.toISOString(),
    p_period_end: end.toISOString(),
    p_at: start.toISOString(),
  });
  // The plan is assigned either way; the hourly job grants the month later.
  // A month granted nothing (the plan has no AI credit, or a lot of this
  // period already funds it) is said in the log, so a missing credit is seen.
  if (grantError) console.warn('[plans] admin assign: AI credit grant failed:', grantError.message);
  else if (!(Number(granted) > 0)) {
    console.info('[plans] admin assign: no AI credit granted for the month', { workspaceId, planId });
  }

  // Central entitlement-change funnel: clears the cache AND enqueues the
  // deterministic KB catch-up (a plan change may newly grant `ai_assistant`).
  await handleWorkspaceEntitlementChanged(config, {
    workspaceId,
    source: 'admin_assign',
  });

  const { data: subscription } = await supabase
    .from('workspace_subscriptions')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  res.json({ subscription });
});

plansRouter.post('/admin/revoke', async (req, res) => {
  const { url, key } = getConfig(req);
  const { workspaceId } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });

  const supabase = serviceClientFor(url, key);

  // Log revocation
  const { data: oldSub } = await supabase
    .from('workspace_subscriptions')
    .select('plan_id')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (oldSub) {
    await insertPlanChangeLog(req, supabase, {
      workspace_id: workspaceId,
      old_plan_id: oldSub.plan_id,
      new_plan_id: null,
      change_type: 'revoke',
      metadata: { source: 'admin_revoke' },
    });
  }

  const { error } = await supabase.from('workspace_subscriptions').delete().eq('workspace_id', workspaceId);
  if (error) return res.status(500).json({ error: 'Request failed' });
  await afterAdminAssignment(serverConfigOf(req), workspaceId);
  await handleWorkspaceEntitlementChanged(serverConfigOf(req), {
    workspaceId,
    source: 'admin_revoke',
  });
  res.json({ success: true });
});

plansRouter.get('/admin/subscriptions', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const { data, error } = await supabase
    .from('workspace_subscriptions')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Request failed' });

  type SubscriptionListRow = { plan_id?: string | null } & Record<string, unknown>;
  const rows = (data || []) as SubscriptionListRow[];
  const planIds = [...new Set(rows.map((sub) => sub.plan_id).filter((id): id is string => !!id))];
  const { data: plans, error: plansError } = planIds.length
    ? await supabase.from('billing_plans').select('id, name, slug').in('id', planIds)
    : { data: [], error: null };
  if (plansError) return res.status(500).json({ error: 'Request failed' });

  const plansById = new Map(((plans || []) as Array<{ id: string; name: string; slug: string }>).map((plan) => [plan.id, plan]));
  res.json({
    subscriptions: rows.map((sub) => ({
      ...sub,
      billing_plans: (sub.plan_id && plansById.get(sub.plan_id)) || null,
    })),
  });
});

// ═══════════════════════════════════════════════════════════
// ADMIN: Module & Channel Overrides
// ═══════════════════════════════════════════════════════════

plansRouter.get('/admin/overrides/:workspaceId', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const { workspaceId } = req.params;

  const [{ data: modules }, { data: channels }, { data: limits }] = await Promise.all([
    supabase.from('workspace_module_overrides').select('*').eq('workspace_id', workspaceId),
    supabase.from('workspace_channel_overrides').select('*').eq('workspace_id', workspaceId),
    supabase.from('workspace_limit_overrides').select('*').eq('workspace_id', workspaceId),
  ]);

  res.json({ modules: modules || [], channels: channels || [], limits: limits || [] });
});

plansRouter.post('/admin/overrides/module', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const { workspaceId, moduleKey, enabled, adminNotes } = req.body;

  const { data, error } = await supabase
    .from('workspace_module_overrides')
    .upsert({
      workspace_id: workspaceId,
      module_key: moduleKey,
      enabled: enabled,
      admin_notes: adminNotes || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,module_key' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Request failed' });
  await handleWorkspaceEntitlementChanged(serverConfigOf(req), {
    workspaceId,
    source: 'workspace_module_override',
  });
  res.json({ override: data });
});

plansRouter.post('/admin/overrides/channel', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const { workspaceId, channelKey, enabled, adminNotes } = req.body;

  const { data, error } = await supabase
    .from('workspace_channel_overrides')
    .upsert({
      workspace_id: workspaceId,
      channel_key: channelKey,
      enabled: enabled,
      admin_notes: adminNotes || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,channel_key' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Request failed' });
  await handleWorkspaceEntitlementChanged(serverConfigOf(req), {
    workspaceId,
    source: 'workspace_channel_override',
  });
  res.json({ override: data });
});

plansRouter.delete('/admin/overrides/module/:id', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  // Read first: removing a NEGATIVE `ai_assistant` override can re-enable AI,
  // which requires a workspace-scoped catch-up, not a blind cache clear.
  const { data: existing } = await supabase
    .from('workspace_module_overrides')
    .select('workspace_id, module_key, enabled')
    .eq('id', req.params.id)
    .maybeSingle();
  const { error } = await supabase.from('workspace_module_overrides').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Request failed' });
  if (!existing) {
    // Canonical response for missing OR already-removed — no existence leak.
    clearEntitlementCache();
    return res.json({ success: true });
  }
  await handleWorkspaceEntitlementChanged(serverConfigOf(req), {
    workspaceId: (existing as { workspace_id: string }).workspace_id,
    source: 'workspace_module_override',
  });
  res.json({ success: true });
});

plansRouter.delete('/admin/overrides/channel/:id', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const { data: existing } = await supabase
    .from('workspace_channel_overrides')
    .select('workspace_id, channel_key')
    .eq('id', req.params.id)
    .maybeSingle();
  const { error } = await supabase.from('workspace_channel_overrides').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Request failed' });
  if (existing) {
    // Channel changes never affect AI indexing eligibility: the funnel clears
    // the cache and the transition rule suppresses the catch-up.
    await handleWorkspaceEntitlementChanged(serverConfigOf(req), {
      workspaceId: (existing as { workspace_id: string }).workspace_id,
      source: 'workspace_channel_override',
    });
  } else {
    clearEntitlementCache();
  }
  res.json({ success: true });
});

// ─── Limit overrides (usage-backed numeric limits) ────────────────────
plansRouter.post('/admin/overrides/limit', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const { workspaceId, limitKey, limitValue, adminNotes } = req.body || {};

  if (!workspaceId || !limitKey || typeof limitValue !== 'number' || !Number.isFinite(limitValue) || !Number.isInteger(limitValue)) {
    return res.status(400).json({ error: 'workspaceId, limitKey and integer limitValue are required' });
  }

  // Guardrail: only allow keys that are actually limits in the registry.
  const cap = CAPABILITY_REGISTRY.find((c) => c.key === limitKey && c.type === 'limit');
  if (!cap) return res.status(400).json({ error: `Unknown limit key: ${limitKey}` });
  if (cap.workspaceOverridable === false) {
    return res.status(400).json({ error: `Limit '${limitKey}' is not workspace-overridable` });
  }
  // -1 means unlimited; otherwise must be >= 0.
  if (limitValue < -1) return res.status(400).json({ error: 'limitValue must be -1 (unlimited) or >= 0' });

  const { data, error } = await supabase
    .from('workspace_limit_overrides')
    .upsert({
      workspace_id: workspaceId,
      limit_key: limitKey,
      limit_value: limitValue,
      admin_notes: adminNotes || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,limit_key' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Request failed' });
  await handleWorkspaceEntitlementChanged(serverConfigOf(req), {
    workspaceId,
    source: 'workspace_limit_override',
    limitKey,
  });
  res.json({ override: data });
});

plansRouter.delete('/admin/overrides/limit/:id', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const { data: existing } = await supabase
    .from('workspace_limit_overrides')
    .select('workspace_id, limit_key')
    .eq('id', req.params.id)
    .maybeSingle();
  const { error } = await supabase.from('workspace_limit_overrides').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Request failed' });
  if (existing) {
    const row = existing as { workspace_id: string; limit_key: string };
    await handleWorkspaceEntitlementChanged(serverConfigOf(req), {
      workspaceId: row.workspace_id,
      source: 'workspace_limit_override',
      limitKey: row.limit_key,
    });
  } else {
    clearEntitlementCache();
  }
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// ADMIN: Usage management
// ═══════════════════════════════════════════════════════════

plansRouter.get('/admin/usage/:workspaceId', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const { data, error } = await supabase
    .from('workspace_usage_counters')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .order('period', { ascending: false })
    .limit(12);
  if (error) return res.status(500).json({ error: 'Request failed' });
  res.json({ usage: data || [] });
});

plansRouter.post('/admin/usage/adjust', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const { workspaceId, counter, value, period } = req.body;
  const currentPeriod = period || new Date().toISOString().slice(0, 7);

  // Ensure row exists
  await supabase.from('workspace_usage_counters')
    .upsert({ workspace_id: workspaceId, period: currentPeriod }, { onConflict: 'workspace_id,period' });

  const { error } = await supabase
    .from('workspace_usage_counters')
    .update({ [counter]: value, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('period', currentPeriod);

  if (error) return res.status(500).json({ error: 'Request failed' });
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// ADMIN: Plan change history
// ═══════════════════════════════════════════════════════════

plansRouter.get('/admin/changes/:workspaceId', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const { data, error } = await supabase
    .from('plan_change_log')
    .select('*, old_plan:billing_plans!plan_change_log_old_plan_id_fkey(name, slug), new_plan:billing_plans!plan_change_log_new_plan_id_fkey(name, slug)')
    .eq('workspace_id', req.params.workspaceId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: 'Request failed' });
  res.json({ changes: data || [] });
});

// ─────────────────────────────────────────────────────────────
// ADMIN: Validate a plan payload without persisting
// ─────────────────────────────────────────────────────────────
plansRouter.post('/admin/validate', (req, res) => {
  const { entitlements, limits } = req.body || {};
  const result = validatePlanPayload({ entitlements, limits });
  res.json(result);
});

// ─────────────────────────────────────────────────────────────
// ADMIN: Diagnostics — registry vs DB drift
// ─────────────────────────────────────────────────────────────
plansRouter.get('/admin/diagnostics', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = serviceClientFor(url, key);
  const { data, error } = await supabase
    .from('billing_plans')
    .select('id, slug, entitlements, limits')
    .eq('is_active', true);
  if (error) return res.status(500).json({ error: 'Request failed' });
  const activePlans = (data || []) as Parameters<typeof diagnoseAgainstPlans>[0];
  const report = diagnoseAgainstPlans(activePlans);

  // Phase: Limits Backfill — surface plans that are missing resolver-ready
  // limit keys, so operators can see drift before it blocks Phase 3.
  const usageBackedKeysMissingByPlan = activePlans.map((p) => {
    const lim = (p.limits || {}) as Record<string, unknown>;
    const missing = USAGE_BACKED_LIMIT_KEYS.filter(
      (k) => !Object.prototype.hasOwnProperty.call(lim, k),
    );
    return { planSlug: p.slug, missing };
  }).filter((r) => r.missing.length > 0);

  res.json({
    registrySize: CAPABILITY_REGISTRY.length,
    plansChecked: (data || []).length,
    usageBackedLimitKeys: USAGE_BACKED_LIMIT_KEYS,
    usageBackedKeysMissingByPlan,
    ...report,
  });
});
