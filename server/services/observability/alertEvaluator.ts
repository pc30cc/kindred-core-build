/**
 * TypeScript replacement for the SQL `evaluate_alert_rules()` function
 * (formerly in supabase/migrations/20260422102236_...sql), dropped by the
 * Live Monitoring migration once the raw telemetry tables it read from
 * (realtime_metric_events, perf_request_samples, perf_process_samples)
 * are gone.
 *
 * `alert_rules` and `alert_events` stay exactly as they were — admin-
 * configured rule definitions and the historical alert audit trail are
 * business/operational data, not high-frequency telemetry, and are
 * unaffected by this migration. Only the evaluation DATA SOURCE changes:
 * every rule kind now reads from the bounded in-memory MonitoringCollector
 * instead of SELECTing the raw tables. The open/escalate/resolve lifecycle
 * against alert_events is reproduced line-for-line from the original SQL.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getMonitoringCollector } from './collector/index.js';
import type { MonitoringCollector, ProcessAverageMetric } from './collector/types.js';

type AlertRuleKind =
  | 'count'
  | 'ratio'
  | 'perf_p95'
  | 'perf_p99'
  | 'perf_error_rate'
  | 'process_avg'
  | 'process_ratio'
  | 'combined';

interface AlertRuleRow {
  id: string;
  slug: string;
  kind: AlertRuleKind;
  metric: string | null;
  numerator: string | null;
  denominator: string | null;
  route_group: string | null;
  window_seconds: number;
  warn_threshold: number;
  critical_threshold: number;
  min_sample: number;
  subrules: string[] | null;
  aggregation: string | null;
  enabled: boolean;
}

interface OpenAlertEventRow {
  id: string;
  severity: string;
}

interface RuleEvalResult {
  severity: 'critical' | 'warn' | null;
  threshold: number | null;
  value: number;
  sample: number | null;
}

export interface EvaluateAlertRulesResult {
  evaluated: number;
  state_changes: number;
  ran_at: string;
}

function classifyThreshold(value: number, rule: AlertRuleRow): { severity: 'critical' | 'warn' | null; threshold: number | null } {
  if (value >= rule.critical_threshold) return { severity: 'critical', threshold: rule.critical_threshold };
  if (value >= rule.warn_threshold) return { severity: 'warn', threshold: rule.warn_threshold };
  return { severity: null, threshold: null };
}

function evaluateSyncRule(rule: AlertRuleRow, collector: MonitoringCollector, budgetBytes: number): RuleEvalResult {
  switch (rule.kind) {
    case 'count': {
      const value = collector.queryRealtimeCount(rule.metric || '', rule.window_seconds);
      const { severity, threshold } = classifyThreshold(value, rule);
      return { severity, threshold, value, sample: null };
    }
    case 'ratio': {
      const { num, den } = collector.queryRealtimeRatio(rule.numerator || '', rule.denominator || '', rule.window_seconds);
      if (den === 0 || den < rule.min_sample) return { severity: null, threshold: null, value: 0, sample: den };
      const value = num / den;
      const { severity, threshold } = classifyThreshold(value, rule);
      return { severity, threshold, value, sample: den };
    }
    case 'perf_p95':
    case 'perf_p99': {
      const pct = rule.kind === 'perf_p95' ? 95 : 99;
      const { value: v, sample } = collector.queryPerfPercentile(rule.route_group || '', pct, rule.window_seconds);
      if (sample < Math.max(rule.min_sample, 1)) return { severity: null, threshold: null, value: 0, sample };
      const { severity, threshold } = classifyThreshold(v, rule);
      return { severity, threshold, value: v, sample };
    }
    case 'perf_error_rate': {
      const { rate, sample } = collector.queryPerfErrorRate(rule.route_group || '', rule.window_seconds);
      if (sample < Math.max(rule.min_sample, 1)) return { severity: null, threshold: null, value: 0, sample };
      const { severity, threshold } = classifyThreshold(rate, rule);
      return { severity, threshold, value: rate, sample };
    }
    case 'process_avg': {
      const metric: ProcessAverageMetric | null =
        rule.metric === 'event_loop_lag_ms' ? 'event_loop_lag_ms' : rule.metric === 'rss_pct_of_budget' ? 'rss_pct_of_budget' : null;
      if (!metric) return { severity: null, threshold: null, value: 0, sample: 0 };
      const { value, sample } = collector.queryProcessAverage(metric, rule.window_seconds, budgetBytes);
      if (sample < Math.max(rule.min_sample, 1)) return { severity: null, threshold: null, value: 0, sample };
      const { severity, threshold } = classifyThreshold(value, rule);
      return { severity, threshold, value, sample };
    }
    case 'process_ratio': {
      if (rule.metric !== 'heap_used_over_total') return { severity: null, threshold: null, value: 0, sample: 0 };
      const { value, sample } = collector.queryProcessAverage('heap_used_over_total', rule.window_seconds);
      if (sample < Math.max(rule.min_sample, 1)) return { severity: null, threshold: null, value: 0, sample };
      const { severity, threshold } = classifyThreshold(value, rule);
      return { severity, threshold, value, sample };
    }
    default:
      // 'combined' is handled by evaluateCombinedRule (needs a DB read).
      return { severity: null, threshold: null, value: 0, sample: null };
  }
}

async function evaluateCombinedRule(
  sb: ReturnType<typeof getServiceClient>,
  rule: AlertRuleRow,
): Promise<RuleEvalResult> {
  const subrules = Array.isArray(rule.subrules) ? rule.subrules : [];
  let value = 0;
  if (subrules.length > 0) {
    const { data } = await sb.from('alert_events').select('rule_slug').eq('state', 'open').in('rule_slug', subrules);
    value = new Set((data || []).map((row: any) => row.rule_slug)).size;
  }
  // combined has no min_sample gate in the original SQL — always classifies.
  const { severity, threshold } = classifyThreshold(value, rule);
  return { severity, threshold, value, sample: subrules.length };
}

async function applyRuleResult(
  sb: ReturnType<typeof getServiceClient>,
  rule: AlertRuleRow,
  result: RuleEvalResult,
  now: Date,
): Promise<boolean> {
  const { data: openRows } = await sb
    .from('alert_events')
    .select('id, severity')
    .eq('rule_id', rule.id)
    .eq('state', 'open')
    .order('fired_at', { ascending: false })
    .limit(1);
  const open: OpenAlertEventRow | null = openRows && openRows.length > 0 ? (openRows[0] as OpenAlertEventRow) : null;

  if (result.severity !== null) {
    if (!open) {
      await sb.from('alert_events').insert({
        rule_id: rule.id,
        rule_slug: rule.slug,
        severity: result.severity,
        state: 'open',
        metric_value: result.value,
        threshold_value: result.threshold,
        window_seconds: rule.window_seconds,
        sample_size: result.sample,
        details: {
          kind: rule.kind,
          metric: rule.metric,
          numerator: rule.numerator,
          denominator: rule.denominator,
          route_group: rule.route_group,
          aggregation: rule.aggregation,
          subrules: rule.subrules,
        },
        webhook_status: 'pending',
      });
      return true;
    }
    if (open.severity !== result.severity) {
      await sb
        .from('alert_events')
        .update({
          severity: result.severity,
          metric_value: result.value,
          threshold_value: result.threshold,
          sample_size: result.sample,
          webhook_status: 'pending',
        })
        .eq('id', open.id);
      return true;
    }
    await sb.from('alert_events').update({ metric_value: result.value, sample_size: result.sample }).eq('id', open.id);
    return false;
  }

  if (open) {
    await sb
      .from('alert_events')
      .update({
        state: 'resolved',
        severity: 'resolved',
        resolved_at: now.toISOString(),
        metric_value: result.value,
        sample_size: result.sample,
        webhook_status: 'pending',
      })
      .eq('id', open.id);
    return true;
  }
  return false;
}

export async function evaluateAlertRulesInMemory(config: ServerConfig): Promise<EvaluateAlertRulesResult> {
  const sb = getServiceClient(config);
  const collector = getMonitoringCollector();
  const now = new Date();

  const { data: settingsRow } = await sb
    .from('widget_platform_settings')
    .select('perf_memory_budget_mb')
    .limit(1)
    .maybeSingle();
  const budgetBytes = (Number((settingsRow as any)?.perf_memory_budget_mb) || 512) * 1024 * 1024;

  const { data: rules, error: rulesError } = await sb.from('alert_rules').select('*').eq('enabled', true);
  if (rulesError) throw new Error(rulesError.message);

  let evaluated = 0;
  let stateChanges = 0;

  for (const rule of (rules || []) as AlertRuleRow[]) {
    evaluated += 1;
    const result = rule.kind === 'combined' ? await evaluateCombinedRule(sb, rule) : evaluateSyncRule(rule, collector, budgetBytes);
    const changed = await applyRuleResult(sb, rule, result, now);
    if (changed) stateChanges += 1;
  }

  return { evaluated, state_changes: stateChanges, ran_at: now.toISOString() };
}
