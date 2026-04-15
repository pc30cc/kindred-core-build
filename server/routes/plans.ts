// ============================================
// PLAN & FEATURE GATING ROUTES
// ============================================

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { getWorkspacePlanInfo, clearEntitlementCache, checkEntitlementFromDB } from '../middleware/featureGating.js';

export const plansRouter = Router();

function getConfig(req: any) {
  const c = req.serverConfig;
  return { url: c.supabaseUrl, key: c.supabaseServiceRoleKey };
}

// ─── GET /api/plans — list all active plans (public) ───
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

// ─── GET /api/plans/workspace/:workspaceId — get workspace plan info ───
plansRouter.get('/workspace/:workspaceId', async (req, res) => {
  const { url, key } = getConfig(req);
  try {
    const info = await getWorkspacePlanInfo(url, key, req.params.workspaceId);
    res.json(info);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/plans/check — check single entitlement ───
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

// ─── ADMIN: Full plan CRUD ───

// GET /api/plans/admin/all — all plans including inactive
plansRouter.get('/admin/all', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from('billing_plans')
    .select('*')
    .order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ plans: data || [] });
});

// POST /api/plans/admin — create plan
plansRouter.post('/admin', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { name, slug, description, prices, entitlements, limits, is_free, is_active, sort_order, trial_days, default_currency, provider_price_ids } = req.body;

  if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });

  const { data, error } = await supabase.from('billing_plans').insert({
    name,
    slug,
    description: description || null,
    prices: prices || {},
    entitlements: entitlements || {},
    limits: limits || {},
    is_free: is_free || false,
    is_active: is_active !== false,
    sort_order: sort_order || 0,
    trial_days: trial_days || 0,
    default_currency: default_currency || 'USD',
    provider_price_ids: provider_price_ids || {},
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  clearEntitlementCache();
  res.json({ plan: data });
});

// PUT /api/plans/admin/:planId — update plan
plansRouter.put('/admin/:planId', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id;
  delete updates.created_at;

  const { data, error } = await supabase
    .from('billing_plans')
    .update(updates)
    .eq('id', req.params.planId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  clearEntitlementCache();
  res.json({ plan: data });
});

// DELETE /api/plans/admin/:planId — soft delete (deactivate)
plansRouter.delete('/admin/:planId', async (req, res) => {
  const { url, key } = getConfig(req);
  const supabase = createClient(url, key);
  const { error } = await supabase
    .from('billing_plans')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.planId);

  if (error) return res.status(500).json({ error: error.message });
  clearEntitlementCache();
  res.json({ success: true });
});

// ─── ADMIN: Workspace plan assignment ───

// POST /api/plans/admin/assign — assign plan to workspace
plansRouter.post('/admin/assign', async (req, res) => {
  const { url, key } = getConfig(req);
  const { workspaceId, planId, status, expiresAt } = req.body;
  if (!workspaceId || !planId) return res.status(400).json({ error: 'Missing workspaceId or planId' });

  const supabase = createClient(url, key);
  const { data, error } = await supabase.from('workspace_subscriptions').upsert({
    workspace_id: workspaceId,
    plan_id: planId,
    provider_name: 'manual',
    status: status || 'active',
    current_period_start: new Date().toISOString(),
    current_period_end: expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id' }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  clearEntitlementCache(workspaceId);
  res.json({ subscription: data });
});

// POST /api/plans/admin/revoke — remove workspace subscription
plansRouter.post('/admin/revoke', async (req, res) => {
  const { url, key } = getConfig(req);
  const { workspaceId } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });

  const supabase = createClient(url, key);
  const { error } = await supabase
    .from('workspace_subscriptions')
    .delete()
    .eq('workspace_id', workspaceId);

  if (error) return res.status(500).json({ error: error.message });
  clearEntitlementCache(workspaceId);
  res.json({ success: true });
});

// GET /api/plans/admin/subscriptions — all subscriptions
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
