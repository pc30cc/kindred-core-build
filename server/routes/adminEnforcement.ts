/**
 * Phase 7.5 — Admin enforcement API.
 * Mounted under /api/admin/enforcement (admin-auth applied by adminRouter).
 *
 * Endpoints (all admin-only):
 *   GET  /rules                          → list enforcement_rules
 *   PATCH /rules/:id                     → tune cooldown/ttl/enabled (builtin shape protected by trigger)
 *   GET  /breaches?state=&limit=         → slo_breach_events
 *   GET  /actions?limit=&dry_run=        → enforcement_actions audit
 *   GET  /active                         → active enforcement-driven auto_action_events
 *   GET  /flags                          → kill switch + dry-run + max_concurrent
 *   POST /flags                          → update flags
 *   POST /evaluate                       → run SLO + enforcement cycle now
 *   POST /actions/:eventId/override      → end an active enforcement action
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { runSloEvaluation } from '../services/observability/sloEvaluator.js';
import { runEnforcementCycle } from '../services/observability/enforcementEngine.js';
import { overrideActiveAction } from '../services/observability/autoActions.js';

export const adminEnforcementRouter = Router();

adminEnforcementRouter.get('/rules', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('enforcement_rules')
      .select('*')
      .order('slug', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rules: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load rules' });
  }
});

const RulePatch = z.object({
  enabled: z.boolean().optional(),
  cooldown_seconds: z.number().int().min(60).max(86_400).optional(),
  ttl_seconds: z.number().int().min(60).max(86_400).optional(),
});

adminEnforcementRouter.patch('/rules/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const parsed = RulePatch.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('enforcement_rules')
      .update(parsed.data)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Rule not found' });
    res.json({ rule: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update rule' });
  }
});

adminEnforcementRouter.get('/breaches', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1),
      200,
    );
    const state = req.query.state ? String(req.query.state) : null;
    let q = sb
      .from('slo_breach_events')
      .select('*')
      .order('last_breach_at', { ascending: false })
      .limit(limit);
    if (state && ['open', 'resolved'].includes(state)) {
      q = q.eq('state', state);
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ breaches: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load breaches' });
  }
});

adminEnforcementRouter.get('/actions', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1),
      200,
    );
    const { data, error } = await sb
      .from('enforcement_actions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ actions: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load actions' });
  }
});

adminEnforcementRouter.get('/active', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('auto_action_events')
      .select('id, action_slug, action_type, trigger_rule_slug, started_at, expires_at, details, state')
      .eq('state', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('started_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ active: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load active actions' });
  }
});

adminEnforcementRouter.get('/flags', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('app_runtime_config')
      .select('key, value')
      .in('key', [
        'enforcement_kill_switch',
        'enforcement_dry_run',
        'enforcement_max_concurrent',
      ]);
    let kill_switch = false;
    let dry_run = false;
    let max_concurrent = 5;
    for (const row of (data || []) as any[]) {
      if (row.key === 'enforcement_kill_switch') kill_switch = !!row.value?.enabled;
      else if (row.key === 'enforcement_dry_run') dry_run = !!row.value?.enabled;
      else if (row.key === 'enforcement_max_concurrent') {
        const v = Number(row.value?.value);
        if (Number.isFinite(v)) max_concurrent = v;
      }
    }
    res.json({ flags: { kill_switch, dry_run, max_concurrent } });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load flags' });
  }
});

const FlagsPatch = z.object({
  kill_switch: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  max_concurrent: z.number().int().min(1).max(50).optional(),
});

adminEnforcementRouter.post('/flags', async (req, res) => {
  try {
    const parsed = FlagsPatch.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const upserts: { key: string; value: any }[] = [];
    if (parsed.data.kill_switch !== undefined) {
      upserts.push({
        key: 'enforcement_kill_switch',
        value: { enabled: parsed.data.kill_switch },
      });
    }
    if (parsed.data.dry_run !== undefined) {
      upserts.push({
        key: 'enforcement_dry_run',
        value: { enabled: parsed.data.dry_run },
      });
    }
    if (parsed.data.max_concurrent !== undefined) {
      upserts.push({
        key: 'enforcement_max_concurrent',
        value: { value: parsed.data.max_concurrent },
      });
    }
    for (const row of upserts) {
      const { error } = await sb
        .from('app_runtime_config')
        .upsert(row, { onConflict: 'key' });
      if (error) return res.status(500).json({ error: error.message });
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update flags' });
  }
});

adminEnforcementRouter.post('/evaluate', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const slo = await runSloEvaluation(config);
    const eng = await runEnforcementCycle(config);
    res.json({ ok: true, slo, enforcement: eng });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Evaluation failed' });
  }
});

adminEnforcementRouter.post('/actions/:eventId/override', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const eventId = String(req.params.eventId || '');
    if (!eventId) return res.status(400).json({ error: 'Missing event id' });
    const ok = await overrideActiveAction(config, eventId, 'admin_override');
    if (!ok) return res.status(404).json({ error: 'Action not active or not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Override failed' });
  }
});
