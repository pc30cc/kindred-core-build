/**
 * Phase 5C — Admin auto-actions API.
 * Mounted under /api/admin/auto-actions (admin-auth applied by adminRouter).
 *
 * Endpoints (all admin-only):
 *   GET  /definitions                   → list action definitions
 *   PATCH /definitions/:id              → enabled / cooldown / max duration / min severity
 *   GET  /events?state=&limit=          → list event history
 *   GET  /active                        → currently-active actions (for banner)
 *   POST /evaluate                      → run engine now
 *   POST /events/:id/override           → manually end an active action
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  runAutoActionCycle,
  overrideActiveAction,
} from '../services/observability/autoActions.js';

export const adminAutoActionsRouter = Router();

adminAutoActionsRouter.get('/definitions', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('auto_action_definitions')
      .select('*')
      .order('slug', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ definitions: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load definitions' });
  }
});

const DefUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  cooldown_seconds: z.number().int().min(60).max(86_400).optional(),
  max_duration_seconds: z.number().int().min(60).max(86_400).optional(),
  min_severity: z.enum(['warn', 'critical']).optional(),
});

adminAutoActionsRouter.patch('/definitions/:id', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const parsed = DefUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('auto_action_definitions')
      .update(parsed.data)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Definition not found' });
    res.json({ definition: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update definition' });
  }
});

adminAutoActionsRouter.get('/events', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1),
      200,
    );
    const state = req.query.state ? String(req.query.state) : null;
    const sb = getServiceClient(config);
    let q = sb
      .from('auto_action_events')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(limit);
    if (state && ['active', 'expired', 'resolved', 'overridden'].includes(state)) {
      q = q.eq('state', state);
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ events: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load events' });
  }
});

adminAutoActionsRouter.get('/active', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('auto_action_events')
      .select(
        'id, action_slug, action_type, trigger_rule_slug, trigger_severity, started_at, expires_at',
      )
      .eq('state', 'active')
      .order('started_at', { ascending: false })
      .limit(20);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ active: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load active actions' });
  }
});

adminAutoActionsRouter.post('/evaluate', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const result = await runAutoActionCycle(config);
    res.json({ ok: true, result });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Evaluation failed' });
  }
});

adminAutoActionsRouter.post('/events/:id/override', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const ok = await overrideActiveAction(config, id, 'admin_override');
    if (!ok) return res.status(404).json({ error: 'Action not active or not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Override failed' });
  }
});