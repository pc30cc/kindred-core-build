/**
 * Phase 5C — Self-healing / auto-actions engine.
 *
 * Pure orchestrator. The actual decision logic lives in the
 * `activate_auto_actions()` SECURITY DEFINER function so cooldown,
 * idempotency, and expiry are atomic in Postgres.
 *
 * This module also handles the special "any-critical" mapping for
 * mark_system_degraded — that definition has trigger_rule_slug = NULL
 * and is matched here against any open critical alert.
 *
 * Hard rules (from Phase 5C scope):
 *   • Never throws to callers; ticker is best-effort.
 *   • Never blocks chat send flow.
 *   • Never mutates alert history.
 *   • Never touches billing, auth, or storage.
 *   • All actions are reversible and time-bounded.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { emitLog } from './metrics.js';
import { forceRefreshAutoActionsCache } from './autoActionsCache.js';

export interface AutoActionCycleResult {
  expired: number;
  resolved: number;
  activated: number;
  ran_at: string;
}

/**
 * Run one full auto-action cycle:
 *   1. activate_auto_actions() in SQL — handles expire / resolve / activate
 *      for definitions that have a concrete trigger_rule_slug.
 *   2. Handle the special "any-critical" mapping for mark_system_degraded.
 */
export async function runAutoActionCycle(
  config: ServerConfig,
): Promise<AutoActionCycleResult> {
  const sb = getServiceClient(config);
  const result: AutoActionCycleResult = {
    expired: 0,
    resolved: 0,
    activated: 0,
    ran_at: new Date().toISOString(),
  };

  try {
    const { data, error } = await sb.rpc('activate_auto_actions');
    if (error) {
      emitLog(config, 'warn', 'auto_action_evaluator_failed', { error: error.message });
    } else if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      result.expired = Number(d.expired || 0);
      result.resolved = Number(d.resolved || 0);
      result.activated = Number(d.activated || 0);
      result.ran_at = String(d.ran_at || result.ran_at);
    }
  } catch (err: any) {
    emitLog(config, 'warn', 'auto_action_evaluator_threw', {
      error: err?.message || 'unknown',
    });
  }

  // Handle "any-critical" mapping for mark_system_degraded.
  try {
    const extra = await activateAnyCriticalDegraded(config);
    result.activated += extra;
  } catch (err: any) {
    emitLog(config, 'warn', 'auto_action_degraded_threw', {
      error: err?.message || 'unknown',
    });
  }

  if (result.activated > 0 || result.expired > 0 || result.resolved > 0) {
    emitLog(config, 'info', 'auto_action_cycle', result as unknown as Record<string, unknown>);
    // Keep the hot-path cache aligned with the latest activations/expiries.
    void forceRefreshAutoActionsCache(config);
  }

  return result;
}

/**
 * Built-in mapping: any open critical alert → mark_system_degraded.
 * Implemented in TS (not SQL) because the SQL function only handles
 * concrete rule_slug bindings.
 */
async function activateAnyCriticalDegraded(config: ServerConfig): Promise<number> {
  // alert_events is maintained ONLY by the alerting ticker: it is what moves
  // a row from 'open' to 'resolved' (alertEvaluator). This auto-actions
  // ticker is deliberately NOT gated by OBSERVABILITY_REPORTING_TICKERS, so
  // with the alerting ticker off an alert that merely happened to be open at
  // the moment the flag flipped would stay open for good and pin the whole
  // system into "degraded" — a live request path reading a verdict nobody
  // is keeping current. Skip the mapping rather than act on frozen state.
  if (config.observabilityReportingTickersEnabled === false) return 0;

  const sb = getServiceClient(config);

  const { data: defs } = await sb
    .from('auto_action_definitions')
    .select('*')
    .eq('action_type', 'mark_system_degraded')
    .eq('enabled', true)
    .is('trigger_rule_slug', null)
    .limit(1);

  const def = (defs || [])[0];
  if (!def) return 0;

  // Already active?
  const { data: active } = await sb
    .from('auto_action_events')
    .select('id')
    .eq('definition_id', def.id)
    .eq('state', 'active')
    .limit(1);
  if ((active || []).length > 0) return 0;

  // Cooldown check.
  const { data: lastRows } = await sb
    .from('auto_action_events')
    .select('started_at')
    .eq('definition_id', def.id)
    .order('started_at', { ascending: false })
    .limit(1);
  const last = (lastRows || [])[0];
  if (last) {
    const ageSec = (Date.now() - new Date(last.started_at).getTime()) / 1000;
    if (ageSec < def.cooldown_seconds) return 0;
  }

  // Find any open critical alert.
  const { data: alerts } = await sb
    .from('alert_events')
    .select('id, rule_slug, severity, metric_value, threshold_value, window_seconds')
    .eq('state', 'open')
    .eq('severity', 'critical')
    .order('fired_at', { ascending: false })
    .limit(1);
  const alert = (alerts || [])[0];
  if (!alert) return 0;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + def.max_duration_seconds * 1000);

  const { error } = await sb.from('auto_action_events').insert({
    definition_id: def.id,
    action_slug: def.slug,
    action_type: def.action_type,
    trigger_rule_slug: alert.rule_slug,
    trigger_alert_event_id: alert.id,
    trigger_severity: alert.severity,
    state: 'active',
    started_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    details: {
      metric_value: alert.metric_value,
      threshold_value: alert.threshold_value,
      window_seconds: alert.window_seconds,
      mapping: 'any_critical',
    },
  });
  if (error) {
    emitLog(config, 'warn', 'auto_action_degraded_insert_failed', { error: error.message });
    return 0;
  }
  return 1;
}

/**
 * Manual override: end an active action immediately.
 */
export async function overrideActiveAction(
  config: ServerConfig,
  eventId: string,
  reason: 'manual' | 'admin_override' = 'admin_override',
): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('auto_action_events')
    .update({
      state: 'overridden',
      ended_at: new Date().toISOString(),
      ended_reason: reason,
    })
    .eq('id', eventId)
    .eq('state', 'active')
    .select('id')
    .maybeSingle();
  if (error || !data) return false;
  emitLog(config, 'info', 'auto_action_overridden', { event_id: eventId, reason });
  // Refresh fast-path cache so suppression effects clear immediately.
  void forceRefreshAutoActionsCache(config);
  return true;
}