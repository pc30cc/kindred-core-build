/**
 * Alerting & anomaly detection.
 *
 * Pure engine + webhook dispatcher. Rule evaluation itself happens in
 * TypeScript (alertEvaluator.ts's evaluateAlertRulesInMemory()) against the
 * bounded Live Monitoring collector — no Postgres SELECT on any raw
 * telemetry table. alert_rules and alert_events remain normal Postgres
 * tables; only the evaluation data source changed from raw rows to the
 * in-memory collector's query methods.
 *
 * This module:
 *   1. Triggers the evaluator (idempotent; safe to run repeatedly).
 *   2. Reads alert_events with `webhook_status = 'pending'` and dispatches
 *      to the optional webhook configured in widget_platform_settings.
 *   3. Emits structured `alert.fired` / `alert.resolved` logs via emitLog.
 *
 * Hard rules:
 *   • Never throws to callers (ticker is best-effort).
 *   • Never blocks the realtime hot path — runs out-of-band.
 *   • Webhook delivery uses HMAC-SHA256 signing if a secret is configured.
 *   • Backoff: 1 / 5 / 30 minutes via attempt counter; gives up after 5
 *     attempts and marks 'failed'.
 */

import { createHmac, randomUUID } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { emitLog } from './metrics.js';
import { evaluateAlertRulesInMemory } from './alertEvaluator.js';

export interface AlertEngineFlags {
  alertingEnabled: boolean;
  webhookUrl: string | null;
  webhookSecret: string | null;
}

const FLAG_CACHE_TTL_MS = 60_000;
let flagCache: { value: AlertEngineFlags; ts: number } | null = null;

const DEFAULT_FLAGS: AlertEngineFlags = {
  alertingEnabled: true,
  webhookUrl: null,
  webhookSecret: null,
};

const MAX_WEBHOOK_ATTEMPTS = 5;
// attempt n delay in ms — we only re-pick a row whose
// webhook_last_attempt_at is older than the next backoff tier.
const BACKOFF_MS = [0, 60_000, 5 * 60_000, 30 * 60_000, 60 * 60_000];

export async function loadAlertFlags(config: ServerConfig): Promise<AlertEngineFlags> {
  const now = Date.now();
  if (flagCache && now - flagCache.ts < FLAG_CACHE_TTL_MS) return flagCache.value;
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('widget_platform_settings')
      .select('alerting_enabled, alert_webhook_url, alert_webhook_secret')
      .limit(1)
      .maybeSingle();
    const value: AlertEngineFlags = {
      alertingEnabled: data?.alerting_enabled !== false,
      webhookUrl:
        typeof data?.alert_webhook_url === 'string' && data.alert_webhook_url.trim()
          ? data.alert_webhook_url.trim()
          : null,
      webhookSecret:
        typeof data?.alert_webhook_secret === 'string' && data.alert_webhook_secret.trim()
          ? data.alert_webhook_secret.trim()
          : null,
    };
    flagCache = { value, ts: now };
    return value;
  } catch {
    flagCache = { value: DEFAULT_FLAGS, ts: now };
    return DEFAULT_FLAGS;
  }
}

export function __resetAlertFlagCacheForTests(): void {
  flagCache = null;
}

export interface EvaluateResult {
  evaluated: number;
  state_changes: number;
  ran_at: string;
}

/**
 * Run one full alerting cycle:
 *   1. evaluate_alert_rules() → updates alert_events
 *   2. dispatchPendingWebhooks()
 *
 * Used by both the in-process ticker and the on-demand admin endpoint.
 */
export async function runAlertCycle(config: ServerConfig): Promise<EvaluateResult> {
  const flags = await loadAlertFlags(config);
  if (!flags.alertingEnabled) {
    return { evaluated: 0, state_changes: 0, ran_at: new Date().toISOString() };
  }

  let result: EvaluateResult = {
    evaluated: 0,
    state_changes: 0,
    ran_at: new Date().toISOString(),
  };

  try {
    result = await evaluateAlertRulesInMemory(config);
  } catch (err: any) {
    emitLog(config, 'warn', 'alert_evaluator_threw', { error: err?.message || 'unknown' });
  }

  // Pending webhook dispatch is independent of the evaluator's success.
  try {
    await dispatchPendingWebhooks(config, flags);
  } catch (err: any) {
    emitLog(config, 'warn', 'alert_webhook_dispatch_threw', { error: err?.message || 'unknown' });
  }

  return result;
}

interface PendingAlertRow {
  id: string;
  rule_id: string;
  rule_slug: string;
  severity: string;
  state: string;
  metric_value: number | null;
  threshold_value: number | null;
  window_seconds: number;
  sample_size: number | null;
  details: Record<string, unknown>;
  fired_at: string;
  resolved_at: string | null;
  webhook_attempts: number;
  webhook_last_attempt_at: string | null;
}

async function dispatchPendingWebhooks(
  config: ServerConfig,
  flags: AlertEngineFlags,
): Promise<void> {
  const sb = getServiceClient(config);
  // Pull pending rows. Cap at 50 per cycle so a backlog can't stall the ticker.
  const { data, error } = await sb
    .from('alert_events')
    .select(
      'id, rule_id, rule_slug, severity, state, metric_value, threshold_value, window_seconds, sample_size, details, fired_at, resolved_at, webhook_attempts, webhook_last_attempt_at',
    )
    .eq('webhook_status', 'pending')
    .order('fired_at', { ascending: true })
    .limit(50);

  if (error) {
    emitLog(config, 'warn', 'alert_webhook_query_failed', { error: error.message });
    return;
  }
  const rows = (data || []) as PendingAlertRow[];
  if (rows.length === 0) return;

  // If no webhook is configured, mark them all 'disabled' so we don't re-process.
  if (!flags.webhookUrl) {
    const ids = rows.map((r) => r.id);
    await sb
      .from('alert_events')
      .update({ webhook_status: 'disabled' })
      .in('id', ids);
    // Still emit structured logs for state changes.
    for (const r of rows) emitAlertLog(config, r);
    return;
  }

  for (const row of rows) {
    // Always log the state change first (logs are independent of webhook success).
    emitAlertLog(config, row);

    // Backoff gate: skip rows whose previous attempt was too recent.
    if (row.webhook_attempts > 0 && row.webhook_last_attempt_at) {
      const since = Date.now() - new Date(row.webhook_last_attempt_at).getTime();
      const tier = Math.min(row.webhook_attempts, BACKOFF_MS.length - 1);
      if (since < BACKOFF_MS[tier]) continue;
    }

    const ok = await deliverWebhook(config, flags, row);

    if (ok) {
      await sb
        .from('alert_events')
        .update({
          webhook_status: 'delivered',
          webhook_attempts: row.webhook_attempts + 1,
          webhook_last_attempt_at: new Date().toISOString(),
          webhook_last_error: null,
        })
        .eq('id', row.id);
    } else {
      const attempts = row.webhook_attempts + 1;
      const finalStatus = attempts >= MAX_WEBHOOK_ATTEMPTS ? 'failed' : 'pending';
      await sb
        .from('alert_events')
        .update({
          webhook_status: finalStatus,
          webhook_attempts: attempts,
          webhook_last_attempt_at: new Date().toISOString(),
        })
        .eq('id', row.id);
    }
  }
}

function emitAlertLog(config: ServerConfig, row: PendingAlertRow): void {
  const isResolved = row.state === 'resolved';
  emitLog(config, isResolved ? 'info' : 'warn', isResolved ? 'alert.resolved' : 'alert.fired', {
    rule_slug: row.rule_slug,
    severity: row.severity,
    metric_value: row.metric_value,
    threshold_value: row.threshold_value,
    window_seconds: row.window_seconds,
    sample_size: row.sample_size,
  });
}

async function deliverWebhook(
  config: ServerConfig,
  flags: AlertEngineFlags,
  row: PendingAlertRow,
): Promise<boolean> {
  const url = flags.webhookUrl;
  if (!url) return false;

  const payload = {
    id: row.id,
    rule_slug: row.rule_slug,
    severity: row.severity,
    state: row.state,
    metric_value: row.metric_value,
    threshold_value: row.threshold_value,
    window_seconds: row.window_seconds,
    sample_size: row.sample_size,
    details: row.details,
    fired_at: row.fired_at,
    resolved_at: row.resolved_at,
    delivery_id: randomUUID(),
    delivered_at: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'lovable-alerting/1.0',
    'x-alert-event': row.state === 'resolved' ? 'alert.resolved' : 'alert.fired',
    'x-alert-id': row.id,
    'x-alert-delivery': payload.delivery_id,
  };
  if (flags.webhookSecret) {
    const sig = createHmac('sha256', flags.webhookSecret).update(body).digest('hex');
    headers['x-alert-signature'] = `sha256=${sig}`;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: ac.signal,
    });
    if (res.ok) return true;
    const errText = (await res.text().catch(() => '')).slice(0, 256);
    await getServiceClient(config)
      .from('alert_events')
      .update({ webhook_last_error: `${res.status}: ${errText}` })
      .eq('id', row.id);
    return false;
  } catch (err: any) {
    await getServiceClient(config)
      .from('alert_events')
      .update({ webhook_last_error: String(err?.message || 'fetch_error').slice(0, 256) })
      .eq('id', row.id);
    return false;
  } finally {
    clearTimeout(timer);
  }
}