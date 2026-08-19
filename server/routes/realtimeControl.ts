/**
 * Phase 6A — Realtime Control Plane admin routes.
 *
 * Exposes degradation policy + provider failover settings under
 * /api/realtime/admin/control. Audit entries reuse the existing
 * `realtime_provider_audit` table.
 *
 * NOTE: This endpoint persists configuration only. The active provider
 * decision continues to flow through `resolveRealtimeProvider()` until the
 * Phase 6B failover engine is wired in.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  loadControlPlane,
  saveControlPlane,
  diffControlPlane,
  DEFAULT_CONTROL_PLANE,
  type RealtimeControlPlaneConfig,
  type RealtimeProviderId,
} from '../services/realtime/controlPlane.js';
import { resolveRealtimeProvider, loadRealtimeConfig } from '../services/realtime/index.js';
import { loadFailoverState } from '../services/realtime/failoverState.js';
import { runFailoverTickOnce } from '../services/realtime/failoverTicker.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';

export const realtimeControlRouter = Router();

async function requireAdmin(req: any, res: any, next: any) {
  const userId = await requirePlatformAdmin(req, res);
  if (!userId) return;
  (req as any).adminUser = { id: userId };
  next();
}

realtimeControlRouter.use(requireAdmin);

const PROVIDER_ENUM = z.enum(['centrifugo', 'supabase_realtime', 'polling_builtin']);

const updateSchema = z.object({
  // Degradation
  realtime_degraded_mode_enabled: z.boolean().optional(),
  realtime_disable_typing_on_overload: z.boolean().optional(),
  realtime_force_polling_on_critical_degradation: z.boolean().optional(),
  realtime_reconnect_backoff_multiplier_on_overload: z.number().min(1).max(10).optional(),
  realtime_degraded_mode_ttl_seconds: z.number().int().min(30).max(86_400).optional(),
  realtime_degraded_mode_auto_recover: z.boolean().optional(),
  realtime_fail_open_if_control_plane_stale: z.boolean().optional(),
  // Failover
  realtime_failover_enabled: z.boolean().optional(),
  realtime_failback_enabled: z.boolean().optional(),
  realtime_failover_cooldown_seconds: z.number().int().min(30).max(86_400).optional(),
  realtime_failback_stable_window_seconds: z.number().int().min(30).max(86_400).optional(),
  realtime_failover_error_threshold: z.number().min(0).max(1).optional(),
  realtime_failover_latency_threshold_ms: z.number().int().min(50).max(60_000).optional(),
  realtime_failover_health_window_seconds: z.number().int().min(30).max(86_400).optional(),
  realtime_provider_order: z.array(PROVIDER_ENUM).min(1).max(8).optional(),
  realtime_provider_lock: PROVIDER_ENUM.nullable().optional(),
});

function categorizeAction(diff: Record<string, unknown>): string {
  const keys = Object.keys(diff);
  if (keys.length === 0) return 'control_settings_noop';
  if (keys.includes('realtime_provider_lock')) return 'provider_lock_update';
  if (keys.includes('realtime_provider_order')) return 'provider_order_update';
  if (keys.some((k) => k.startsWith('realtime_failover_') || k.startsWith('realtime_failback_'))) {
    return 'failover_thresholds_update';
  }
  return 'control_settings_update';
}

/**
 * GET /api/realtime/admin/control
 * Returns current control-plane config + sane defaults + active provider
 * snapshot so the UI can show "current" vs "configured".
 */
realtimeControlRouter.get('/', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const [settings, resolved, provider] = await Promise.all([
      loadControlPlane(config, true),
      resolveRealtimeProvider(config, { skipHealth: true }),
      loadRealtimeConfig(config, true),
    ]);
    res.json({
      settings,
      defaults: DEFAULT_CONTROL_PLANE,
      active: {
        configured_vendor: provider.vendor,
        effective_vendor: resolved.effective_vendor,
        source: resolved.source,
        health: resolved.health,
        fallback_policy: resolved.fallback_policy,
      },
    });
  } catch (err: any) {
    console.error('[realtime/admin/control GET]', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

/**
 * PUT /api/realtime/admin/control
 * Patches one or more control-plane settings. Records masked diff into the
 * existing realtime_provider_audit table.
 */
realtimeControlRouter.put('/', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const adminUser = (req as any).adminUser;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid payload', details: parsed.error.flatten() });
    }
    const prev = await loadControlPlane(config, true);
    const merged: RealtimeControlPlaneConfig = { ...prev, ...parsed.data } as RealtimeControlPlaneConfig;
    const next = await saveControlPlane(config, merged);
    const diff = diffControlPlane(prev, next);
    const action = categorizeAction(diff);
    if (Object.keys(diff).length > 0) {
      await getServiceClient(config).from('realtime_provider_audit').insert({
        changed_by: adminUser.id,
        action,
        vendor: (next.realtime_provider_lock ?? null) as RealtimeProviderId | null,
        config_diff: diff,
        result: 'success',
        ip_address:
          (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
          req.socket.remoteAddress ||
          null,
      });
    }
    res.json({ ok: true, settings: next });
  } catch (err: any) {
    console.error('[realtime/admin/control PUT]', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

/**
 * GET /api/realtime/admin/control/audit
 * Returns recent control-plane audit entries (filters to control-plane
 * actions only; provider config audit remains under /admin/audit).
 */
realtimeControlRouter.get('/audit', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('realtime_provider_audit')
      .select('id, changed_by, action, config_diff, result, error_message, ip_address, created_at')
      .in('action', [
        'control_settings_update',
        'provider_order_update',
        'provider_lock_update',
        'failover_thresholds_update',
        'failover_engine:failover',
        'failover_engine:failback',
        'failover_engine:last_resort',
        'failover_engine:lock_applied',
        'failover_engine:lock_cleared',
      ])
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ entries: data ?? [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

/**
 * GET /api/realtime/admin/control/failover
 * Phase 6B — current failover engine state + per-provider health snapshot.
 */
realtimeControlRouter.get('/failover', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const [policy, state] = await Promise.all([
      loadControlPlane(config, true),
      loadFailoverState(config, true),
    ]);
    const nowMs = Date.now();
    const cooldownMs = state.cooldown_until
      ? Math.max(0, new Date(state.cooldown_until).getTime() - nowMs)
      : 0;
    const failbackMs = state.failback_eligible_at
      ? Math.max(0, new Date(state.failback_eligible_at).getTime() - nowMs)
      : 0;
    res.json({
      effective_provider: state.effective_provider,
      provider_lock: policy.realtime_provider_lock,
      provider_order: policy.realtime_provider_order,
      failover_enabled: policy.realtime_failover_enabled,
      failback_enabled: policy.realtime_failback_enabled,
      cooldown_until: state.cooldown_until,
      cooldown_remaining_ms: cooldownMs,
      failback_eligible_at: state.failback_eligible_at,
      failback_remaining_ms: failbackMs,
      candidate_recovery_provider: state.candidate_recovery_provider,
      candidate_recovery_since: state.candidate_recovery_since,
      last_failover_at: state.last_failover_at,
      last_failover_reason: state.last_failover_reason,
      last_health: state.last_health,
      last_evaluated_at: state.last_evaluated_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

/**
 * POST /api/realtime/admin/control/failover/evaluate
 * Trigger an immediate engine evaluation (admin-only). Useful right after
 * editing thresholds or the provider lock.
 */
realtimeControlRouter.post('/failover/evaluate', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    await runFailoverTickOnce(config);
    const state = await loadFailoverState(config, true);
    res.json({ ok: true, effective_provider: state.effective_provider });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Evaluation failed' });
  }
});
