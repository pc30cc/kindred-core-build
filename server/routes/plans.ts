/**
 * Plans & Feature Gating API Routes
 * Full plan info, usage data, module/channel status, upgrade/downgrade.
 */

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  getWorkspacePlanInfo,
  clearEntitlementCache,
  checkEntitlementFromDB,
  checkModuleAccess,
  checkChannelAccess,
} from '../middleware/featureGating.js';
import {
  CAPABILITY_REGISTRY,
  listCapabilities,
  validatePlanPayload,
  diagnoseAgainstPlans,
  normalizePlanLimitsForCreate,
  USAGE_BACKED_LIMIT_KEYS,
} from '../services/billing/capabilityRegistry.js';
import { authorizeWorkspaceAccess, requirePlatformAdmin } from '../lib/workspaceAuth.js';
import {
  handleWorkspaceEntitlementChanged,
  handlePlanDefinitionChanged,
} from '../services/billing/entitlementChange.js';

export const plansRouter = Router();

function getConfig(req: any) {
  const c = req.serverConfig;
  return { url: c.supabaseUrl, key: c.supabaseServiceRoleKey };
}

/**
 * Every `/admin/*` route below is Platform Super Admin only. The gate runs as
 * router-level middleware so no handler can perform a service-role query or
 * mutation before authorization.
 */
plansRouter.use('/admin', async (req, res, next) => {
  if (!(await requirePlatformAdmin(req, res))) return;
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
  const supabase = createClient(url, key);
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
plansRouter.get('/capabilities', (req, res) => {
  const { type, group } = req.query as { type?: string; group?: string };
  const filter: { type?: any; group?: string } = {};
  if (type === 'feature' || type === 'module' || type === 'channel' || type === 'limit') filter.type = type;
  if (typeof group === 'string' && group) filter.group = group;
  res.json({
    capabilities: listCapabilities(filter),
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
// EFFECTIVE WORKSPACE ENTITLEMENTS (registry-aware aggregation)
// Aggregates plan + overrides + usage into a single payload that
// the app/admin UI can render without re-implementing the rules.
// Backend stays the authority — this is a read-only convenience.
// ─────────────────────────────────────────────────────────────
plansRouter.get('/workspace/:workspaceId/effective', async (req, res) => {
  const { url, key } = getConfig(req);
  const { workspaceId } = req.params;
  if (!(await authorizeWorkspaceAccess(req, res, workspaceId))) return;
  const supabase = createClient(url, key);
  try {
    const info = await getWorkspacePlanInfo(url, key, workspaceId);

    // Pull overrides + current-period usage in parallel.
    const currentPeriod = new Date().toISOString().slice(0, 7);
    const [{ data: moduleOverrides }, { data: channelOverrides }, { data: limitOverrides }, { data: usage }] = await Promise.all([
      supabase.from('workspace_module_overrides').select('*').eq('workspace_id', workspaceId),
      supabase.from('workspace_channel_overrides').select('*').eq('workspace_id', workspaceId),
      supabase.from('workspace_limit_overrides').select('*').eq('workspace_id', workspaceId),
      supabase.from('workspace_usage_counters').select('*').eq('workspace_id', workspaceId).eq('period', currentPeriod).maybeSingle(),
    ]);

    const moduleOverrideMap = new Map<string, { enabled: boolean; admin_notes?: string | null }>(
      (moduleOverrides || []).map((o: any) => [o.module_key, { enabled: o.enabled, admin_notes: o.admin_notes }]),
    );
    const channelOverrideMap = new Map<string, { enabled: boolean; admin_notes?: string | null }>(
      (channelOverrides || []).map((o: any) => [o.channel_key, { enabled: o.enabled, admin_notes: o.admin_notes }]),
    );
    const limitOverrideMap = new Map<string, { value: number; admin_notes?: string | null }>(
      (limitOverrides || []).map((o: any) => [o.limit_key, { value: o.limit_value, admin_notes: o.admin_notes }]),
    );

    const planEntitlements = info.entitlements || {};
    const planLimits = info.limits || {};

    type State = { value: boolean | number | null; source: 'override' | 'plan' | 'default'; note?: string | null };
    const features: Record<string, State> = {};
    const modules: Record<string, State> = {};
    const channels: Record<string, State> = {};
    const limits: Record<string, State & { unit?: string }> = {};

    for (const cap of CAPABILITY_REGISTRY) {
      if (cap.type === 'feature') {
        if (cap.key in planEntitlements) features[cap.key] = { value: !!planEntitlements[cap.key], source: 'plan' };
        else features[cap.key] = { value: !!cap.defaultValue, source: 'default' };
      } else if (cap.type === 'module') {
        const ov = moduleOverrideMap.get(cap.key);
        if (ov) modules[cap.key] = { value: !!ov.enabled, source: 'override', note: ov.admin_notes ?? null };
        else if (cap.key in planEntitlements) modules[cap.key] = { value: !!planEntitlements[cap.key], source: 'plan' };
        else modules[cap.key] = { value: !!cap.defaultValue, source: 'default' };
      } else if (cap.type === 'channel') {
        const ov = channelOverrideMap.get(cap.key);
        if (ov) channels[cap.key] = { value: !!ov.enabled, source: 'override', note: ov.admin_notes ?? null };
        else if (cap.key in planEntitlements) channels[cap.key] = { value: !!planEntitlements[cap.key], source: 'plan' };
        else channels[cap.key] = { value: !!cap.defaultValue, source: 'default' };
      } else if (cap.type === 'limit') {
        const ov = limitOverrideMap.get(cap.key);
        if (ov) limits[cap.key] = { value: ov.value, source: 'override', unit: cap.unit, note: ov.admin_notes ?? null };
        else if (cap.key in planLimits) limits[cap.key] = { value: planLimits[cap.key] as number, source: 'plan', unit: cap.unit };
        else limits[cap.key] = { value: cap.defaultValue as number | null, source: 'default', unit: cap.unit };
      }
    }

    res.json({
      workspaceId,
      plan: info.plan,
      subscription: info.subscription,
      features,
      modules,
      channels,
      limits,
      usage: usage || null,
      // Raw plan JSON for debugging / forward-compat consumers.
      raw: { entitlements: planEntitlements, limits: planLimits },
    });
  } catch {
    res.status(500).json({ error: 'Failed to resolve entitlements' });
  }
});

// ═══════════════════════════════════════════════════════════
// WORKSPACE ROUTES
// ═══════════════════════════════════════════════════════════

// GET /api/plans/workspace/:workspaceId — full plan + usage
plansRouter.get('/workspace/:workspaceId', async (req, res) => {
  const { url, key } = getConfig(req);
  if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId))) return;
  try {
    const info = await getWorkspacePlanInfo(url, key, req.params.workspaceId);

    const supabase = createClient(url, key);
    const currentPeriod = new Date().toISOString().slice(0, 7);
    const { data: usage } = await supabase
      .from('workspace_usage_counters')
      .select('*')
      .eq('workspace_id', req.params.workspaceId)
      .eq('period', currentPeriod)
      .maybeSingle();

    res.json({ ...info, usage: usage || null });
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
  await Promise.all(modules.map(async (m) => {
    const r = await checkModuleAccess(url, key, workspaceId, m);
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
  await Promise.all(channels.map(async (c) => {
    const r = await checkChannelAccess(url, key, workspaceId, c);
    results[c] = { allowed: r.allowed, source: r.reason };
  }));
  res.json({ channels: results });
});

// GET /api/plans/workspace/:workspaceId/usage — usage history
plansRouter.get('/workspace/:workspaceId/usage', async (req, res) => {
  const { url, key } = getConfig(req);
  if (!(await authorizeWorkspaceAccess(req, res, req.params.workspaceId))) return;
  const supabase = createClient(url, key);
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
  const supabase = createClient(url, key);
  const { data, error } = await supabase.from('billing_plans').select('*').order('sort_order');
  if (error) return res.status(500).json({ error: 'Request failed' });
  res.json({ plans: data || [] });
});

plansRouter.post('/admin', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { name, slug, description, prices, entitlements, limits, is_free, is_active, sort_order, trial_days, default_currency, provider_price_ids, localized } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });

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
    sort_order: sort_order || 0, trial_days: trial_days || 0,
    default_currency: default_currency || 'USD',
    provider_price_ids: provider_price_ids || {},
    localized: localized || {},
  }).select().single();

  if (error) return res.status(500).json({ error: 'Request failed' });
  clearEntitlementCache();
  res.json({ plan: data, validation });
});

plansRouter.put('/admin/:planId', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id; delete updates.created_at;

  // Soft validation when entitlements/limits are touched.
  let validation: ReturnType<typeof validatePlanPayload> | undefined;
  if (updates.entitlements || updates.limits) {
    validation = validatePlanPayload({ entitlements: updates.entitlements, limits: updates.limits });
    if (!validation.valid) {
      return res.status(400).json({ error: 'Plan payload invalid', issues: validation.issues });
    }
  }

  // Phase 6-S5-R6 — capture the PREVIOUS definition so the fan-out is only
  // queued when an AI-relevant entitlement or limit actually moved.
  const { data: previousPlan } = await supabase
    .from('billing_plans')
    .select('is_active, entitlements, limits')
    .eq('id', req.params.planId)
    .maybeSingle();

  const { data, error } = await supabase.from('billing_plans').update(updates).eq('id', req.params.planId).select().single();
  if (error) return res.status(500).json({ error: 'Request failed' });
  // A plan-definition edit changes the effective entitlements of every
  // workspace on that plan. Queue a DURABLE fan-out job. A queueing failure
  // must NOT roll back the billing change, but it must be reported (sanitized).
  const refresh = await handlePlanDefinitionChanged(
    (req as any).serverConfig,
    req.params.planId,
    { previous: previousPlan as any, next: data as any },
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
  const supabase = createClient(url, key);
  const { error } = await supabase.from('billing_plans').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', req.params.planId);
  if (error) return res.status(500).json({ error: 'Request failed' });
  // Deactivation always changes effective access for every subscriber.
  const refresh = await handlePlanDefinitionChanged((req as any).serverConfig, req.params.planId);
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

plansRouter.post('/admin/assign', async (req, res) => {
  const { url, key } = getConfig(req);
  const { workspaceId, planId, status, expiresAt } = req.body;
  if (!workspaceId || !planId) return res.status(400).json({ error: 'Missing workspaceId or planId' });

  const supabase = createClient(url, key);

  // Get old plan for change log
  const { data: oldSub } = await supabase
    .from('workspace_subscriptions')
    .select('plan_id')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  const { data, error } = await supabase.from('workspace_subscriptions').upsert({
    workspace_id: workspaceId, plan_id: planId, provider_name: 'manual',
    status: status || 'active',
    current_period_start: new Date().toISOString(),
    current_period_end: expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id' }).select().single();

  if (error) return res.status(500).json({ error: 'Request failed' });

  // Log plan change
  await supabase.from('plan_change_log').insert({
    workspace_id: workspaceId,
    old_plan_id: oldSub?.plan_id || null,
    new_plan_id: planId,
    change_type: oldSub ? 'change' : 'initial',
    metadata: { source: 'admin_assign' },
  });

  // Central entitlement-change funnel: clears the cache AND enqueues the
  // deterministic KB catch-up (a plan change may newly grant `ai_assistant`).
  await handleWorkspaceEntitlementChanged((req as any).serverConfig, {
    workspaceId,
    source: 'admin_assign',
  });
  res.json({ subscription: data });
});

plansRouter.post('/admin/revoke', async (req, res) => {
  const { url, key } = getConfig(req);
  const { workspaceId } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });

  const supabase = createClient(url, key);

  // Log revocation
  const { data: oldSub } = await supabase
    .from('workspace_subscriptions')
    .select('plan_id')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (oldSub) {
    await supabase.from('plan_change_log').insert({
      workspace_id: workspaceId,
      old_plan_id: oldSub.plan_id,
      new_plan_id: null,
      change_type: 'revoke',
      metadata: { source: 'admin_revoke' },
    });
  }

  const { error } = await supabase.from('workspace_subscriptions').delete().eq('workspace_id', workspaceId);
  if (error) return res.status(500).json({ error: 'Request failed' });
  await handleWorkspaceEntitlementChanged((req as any).serverConfig, {
    workspaceId,
    source: 'admin_revoke',
  });
  res.json({ success: true });
});

plansRouter.get('/admin/subscriptions', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from('workspace_subscriptions')
    .select('*, billing_plans(name, slug)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Request failed' });
  res.json({ subscriptions: data || [] });
});

// ═══════════════════════════════════════════════════════════
// ADMIN: Module & Channel Overrides
// ═══════════════════════════════════════════════════════════

plansRouter.get('/admin/overrides/:workspaceId', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
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
  const supabase = createClient(url, key);
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
  await handleWorkspaceEntitlementChanged((req as any).serverConfig, {
    workspaceId,
    source: 'workspace_module_override',
  });
  res.json({ override: data });
});

plansRouter.post('/admin/overrides/channel', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
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
  await handleWorkspaceEntitlementChanged((req as any).serverConfig, {
    workspaceId,
    source: 'workspace_channel_override',
  });
  res.json({ override: data });
});

plansRouter.delete('/admin/overrides/module/:id', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
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
  await handleWorkspaceEntitlementChanged((req as any).serverConfig, {
    workspaceId: (existing as { workspace_id: string }).workspace_id,
    source: 'workspace_module_override',
  });
  res.json({ success: true });
});

plansRouter.delete('/admin/overrides/channel/:id', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
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
    await handleWorkspaceEntitlementChanged((req as any).serverConfig, {
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
  const supabase = createClient(url, key);
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
  await handleWorkspaceEntitlementChanged((req as any).serverConfig, {
    workspaceId,
    source: 'workspace_limit_override',
    limitKey,
  });
  res.json({ override: data });
});

plansRouter.delete('/admin/overrides/limit/:id', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { data: existing } = await supabase
    .from('workspace_limit_overrides')
    .select('workspace_id, limit_key')
    .eq('id', req.params.id)
    .maybeSingle();
  const { error } = await supabase.from('workspace_limit_overrides').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Request failed' });
  if (existing) {
    const row = existing as { workspace_id: string; limit_key: string };
    await handleWorkspaceEntitlementChanged((req as any).serverConfig, {
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
  const supabase = createClient(url, key);
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
  const supabase = createClient(url, key);
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
  const supabase = createClient(url, key);
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
  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from('billing_plans')
    .select('id, slug, entitlements, limits')
    .eq('is_active', true);
  if (error) return res.status(500).json({ error: 'Request failed' });
  const report = diagnoseAgainstPlans((data || []) as any);

  // Phase: Limits Backfill — surface plans that are missing resolver-ready
  // limit keys, so operators can see drift before it blocks Phase 3.
  const usageBackedKeysMissingByPlan = (data || []).map((p: any) => {
    const lim = (p.limits || {}) as Record<string, unknown>;
    const missing = USAGE_BACKED_LIMIT_KEYS.filter(
      (k) => !Object.prototype.hasOwnProperty.call(lim, k),
    );
    return { planSlug: p.slug, missing };
  }).filter((r: any) => r.missing.length > 0);

  res.json({
    registrySize: CAPABILITY_REGISTRY.length,
    plansChecked: (data || []).length,
    usageBackedLimitKeys: USAGE_BACKED_LIMIT_KEYS,
    usageBackedKeysMissingByPlan,
    ...report,
  });
});
