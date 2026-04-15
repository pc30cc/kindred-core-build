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

export const plansRouter = Router();

function getConfig(req: any) {
  const c = req.serverConfig;
  return { url: c.supabaseUrl, key: c.supabaseServiceRoleKey };
}

// ═══════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════

// GET /api/plans — list active plans
plansRouter.get('/', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from('billing_plans')
    .select('*')
    .eq('is_active', true)
    .order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ plans: data || [] });
});

// GET /api/plans/check — check single entitlement
plansRouter.get('/check', async (req, res) => {
  const { url, key } = getConfig(req);
  const workspaceId = req.query.workspaceId as string;
  const feature = req.query.feature as string;
  if (!workspaceId || !feature) return res.status(400).json({ error: 'Missing workspaceId or feature' });
  try {
    const result = await checkEntitlementFromDB(url, key, workspaceId, feature);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// WORKSPACE ROUTES
// ═══════════════════════════════════════════════════════════

// GET /api/plans/workspace/:workspaceId — full plan + usage
plansRouter.get('/workspace/:workspaceId', async (req, res) => {
  const { url, key } = getConfig(req);
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
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/plans/workspace/:workspaceId/modules — all module access states
plansRouter.get('/workspace/:workspaceId/modules', async (req, res) => {
  const { url, key } = getConfig(req);
  const { workspaceId } = req.params;
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
  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from('workspace_usage_counters')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .order('period', { ascending: false })
    .limit(12);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ usage: data || [] });
});

// ═══════════════════════════════════════════════════════════
// ADMIN: Plan CRUD
// ═══════════════════════════════════════════════════════════

plansRouter.get('/admin/all', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { data, error } = await supabase.from('billing_plans').select('*').order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ plans: data || [] });
});

plansRouter.post('/admin', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { name, slug, description, prices, entitlements, limits, is_free, is_active, sort_order, trial_days, default_currency, provider_price_ids, localized } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });

  const { data, error } = await supabase.from('billing_plans').insert({
    name, slug, description: description || null,
    prices: prices || {}, entitlements: entitlements || {}, limits: limits || {},
    is_free: is_free || false, is_active: is_active !== false,
    sort_order: sort_order || 0, trial_days: trial_days || 0,
    default_currency: default_currency || 'USD',
    provider_price_ids: provider_price_ids || {},
    localized: localized || {},
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  clearEntitlementCache();
  res.json({ plan: data });
});

plansRouter.put('/admin/:planId', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id; delete updates.created_at;

  const { data, error } = await supabase.from('billing_plans').update(updates).eq('id', req.params.planId).select().single();
  if (error) return res.status(500).json({ error: error.message });
  clearEntitlementCache();
  res.json({ plan: data });
});

plansRouter.delete('/admin/:planId', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { error } = await supabase.from('billing_plans').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', req.params.planId);
  if (error) return res.status(500).json({ error: error.message });
  clearEntitlementCache();
  res.json({ success: true });
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

  if (error) return res.status(500).json({ error: error.message });

  // Log plan change
  await supabase.from('plan_change_log').insert({
    workspace_id: workspaceId,
    old_plan_id: oldSub?.plan_id || null,
    new_plan_id: planId,
    change_type: oldSub ? 'change' : 'initial',
    metadata: { source: 'admin_assign' },
  });

  clearEntitlementCache(workspaceId);
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
  if (error) return res.status(500).json({ error: error.message });
  clearEntitlementCache(workspaceId);
  res.json({ success: true });
});

plansRouter.get('/admin/subscriptions', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from('workspace_subscriptions')
    .select('*, billing_plans(name, slug)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ subscriptions: data || [] });
});

// ═══════════════════════════════════════════════════════════
// ADMIN: Module & Channel Overrides
// ═══════════════════════════════════════════════════════════

plansRouter.get('/admin/overrides/:workspaceId', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { workspaceId } = req.params;

  const [{ data: modules }, { data: channels }] = await Promise.all([
    supabase.from('workspace_module_overrides').select('*').eq('workspace_id', workspaceId),
    supabase.from('workspace_channel_overrides').select('*').eq('workspace_id', workspaceId),
  ]);

  res.json({ modules: modules || [], channels: channels || [] });
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

  if (error) return res.status(500).json({ error: error.message });
  clearEntitlementCache(workspaceId);
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

  if (error) return res.status(500).json({ error: error.message });
  clearEntitlementCache(workspaceId);
  res.json({ override: data });
});

plansRouter.delete('/admin/overrides/module/:id', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { error } = await supabase.from('workspace_module_overrides').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  clearEntitlementCache();
  res.json({ success: true });
});

plansRouter.delete('/admin/overrides/channel/:id', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { error } = await supabase.from('workspace_channel_overrides').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  clearEntitlementCache();
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
  if (error) return res.status(500).json({ error: error.message });
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

  if (error) return res.status(500).json({ error: error.message });
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
  if (error) return res.status(500).json({ error: error.message });
  res.json({ changes: data || [] });
});
