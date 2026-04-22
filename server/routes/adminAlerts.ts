/**
 * Phase 4 — Admin alerting API.
 * Mounted under /api/admin/alerts (admin-auth applied by adminRouter).
 *
 * Endpoints (all admin-only):
 *   GET  /rules                     → list rules
 *   PATCH /rules/:id                → update enabled / thresholds / window
 *   GET  /events?state=&limit=      → list alert events (recent first)
 *   GET  /active                    → currently-open alerts (for banner)
 *   POST /evaluate                  → run engine + webhook dispatch now
 *   GET  /webhook                   → read webhook config
 *   PUT  /webhook                   → update webhook config
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  runAlertCycle,
  loadAlertFlags,
  __resetAlertFlagCacheForTests,
} from '../services/observability/alerting.js';

export const adminAlertsRouter = Router();

adminAlertsRouter.get('/rules', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('alert_rules')
      .select('*')
      .order('slug', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rules: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load rules' });
  }
});

const RuleUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  warn_threshold: z.number().nonnegative().optional(),
  critical_threshold: z.number().nonnegative().optional(),
  window_seconds: z.number().int().min(60).max(3600).optional(),
  min_sample: z.number().int().min(0).max(10_000).optional(),
});

adminAlertsRouter.patch('/rules/:id', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const parsed = RuleUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    if (
      parsed.data.warn_threshold != null &&
      parsed.data.critical_threshold != null &&
      parsed.data.critical_threshold < parsed.data.warn_threshold
    ) {
      return res.status(400).json({ error: 'critical_threshold must be >= warn_threshold' });
    }

    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('alert_rules')
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

adminAlertsRouter.get('/events', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1),
      200,
    );
    const state = req.query.state ? String(req.query.state) : null;
    const sb = getServiceClient(config);
    let q = sb
      .from('alert_events')
      .select('*')
      .order('fired_at', { ascending: false })
      .limit(limit);
    if (state === 'open' || state === 'resolved') q = q.eq('state', state);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ events: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load events' });
  }
});

adminAlertsRouter.get('/active', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('alert_events')
      .select('id, rule_slug, severity, metric_value, threshold_value, fired_at')
      .eq('state', 'open')
      .order('fired_at', { ascending: false })
      .limit(20);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ active: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load active alerts' });
  }
});

adminAlertsRouter.post('/evaluate', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const result = await runAlertCycle(config);
    res.json({ ok: true, result });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Evaluation failed' });
  }
});

adminAlertsRouter.get('/webhook', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const flags = await loadAlertFlags(config);
    res.json({
      alerting_enabled: flags.alertingEnabled,
      webhook_url: flags.webhookUrl,
      // Never echo the secret. Just whether one is configured.
      webhook_secret_set: Boolean(flags.webhookSecret),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load webhook config' });
  }
});

const WebhookSchema = z.object({
  alerting_enabled: z.boolean().optional(),
  webhook_url: z
    .string()
    .trim()
    .max(2048)
    .regex(/^https?:\/\//, 'Must start with http:// or https://')
    .nullable()
    .or(z.literal('')),
  webhook_secret: z.string().trim().max(256).nullable().or(z.literal('')).optional(),
});

adminAlertsRouter.put('/webhook', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const parsed = WebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const sb = getServiceClient(config);
    const update: Record<string, unknown> = {
      alert_webhook_url:
        parsed.data.webhook_url === '' || parsed.data.webhook_url == null
          ? null
          : parsed.data.webhook_url,
    };
    if (parsed.data.alerting_enabled !== undefined) {
      update.alerting_enabled = parsed.data.alerting_enabled;
    }
    if (parsed.data.webhook_secret !== undefined) {
      update.alert_webhook_secret =
        parsed.data.webhook_secret === '' || parsed.data.webhook_secret == null
          ? null
          : parsed.data.webhook_secret;
    }
    // widget_platform_settings is a singleton — update the first row.
    const { data: existing } = await sb
      .from('widget_platform_settings')
      .select('id')
      .limit(1)
      .maybeSingle();
    if (!existing?.id) {
      return res.status(500).json({ error: 'widget_platform_settings row not found' });
    }
    const { error } = await sb
      .from('widget_platform_settings')
      .update(update)
      .eq('id', existing.id);
    if (error) return res.status(500).json({ error: error.message });
    __resetAlertFlagCacheForTests(); // clear 60s cache so changes apply immediately
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to update webhook config' });
  }
});