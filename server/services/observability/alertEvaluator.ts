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
  metric_value?: number | null;
  threshold_value?: number | null;
  sample_size?: number | null;
  details?: Record<string, unknown> | null;
}

/** An open incident as carried in the per-pass index, keyed by rule id. */
interface OpenAlertIndexEntry extends OpenAlertEventRow {
  rule_id: string;
  rule_slug: string | null;
  fired_at?: string | null;
}

/**
 * Snapshot of every currently-open incident, keyed by `rule_id`.
 *
 * This replaces the per-rule `SELECT ... FROM alert_events WHERE rule_id = $1
 * AND state = 'open'` that used to run inside applyRuleResult, plus the
 * separate subrule lookup that ran inside evaluateCombinedRule. With N
 * enabled rules the old shape cost N+M round trips per cycle (27 rules and 2
 * combined rules measured at ~29 reads/pass, ~1 request/second against
 * PostgREST around the clock); the batched shape costs exactly one.
 *
 * The map is mutated in place as the pass writes, so it stays an accurate
 * mirror of what Postgres holds: combined rules — which run in the second
 * phase and inspect their subrules' *persisted* open state — observe alerts
 * opened or resolved by base rules earlier in the same pass, exactly as they
 * did when they re-queried the table.
 */
type OpenAlertIndex = Map<string, OpenAlertIndexEntry>;

/** Bounded audit trail: keep at most this many severity transitions per incident. */
const MAX_TRANSITIONS = 20;


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
      if (rule.metric !== 'heap_used_over_total' && rule.metric !== 'heap_used_over_limit') {
        return { severity: null, threshold: null, value: 0, sample: 0 };
      }
      const { value, sample } = collector.queryProcessAverage(rule.metric, rule.window_seconds);
      if (sample < Math.max(rule.min_sample, 1)) return { severity: null, threshold: null, value: 0, sample };
      const { severity, threshold } = classifyThreshold(value, rule);
      return { severity, threshold, value, sample };
    }
    default:
      // 'combined' is handled by evaluateCombinedRule (needs a DB read).
      return { severity: null, threshold: null, value: 0, sample: null };
  }
}

function evaluateCombinedRule(rule: AlertRuleRow, openIndex: OpenAlertIndex): RuleEvalResult {
  const subrules = Array.isArray(rule.subrules) ? rule.subrules : [];
  let value = 0;
  if (subrules.length > 0) {
    // Counts DISTINCT open subrule slugs, matching the old
    // `SELECT rule_slug ... WHERE state = 'open' AND rule_slug IN (...)`
    // followed by a Set of the returned slugs. Reading the index rather than
    // the table keeps the two-phase ordering guarantee intact: base rules
    // have already written, and applyRuleResult mirrored those writes here.
    const wanted = new Set(subrules);
    const openSlugs = new Set<string>();
    for (const entry of openIndex.values()) {
      if (entry.rule_slug != null && wanted.has(entry.rule_slug)) openSlugs.add(entry.rule_slug);
    }
    value = openSlugs.size;
  }
  // combined has no min_sample gate in the original SQL — always classifies.
  const { severity, threshold } = classifyThreshold(value, rule);
  return { severity, threshold, value, sample: subrules.length };
}

/**
 * The single batched read that feeds a whole evaluation pass.
 *
 * Deliberately NOT filtered to the enabled rule ids: a combined rule may name
 * a subrule that has since been disabled but still holds an open incident,
 * and the old per-slug query would have counted it. Filtering here would
 * silently change that. The open set is self-limiting — at most one
 * meaningful open incident per rule — so reading all of it stays cheap.
 */
async function loadOpenAlertIndex(sb: ReturnType<typeof getServiceClient>): Promise<OpenAlertIndex> {
  const { data, error } = await sb
    .from('alert_events')
    .select('id, rule_id, rule_slug, severity, metric_value, threshold_value, sample_size, details, fired_at')
    .eq('state', 'open')
    .order('fired_at', { ascending: false });
  if (error) {
    throw new Error(`alertEvaluator: failed to read open alert_events: ${error.message}`);
  }
  const index: OpenAlertIndex = new Map();
  for (const row of (data || []) as OpenAlertIndexEntry[]) {
    if (row?.rule_id == null) continue;
    // Rows arrive newest-first, so the first one seen per rule wins — the same
    // tie-break as the old per-rule `.order('fired_at', desc).limit(1)`.
    if (!index.has(row.rule_id)) index.set(row.rule_id, row);
  }
  return index;
}

/**
 * Every persistence/read op below explicitly checks the returned Supabase
 * `error` and throws rather than silently proceeding — a failed read must
 * never be treated as "no open alert" (which would insert a duplicate open
 * alert on top of one Postgres already has), and a failed write must never
 * be counted as a successful state transition. Throwing here propagates up
 * through evaluateAlertRulesInMemory -> runAlertCycle's existing catch
 * (alerting.ts), which logs `alert_evaluator_threw` and leaves alert state
 * untouched for this tick — the next 60s tick retries from a clean slate.
 */
/**
 * Flap control + lifecycle-only persistence.
 *
 * `alert_events` is an INCIDENT LIFECYCLE store, never a live-metric store.
 * Exactly three things write a row:
 *
 *   • INSERT   — an incident opens (after OPEN_STREAK consecutive breaches),
 *                carrying the opening snapshot of metric/threshold/sample.
 *   • UPDATE   — the severity of an open incident genuinely changes; the
 *                transition is appended to details.transitions.
 *   • UPDATE   — the incident resolves (after CLEAR_STREAK clear cycles),
 *                recording the final metric value.
 *
 * While an incident stays open at the same severity NOTHING is written —
 * no periodic metric_value / sample_size refresh. The live/current value for
 * the Super Admin panel comes from the Live Monitoring collector read path,
 * not from re-writing this table every cycle.
 *
 * Webhook delivery columns are written only by the dispatcher, and only when
 * an attempt actually happened or the delivery status actually changed.
 *
 * State is a Map keyed by rule id, so it is bounded by the number of rules.
 * A restart simply re-earns the streaks; it never loses an incident, which
 * lives in `alert_events`.
 */
let OPEN_STREAK = 3;
let CLEAR_STREAK = 3;

interface FlapState {
  breach: number;
  clear: number;
}

const flapState = new Map<string, FlapState>();

function stateFor(ruleId: string): FlapState {
  let s = flapState.get(ruleId);
  if (!s) {
    s = { breach: 0, clear: 0 };
    flapState.set(ruleId, s);
  }
  return s;
}

export function __resetAlertFlapStateForTests(): void {
  flapState.clear();
  OPEN_STREAK = 3;
  CLEAR_STREAK = 3;
}

/** Lets the existing golden tests assert single-tick semantics unchanged. */
export function __setAlertFlapTuningForTests(t: { open?: number; clear?: number; touchDelta?: number }): void {
  if (t.open !== undefined) OPEN_STREAK = t.open;
  if (t.clear !== undefined) CLEAR_STREAK = t.clear;
  // touchDelta is accepted for backwards compatibility only — same-severity
  // "still breaching" writes no longer exist at all.
}


async function applyRuleResult(
  sb: ReturnType<typeof getServiceClient>,
  rule: AlertRuleRow,
  result: RuleEvalResult,
  now: Date,
  openIndex: OpenAlertIndex,
): Promise<boolean> {
  // Served from the pass-wide snapshot taken by loadOpenAlertIndex — no
  // per-rule round trip. Every branch below that writes also updates the
  // snapshot, so it stays truthful for the rest of the pass.
  const open: OpenAlertEventRow | null = openIndex.get(rule.id) ?? null;
  const flap = stateFor(rule.id);

  if (result.severity !== null) {
    flap.clear = 0;
    flap.breach += 1;

    if (!open) {
      // Debounce: wait for a sustained breach before creating an incident.
      if (flap.breach < OPEN_STREAK) return false;
      const insertPayload = {
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
          // Opening snapshot — immutable evidence of why the incident opened.
          opened: {
            at: now.toISOString(),
            severity: result.severity,
            metric_value: result.value,
            threshold_value: result.threshold,
            sample_size: result.sample,
          },
        },
        webhook_status: 'pending',
      };
      const { data: insertedRow, error: insertError } = await sb
        .from('alert_events')
        .insert(insertPayload)
        .select('id')
        .single();
      if (insertError) {
        throw new Error(`alertEvaluator: failed to open alert for rule "${rule.slug}": ${insertError.message}`);
      }
      openIndex.set(rule.id, {
        id: (insertedRow as { id: string } | null)?.id ?? '',
        rule_id: rule.id,
        rule_slug: rule.slug,
        severity: result.severity,
        metric_value: result.value,
        threshold_value: result.threshold,
        sample_size: result.sample,
        details: insertPayload.details,
        fired_at: now.toISOString(),
      });
      return true;
    }
    if (open.severity !== result.severity) {
      // Severity escalation/de-escalation updates the SAME incident and
      // records a snapshot of the transition for the audit trail.
      const baseDetails = (open.details && typeof open.details === 'object' ? open.details : {}) as Record<string, unknown>;
      const priorTransitions = Array.isArray((baseDetails as any).transitions) ? ((baseDetails as any).transitions as unknown[]) : [];
      const severityDetails = {
        ...baseDetails,
        transitions: [
          ...priorTransitions.slice(-MAX_TRANSITIONS + 1),
          {
            at: now.toISOString(),
            from_severity: open.severity,
            to_severity: result.severity,
            metric_value: result.value,
            threshold_value: result.threshold,
            sample_size: result.sample,
          },
        ],
      };
      const { error: severityError } = await sb
        .from('alert_events')
        .update({
          severity: result.severity,
          metric_value: result.value,
          threshold_value: result.threshold,
          sample_size: result.sample,
          details: severityDetails,
          webhook_status: 'pending',
        })
        .eq('id', open.id);
      if (severityError) {
        throw new Error(`alertEvaluator: failed to change severity for rule "${rule.slug}" (alert ${open.id}): ${severityError.message}`);
      }
      // The incident stays open under the same id — refresh it in place so a
      // later combined rule still counts it, now at the new severity.
      const priorEntry = openIndex.get(rule.id);
      if (priorEntry) {
        openIndex.set(rule.id, {
          ...priorEntry,
          severity: result.severity,
          metric_value: result.value,
          threshold_value: result.threshold,
          sample_size: result.sample,
          details: severityDetails,
        });
      }
      return true;
    }
    // Still breaching at the same severity: the incident is already recorded
    // and nothing about its lifecycle changed. Deliberately NO write — the
    // current metric value is served from the Live Monitoring collector.
    return false;
  }

  flap.breach = 0;

  if (open) {
    flap.clear += 1;
    // Hysteresis: a single clear sample is not a recovery.
    if (flap.clear < CLEAR_STREAK) return false;
    const baseDetails = (open.details && typeof open.details === 'object' ? open.details : {}) as Record<string, unknown>;
    const { error: resolveError } = await sb
      .from('alert_events')
      .update({
        state: 'resolved',
        severity: 'resolved',
        resolved_at: now.toISOString(),
        metric_value: result.value,
        sample_size: result.sample,
        details: {
          ...baseDetails,
          resolved: {
            at: now.toISOString(),
            metric_value: result.value,
            sample_size: result.sample,
          },
        },
        webhook_status: 'pending',
      })
      .eq('id', open.id);
    if (resolveError) {
      throw new Error(`alertEvaluator: failed to resolve alert for rule "${rule.slug}" (alert ${open.id}): ${resolveError.message}`);
    }
    // No longer open: a combined rule running later this pass must stop
    // counting it, exactly as a re-query of the table would have.
    openIndex.delete(rule.id);
    flap.clear = 0;
    return true;
  }
  flap.clear = 0;
  return false;

}


export async function evaluateAlertRulesInMemory(config: ServerConfig): Promise<EvaluateAlertRulesResult> {
  const sb = getServiceClient(config);
  const collector = getMonitoringCollector();
  const now = new Date();

  const { data: settingsRow, error: settingsError } = await sb
    .from('widget_platform_settings')
    .select('perf_memory_budget_mb')
    .limit(1)
    .maybeSingle();
  // Not a state-affecting read (no alert open/resolve depends on it) — a
  // failure here safely falls back to the default budget rather than
  // aborting the whole cycle, but must not pass silently either.
  if (settingsError) {
    console.error('[alertEvaluator] failed to read perf_memory_budget_mb, using default budget:', settingsError.message);
  }
  const budgetBytes = (Number((settingsRow as any)?.perf_memory_budget_mb) || 512) * 1024 * 1024;

  const { data: rules, error: rulesError } = await sb.from('alert_rules').select('*').eq('enabled', true);
  if (rulesError) throw new Error(rulesError.message);

  let evaluated = 0;
  let stateChanges = 0;

  // Two-phase evaluation: base/ordinary rules always run (and persist their
  // alert_events writes) before any combined rule, regardless of the DB
  // row order alert_rules happens to return. Combined rules inspect
  // *persisted* open child alerts, so evaluating one before its children
  // have been written this tick would read last tick's stale state instead
  // of the current one. Splitting into two ordered passes makes the result
  // independent of row order without needing a dependency graph.
  const allRules = (rules || []) as AlertRuleRow[];
  const orderedRules = [...allRules.filter((r) => r.kind !== 'combined'), ...allRules.filter((r) => r.kind === 'combined')];

  // One read of the open-incident set for the entire pass, mutated in place as
  // rules open, escalate and resolve. This is what keeps a cycle at a constant
  // number of queries instead of one per rule.
  const openIndex = await loadOpenAlertIndex(sb);

  for (const rule of orderedRules) {
    evaluated += 1;
    const result = rule.kind === 'combined' ? evaluateCombinedRule(rule, openIndex) : evaluateSyncRule(rule, collector, budgetBytes);
    const changed = await applyRuleResult(sb, rule, result, now, openIndex);
    if (changed) stateChanges += 1;
  }

  return { evaluated, state_changes: stateChanges, ran_at: now.toISOString() };
}
