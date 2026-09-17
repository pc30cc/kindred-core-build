/**
 * Phase 7.5 — Enforcement engine.
 *
 * Reads enforcement_rules and converts them into reversible auto-action
 * activations. Reuses the existing auto_action_events store so that the
 * autoActionsCache (hot-path) and effective_policy resolver pick up
 * everything automatically — no second runtime path.
 *
 * Hard rules:
 *   • Read-only of rules / breaches / health. Writes only to
 *     auto_action_events + enforcement_actions audit.
 *   • Honors global kill switch (app_runtime_config.enforcement_kill_switch).
 *   • Honors dry-run mode (app_runtime_config.enforcement_dry_run) — logs
 *     the would-be action without inserting into auto_action_events.
 *   • Honors per-rule cooldown_seconds and a max_concurrent platform cap.
 *   • Idempotent: never starts a duplicate action while another from the
 *     same rule is already active.
 *   • Fail-open: never throws.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { emitLog } from './metrics.js';
import { forceRefreshAutoActionsCache } from './autoActionsCache.js';
import {
  resolveEnforcementConflicts,
  type RawEnforcementCandidate,
  type NormalizedEnforcementCandidate,
} from './enforcementConflictResolver.js';

type TriggerType = 'slo_breach' | 'health_score' | 'alert_rate';

export type EnforcementActionType =
  | 'disable_typing_temporarily'
  | 'force_polling_mode'
  | 'increase_reconnect_backoff'
  | 'mark_system_degraded'
  | 'throttle_new_conversations'
  | 'slow_mode_messages'
  | 'operator_load_shedding'
  | 'priority_only_mode';

interface EnforcementRule {
  id: string;
  slug: string;
  trigger_type: TriggerType;
  condition_json: Record<string, any>;
  actions_json: EnforcementActionType[];
  cooldown_seconds: number;
  ttl_seconds: number;
  enabled: boolean;
  priority: number;
}

export interface EnforcementCycleResult {
  evaluated: number;
  triggered: number;
  skipped_cooldown: number;
  skipped_kill_switch: boolean;
  skipped_max_concurrent: boolean;
  dry_run: boolean;
  normalized: boolean;
  ran_at: string;
}

export async function runEnforcementCycle(
  config: ServerConfig,
): Promise<EnforcementCycleResult> {
  const out: EnforcementCycleResult = {
    evaluated: 0,
    triggered: 0,
    skipped_cooldown: 0,
    skipped_kill_switch: false,
    skipped_max_concurrent: false,
    dry_run: false,
    normalized: false,
    ran_at: new Date().toISOString(),
  };

  try {
    const sb = getServiceClient(config);

    const { kill, dryRun, maxConcurrent } = await loadRuntimeFlags(config);
    out.dry_run = dryRun;
    if (kill) {
      out.skipped_kill_switch = true;
      emitLog(config, 'info', 'enforcement_kill_switch_active', {});
      return out;
    }

    // Concurrent active enforcement actions cap.
    const { count: activeCount } = await sb
      .from('auto_action_events')
      .select('id', { count: 'exact', head: true })
      .eq('state', 'active')
      .gt('expires_at', new Date().toISOString());

    if ((activeCount || 0) >= maxConcurrent) {
      out.skipped_max_concurrent = true;
      emitLog(config, 'warn', 'enforcement_max_concurrent_reached', {
        active: activeCount,
        max: maxConcurrent,
      });
      return out;
    }

    const { data: rules, error } = await sb
      .from('enforcement_rules')
      .select('*')
      .eq('enabled', true);
    if (error) {
      emitLog(config, 'warn', 'enforcement_rules_load_failed', { error: error.message });
      return out;
    }

    // Phase 7.6 — two-pass evaluation:
    //   1. Collect every (rule, action_type) candidate that matches AND
    //      is past cooldown.
    //   2. Run the conflict resolver to deduplicate and normalize.
    //   3. Apply only the normalized candidates.
    //
    // Sorting rules by priority DESC (then slug) here makes the cooldown
    // pass deterministic and gives the resolver a stable input order.
    const ruleList = ((rules || []) as EnforcementRule[]).sort((a, b) => {
      const pa = Number(a.priority ?? 100);
      const pb = Number(b.priority ?? 100);
      if (pa !== pb) return pb - pa;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });

    const ruleById = new Map<string, EnforcementRule>();
    const candidates: RawEnforcementCandidate[] = [];

    for (const rule of ruleList) {
      try {
        out.evaluated += 1;
        const matched = await evaluateRule(config, rule);
        if (!matched) continue;

        // Cooldown: latest enforcement_actions row for this rule.
        const { data: lastRow } = await sb
          .from('enforcement_actions')
          .select('created_at')
          .eq('rule_id', rule.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastRow) {
          const ageSec = (Date.now() - new Date(lastRow.created_at).getTime()) / 1000;
          if (ageSec < rule.cooldown_seconds) {
            out.skipped_cooldown += 1;
            continue;
          }
        }

        ruleById.set(rule.id, rule);
        for (const at of rule.actions_json || []) {
          candidates.push({
            rule_id: rule.id,
            rule_slug: rule.slug,
            rule_priority: Number(rule.priority ?? 100),
            action_type: at,
            scope_type: matched.scope_type,
            scope_key: matched.scope_key,
            trigger_payload: matched.trigger_payload,
          });
        }
      } catch (err: any) {
        emitLog(config, 'warn', 'enforcement_rule_threw', {
          slug: rule.slug,
          error: err?.message || 'unknown',
        });
      }
    }

    if (candidates.length === 0) {
      // Nothing to do.
      return out;
    }

    const resolution = resolveEnforcementConflicts(candidates);
    out.normalized = resolution.changed;

    // Audit any normalization that actually changed the set.
    if (resolution.changed) {
      try {
        await sb.from('enforcement_normalizations').insert({
          cycle_ran_at: out.ran_at,
          raw_actions: resolution.raw.map((c) => ({
            rule_slug: c.rule_slug,
            rule_priority: c.rule_priority,
            action_type: c.action_type,
          })),
          normalized_actions: resolution.normalized.map((n) => ({
            rule_slug: n.rule_slug,
            rule_priority: n.rule_priority,
            action_type: n.action_type,
            merged_with: n.merged_with,
            suppressed: n.suppressed,
            annotations: n.annotations,
          })),
          reasons: resolution.reasons,
          context: { cycle: 'enforcement' },
        });
      } catch (err: any) {
        emitLog(config, 'warn', 'enforcement_normalization_audit_failed', {
          error: err?.message,
        });
      }
    }

    // Apply normalized candidates honoring the live max_concurrent cap.
    let active = activeCount || 0;
    for (const cand of resolution.normalized) {
      if (active >= maxConcurrent) {
        out.skipped_max_concurrent = true;
        break;
      }
      const rule = ruleById.get(cand.rule_id);
      if (!rule) continue;
      const ok = await applyCandidate(config, rule, cand, dryRun);
      if (ok) {
        out.triggered += 1;
        if (!dryRun) active += 1;
      }
    }
  } catch (err: any) {
    emitLog(config, 'warn', 'enforcement_cycle_threw', { error: err?.message || 'unknown' });
  }

  if (out.triggered > 0) {
    emitLog(config, 'info', 'enforcement_cycle', out as unknown as Record<string, unknown>);
    void forceRefreshAutoActionsCache(config);
  }
  return out;
}

interface RuntimeFlags {
  kill: boolean;
  dryRun: boolean;
  maxConcurrent: number;
}

async function loadRuntimeFlags(config: ServerConfig): Promise<RuntimeFlags> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('app_runtime_config')
    .select('key, value')
    .in('key', ['enforcement_kill_switch', 'enforcement_dry_run', 'enforcement_max_concurrent']);
  let kill = false;
  let dryRun = false;
  let maxConcurrent = 5;
  for (const row of (data || []) as { key: string; value: any }[]) {
    if (row.key === 'enforcement_kill_switch') kill = !!row.value?.enabled;
    else if (row.key === 'enforcement_dry_run') dryRun = !!row.value?.enabled;
    else if (row.key === 'enforcement_max_concurrent') {
      const v = Number(row.value?.value);
      if (Number.isFinite(v) && v >= 1 && v <= 50) maxConcurrent = v;
    }
  }
  return { kill, dryRun, maxConcurrent };
}

interface RuleMatch {
  scope_type: string;
  scope_key: string;
  trigger_payload: Record<string, unknown>;
}

async function evaluateRule(
  config: ServerConfig,
  rule: EnforcementRule,
): Promise<RuleMatch | null> {
  const sb = getServiceClient(config);

  if (rule.trigger_type === 'slo_breach') {
    const sloSlug = String(rule.condition_json?.slo_slug || '');
    const minBreaches = Math.max(1, Number(rule.condition_json?.min_consecutive_breaches || 1));
    if (!sloSlug) return null;
    const { data } = await sb
      .from('slo_breach_events')
      .select('id, slo_slug, scope_type, scope_key, consecutive_breaches')
      .eq('slo_slug', sloSlug)
      .eq('state', 'open')
      .gte('consecutive_breaches', minBreaches)
      .order('last_breach_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    return {
      scope_type: data.scope_type,
      scope_key: data.scope_key,
      trigger_payload: {
        slo_slug: data.slo_slug,
        breach_event_id: data.id,
        consecutive_breaches: data.consecutive_breaches,
      },
    };
  }

  if (rule.trigger_type === 'health_score') {
    // The workspace_health_snapshots family was dropped from the database, so
    // there is no snapshot to compare a threshold against. Never firing is
    // the safe direction for an ENFORCEMENT rule: an auto-action that
    // suspends or throttles a workspace must not be triggered off an absent
    // signal that reads as "score 0". A rule left configured for this trigger
    // is inert until the source comes back.
    return null;
  }

  if (rule.trigger_type === 'alert_rate') {
    const minCritical = Math.max(1, Number(rule.condition_json?.min_critical_in_window || 5));
    const windowSec = Math.max(60, Number(rule.condition_json?.window_seconds || 600));
    const since = new Date(Date.now() - windowSec * 1000).toISOString();
    const { count } = await sb
      .from('alert_events')
      .select('id', { count: 'exact', head: true })
      .gte('fired_at', since)
      .eq('severity', 'critical');
    if ((count || 0) < minCritical) return null;
    return {
      scope_type: 'platform',
      scope_key: 'platform',
      trigger_payload: { critical_count: count, window_seconds: windowSec },
    };
  }

  return null;
}

/**
 * Apply ONE normalized candidate (single action_type owned by a rule).
 *   • locate the matching auto_action_definition (by action_type, builtin)
 *   • if dry-run, just record an enforcement_actions audit row
 *   • else insert a new auto_action_events row (state=active, expires_at=now+ttl)
 *     and a linked enforcement_actions audit row
 *
 * Skips silently if an active event of the same action_type already exists
 * — we never stack effects of the same kind.
 */
async function applyCandidate(
  config: ServerConfig,
  rule: EnforcementRule,
  cand: NormalizedEnforcementCandidate,
  dryRun: boolean,
): Promise<boolean> {
  const sb = getServiceClient(config);
  const actionType = cand.action_type;
  const match: RuleMatch = {
    scope_type: cand.scope_type,
    scope_key: cand.scope_key,
    trigger_payload: cand.trigger_payload,
  };
  try {
      // Lookup definition (prefer enabled built-in for that action type).
      const { data: defs } = await sb
        .from('auto_action_definitions')
        .select('id, slug, max_duration_seconds')
        .eq('action_type', actionType)
        .order('is_builtin', { ascending: false })
        .limit(1);
      const def = (defs || [])[0];
      if (!def) {
        emitLog(config, 'warn', 'enforcement_no_definition', {
          rule: rule.slug,
          action_type: actionType,
        });
        return false;
      }

      // Skip if a same-type action is already active.
      const { data: alreadyActive } = await sb
        .from('auto_action_events')
        .select('id')
        .eq('action_type', actionType)
        .eq('state', 'active')
        .gt('expires_at', new Date().toISOString())
        .limit(1);
      if ((alreadyActive || []).length > 0) {
        // Still record the audit so operators can see the rule "tried".
        await sb.from('enforcement_actions').insert({
          rule_id: rule.id,
          rule_slug: rule.slug,
          trigger_type: rule.trigger_type,
          trigger_payload: { ...match.trigger_payload, skipped: 'already_active' },
          scope_type: match.scope_type,
          scope_key: match.scope_key,
          dry_run: dryRun,
        });
        return false;
      }

      if (dryRun) {
        await sb.from('enforcement_actions').insert({
          rule_id: rule.id,
          rule_slug: rule.slug,
          trigger_type: rule.trigger_type,
          trigger_payload: {
            ...match.trigger_payload,
            dry_run: true,
            action_type: actionType,
            merged_with: cand.merged_with,
            suppressed: cand.suppressed,
            annotations: cand.annotations,
          },
          scope_type: match.scope_type,
          scope_key: match.scope_key,
          dry_run: true,
        });
        emitLog(config, 'info', 'enforcement_dry_run', {
          rule: rule.slug,
          action_type: actionType,
        });
        return true;
      }

      // TTL — clamped to the definition's max_duration_seconds.
      const ttlSec = Math.min(
        rule.ttl_seconds,
        def.max_duration_seconds || rule.ttl_seconds,
      );
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSec * 1000);

      const { data: inserted, error: insertErr } = await sb
        .from('auto_action_events')
        .insert({
          definition_id: def.id,
          action_slug: def.slug,
          action_type: actionType,
          trigger_rule_slug: rule.slug,
          trigger_severity: 'critical',
          state: 'active',
          started_at: now.toISOString(),
          expires_at: expiresAt.toISOString(),
          details: {
            source: 'enforcement_engine',
            rule_slug: rule.slug,
            trigger_type: rule.trigger_type,
            scope_type: match.scope_type,
            scope_key: match.scope_key,
            trigger_payload: match.trigger_payload,
            rule_priority: cand.rule_priority,
            merged_with: cand.merged_with,
            suppressed: cand.suppressed,
            annotations: cand.annotations,
          },
        })
        .select('id')
        .maybeSingle();

      if (insertErr || !inserted) {
        emitLog(config, 'warn', 'enforcement_action_insert_failed', {
          rule: rule.slug,
          action_type: actionType,
          error: insertErr?.message,
        });
        return false;
      }

      await sb.from('enforcement_actions').insert({
        rule_id: rule.id,
        rule_slug: rule.slug,
        trigger_type: rule.trigger_type,
        trigger_payload: {
          ...match.trigger_payload,
          action_type: actionType,
          ttl_seconds: ttlSec,
          rule_priority: cand.rule_priority,
          merged_with: cand.merged_with,
          suppressed: cand.suppressed,
          annotations: cand.annotations,
        },
        auto_action_event_id: inserted.id,
        scope_type: match.scope_type,
        scope_key: match.scope_key,
        dry_run: false,
      });

      emitLog(config, 'info', 'enforcement_action_applied', {
        rule: rule.slug,
        action_type: actionType,
        scope_type: match.scope_type,
        scope_key: match.scope_key,
        ttl_seconds: ttlSec,
        rule_priority: cand.rule_priority,
      });
      return true;
  } catch (err: any) {
    emitLog(config, 'warn', 'enforcement_action_threw', {
      rule: rule.slug,
      action_type: actionType,
      error: err?.message,
    });
    return false;
  }
}
