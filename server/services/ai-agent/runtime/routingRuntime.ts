/**
 * AI Agent — C2 Routing Rules runtime evaluator.
 *
 * Pure function: produces a list of RuntimeAction objects describing what
 * the engine should do. The engine is responsible for executing safe
 * side-effects (handoff, mark_priority, etc.). Planned actions are logged
 * but never executed in C2.
 *
 * Self-host only. No external API calls. No LLM calls.
 */
import type { RoutingRule } from '../runtimeConfig.js';
import type { RuntimeEvaluationContext, RuntimeAction } from './types.js';
import { readRuntimeFlags } from './conversationState.js';

const HUMAN_REQUEST_RE =
  /\b(operator|human|agent|representative|human agent|live agent)\b|وصل|انسان|پشتیبان|اپراتور|insan|destek|temsilci/i;

// Follow-up 9E series — the pre-strategy and post-strategy lifecycle phases
// evaluate structurally disjoint trigger-type allowlists (see
// evaluateRoutingRulesForTriggerTypes below). plan_limit/vip_customer are
// deliberately excluded from both — neither is wired to any live signal.
export const PRE_STRATEGY_ROUTING_TRIGGER_TYPES: ReadonlySet<string> = new Set([
  'human_request', 'topic_detected', 'language', 'business_hours',
]);
export const POST_STRATEGY_ROUTING_TRIGGER_TYPES: ReadonlySet<string> = new Set([
  'low_confidence', 'no_answer',
]);

// Recognized legacy/unimplemented condition keys per trigger type. Their
// presence — regardless of whether canonical keys are ALSO present — forces
// the rule dormant rather than silently ignoring the unsupported key
// (Follow-up 9E.1/9E.2).
const LOW_CONFIDENCE_UNSUPPORTED_KEYS = ['threshold', 'consecutive'] as const;
const NO_ANSWER_UNSUPPORTED_KEYS = ['max_attempts'] as const;

function unsupportedKeysPresent(cond: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.filter((k) => Object.prototype.hasOwnProperty.call(cond, k));
}

type ConfidenceBelowValidation =
  | { status: 'missing' }
  | { status: 'canonical'; threshold: number }
  | { status: 'invalid' };

/**
 * Canonical confidence_below validation (Follow-up 9E.2). A present-but-
 * malformed value (string/null/boolean/object/array/non-finite/out-of-range)
 * must never be silently reinterpreted as the 0.5 default — that default
 * applies ONLY when the key is genuinely absent.
 */
function validateConfidenceBelow(cond: Record<string, unknown>): ConfidenceBelowValidation {
  if (!Object.prototype.hasOwnProperty.call(cond, 'confidence_below')) return { status: 'missing' };
  const v = cond.confidence_below;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) {
    return { status: 'canonical', threshold: v };
  }
  return { status: 'invalid' };
}

// A flat (non-union) shape rather than a discriminated union — this repo
// compiles with strictNullChecks:false, under which TS does not reliably
// narrow `result.dormantReason` after an `if (!result.matched)` guard on a
// `{matched:true} | {matched:false; dormantReason?}` union. `dormantReason`
// simply stays undefined whenever the rule matched.
interface MatchResult { matched: boolean; dormantReason?: string; }
function match(ok: boolean): MatchResult { return { matched: ok }; }
function dormant(reason: string): MatchResult { return { matched: false, dormantReason: reason }; }

function safeRuleMatches(rule: RoutingRule, ctx: RuntimeEvaluationContext): MatchResult {
  try {
    return ruleMatches(rule, ctx);
  } catch {
    return { matched: false };
  }
}

function ruleMatches(rule: RoutingRule, ctx: RuntimeEvaluationContext): MatchResult {
  const cond = (rule.conditions_json as any) || {};
  switch (rule.trigger_type) {
    case 'human_request': {
      if (ctx.topTopic?.slug === 'human-request') return match(true);
      return match(HUMAN_REQUEST_RE.test(ctx.visitorText || ''));
    }
    case 'topic_detected': {
      const slug = cond.topic_slug || cond.topic;
      if (!slug) return match(ctx.detectedTopics.length > 0);
      return match(ctx.detectedTopics.some((t) => t.slug === slug));
    }
    case 'language': {
      const target = cond.language;
      if (!target) return match(false);
      return match(ctx.inputLanguage === target || ctx.responseLanguage === target);
    }
    case 'no_answer': {
      // Follow-up 9E.2 — reads the REAL final strategy.reason, populated by
      // the post-strategy caller (never the legacy {action:'handoff'} shape
      // built for Message Trigger/Workflow ai_no_answer hooks).
      const unsupported = unsupportedKeysPresent(cond, NO_ANSWER_UNSUPPORTED_KEYS);
      if (unsupported.length) return dormant(`unsupported_condition:${unsupported.join(',')}`);
      const r = ctx.answerStrategy?.reason;
      return match(r === 'no_kb_match' || r === 'no_kb_match_silent');
    }
    case 'low_confidence': {
      const unsupported = unsupportedKeysPresent(cond, LOW_CONFIDENCE_UNSUPPORTED_KEYS);
      if (unsupported.length) return dormant(`unsupported_condition:${unsupported.join(',')}`);
      // Deliberately NOT additionally gated on retrievalStrength==='weak' —
      // a conservative-style workspace can legitimately produce
      // reason='low_confidence' with retrievalStrength='medium'; `reason`
      // is decideStrategy()'s own single authoritative discriminant.
      if (ctx.answerStrategy?.reason !== 'low_confidence') return match(false);
      const validated = validateConfidenceBelow(cond);
      if (validated.status === 'invalid') return dormant('invalid_condition:confidence_below');
      const threshold = validated.status === 'canonical' ? validated.threshold : 0.5;
      const c = typeof ctx.answerStrategy?.confidence === 'number' ? ctx.answerStrategy!.confidence : null;
      return match(c !== null && c < threshold);
    }
    case 'plan_limit': {
      const r = ctx.answerStrategy?.reason || '';
      return match(/limit|rate|max_replies|credit/i.test(r));
    }
    case 'business_hours': {
      // Only 'outside_hours' (weekly schedule) and 'override_closed' (a
      // specific-date closure) mean "outside the configured business-hours
      // window". 'no_operators_online' is a distinct operator-presence
      // state and must not be conflated with this trigger (Follow-up 9C).
      const r = ctx.availabilityReason || '';
      return match(r === 'outside_hours' || r === 'override_closed');
    }
    case 'vip_customer':
      // Not yet wired — no canonical VIP/tier source of truth exists.
      return match(false);
    default:
      return match(false);
  }
}

export interface RoutingEvaluationResult {
  actions: RuntimeAction[];
  matchedRuleIds: string[];
  matchedRuleNames: string[];
  hardHandoff: boolean;
  keepAi: boolean;
}

/**
 * Evaluates routing rules in priority order. Produces RuntimeActions but does
 * NOT mutate the conversation. Engine executes safe actions afterwards.
 */
export function evaluateRoutingRules(ctx: RuntimeEvaluationContext): RoutingEvaluationResult {
  const actions: RuntimeAction[] = [];
  const matchedRuleIds: string[] = [];
  const matchedRuleNames: string[] = [];
  let hardHandoff = false;
  let keepAi = false;

  const rules = ctx.runtimeConfig?.routingRules || [];
  if (!rules.length) return { actions, matchedRuleIds, matchedRuleNames, hardHandoff, keepAi };

  const flags = readRuntimeFlags((ctx.conversationState as any)?._metadata);

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const result = safeRuleMatches(rule, ctx);
    if (!result.matched) {
      // Follow-up 9E.1/9E.2 — a dormant rule (unsupported/invalid condition
      // shape) is NOT matched and NEVER enters matchedRuleIds, but is still
      // observable as a truthful skip entry, not silently absent.
      if (result.dormantReason) {
        actions.push({
          type: 'skip', source: 'routing_rule', sourceId: rule.id, sourceName: rule.name,
          reason: rule.trigger_type, executed: false, skippedReason: result.dormantReason,
        });
        console.log('[ai-agent.runtime.routing] dormant', { id: rule.id, reason: result.dormantReason });
      }
      continue;
    }
    matchedRuleIds.push(rule.id);
    matchedRuleNames.push(rule.name);
    console.log('[ai-agent.runtime.routing] matched', { id: rule.id, name: rule.name, trigger: rule.trigger_type, action: rule.action_type });

    const action = rule.action_type;
    const payload = (rule.action_json as any) || {};

    if (action === 'handoff') {
      // Skip duplicate hard handoff if already sent on this conversation.
      if (flags.handoffSent) {
        actions.push({
          type: 'skip', source: 'routing_rule', sourceId: rule.id, sourceName: rule.name,
          reason: 'handoff_already_sent', executed: false, skippedReason: 'handoff_already_sent',
        });
        console.log('[ai-agent.runtime.routing] skipped', { id: rule.id, reason: 'handoff_already_sent' });
        continue;
      }
      hardHandoff = true;
      actions.push({
        type: 'handoff', source: 'routing_rule', sourceId: rule.id, sourceName: rule.name,
        reason: rule.trigger_type, payload, executed: true,
      });
      // Hard handoff wins — no further rules are evaluated for the same message.
      break;
    } else if (action === 'keep_ai') {
      // Follow-up 9E.2 — no_answer -> keep_ai is not a valid runtime
      // combination (there is no usable grounding to "keep the AI handling"
      // with). UI disabling alone is not sufficient since the API/DB can
      // still contain such a row (legacy data or a direct API call).
      if (rule.trigger_type === 'no_answer') {
        actions.push({
          type: 'skip', source: 'routing_rule', sourceId: rule.id, sourceName: rule.name,
          reason: rule.trigger_type, executed: false, skippedReason: 'unsupported_action_for_trigger:keep_ai',
        });
        console.log('[ai-agent.runtime.routing] skipped', { id: rule.id, reason: 'unsupported_action_for_trigger:keep_ai' });
        continue;
      }
      keepAi = true;
      actions.push({
        type: 'keep_ai', source: 'routing_rule', sourceId: rule.id, sourceName: rule.name,
        reason: rule.trigger_type, payload, executed: true,
      });
    } else if (action === 'mark_priority') {
      actions.push({
        type: 'mark_priority', source: 'routing_rule', sourceId: rule.id, sourceName: rule.name,
        reason: rule.trigger_type, payload, executed: true,
      });
    } else if (action === 'assign_team') {
      actions.push({
        type: 'assign_team_planned', source: 'routing_rule', sourceId: rule.id, sourceName: rule.name,
        reason: rule.trigger_type, payload, executed: false,
        skippedReason: 'team_assignment_not_supported',
      });
      console.log('[ai-agent.runtime.routing] planned', { id: rule.id, action: 'assign_team' });
    } else if (action === 'assign_operator') {
      actions.push({
        type: 'assign_operator_planned', source: 'routing_rule', sourceId: rule.id, sourceName: rule.name,
        reason: rule.trigger_type, payload, executed: false,
        skippedReason: 'operator_assignment_not_supported',
      });
      console.log('[ai-agent.runtime.routing] planned', { id: rule.id, action: 'assign_operator' });
    } else if (action === 'create_ticket') {
      actions.push({
        type: 'create_ticket_planned', source: 'routing_rule', sourceId: rule.id, sourceName: rule.name,
        reason: rule.trigger_type, payload, executed: false,
        skippedReason: 'ticket_module_not_enabled',
      });
      console.log('[ai-agent.runtime.routing] planned', { id: rule.id, action: 'create_ticket' });
    } else {
      actions.push({
        type: 'skip', source: 'routing_rule', sourceId: rule.id, sourceName: rule.name,
        reason: rule.trigger_type, executed: false, skippedReason: `unsupported_action:${action}`,
      });
      console.log('[ai-agent.runtime.routing] skipped', { id: rule.id, reason: `unsupported_action:${action}` });
    }
  }

  return { actions, matchedRuleIds, matchedRuleNames, hardHandoff, keepAi };
}

/**
 * Evaluates only rules whose trigger_type is in `allowedTypes`, delegating
 * to the unchanged evaluateRoutingRules() core so the match/action logic is
 * never duplicated (Follow-up 9E/9E.1/9E.2). Used to make the pre-strategy
 * and post-strategy lifecycle phases structurally disjoint — a
 * low_confidence/no_answer rule is never even iterated over at the
 * pre-strategy call site, rather than merely failing to match there.
 */
export function evaluateRoutingRulesForTriggerTypes(
  ctx: RuntimeEvaluationContext,
  allowedTypes: ReadonlySet<string>,
): RoutingEvaluationResult {
  const rules = ctx.runtimeConfig?.routingRules || [];
  const filtered = rules.filter((r) => allowedTypes.has(r.trigger_type));
  if (filtered.length === rules.length) return evaluateRoutingRules(ctx);
  const filteredCtx: RuntimeEvaluationContext = {
    ...ctx,
    runtimeConfig: ctx.runtimeConfig ? { ...ctx.runtimeConfig, routingRules: filtered } : ctx.runtimeConfig,
  };
  return evaluateRoutingRules(filteredCtx);
}

/**
 * Strict-KB applicability normalization (Follow-up 9E.1/9E.2 Blocker 5).
 * evaluateRoutingRules() stays pure and unaware of the strict-KB invariant —
 * it always reports keep_ai as matched+executed when the rule's own
 * condition is satisfied. This caller-side pass rewrites any keep_ai action
 * to a truthful skip whenever isStrictKbNoGrounding() is true, for BOTH the
 * pre-strategy and post-strategy results, so metadata never claims keep_ai
 * "executed" when its effect was actually blocked.
 */
export function applyStrictKbApplicability(
  result: RoutingEvaluationResult,
  strictBlocked: boolean,
): RoutingEvaluationResult {
  if (!strictBlocked || !result.keepAi) return result;
  const actions = result.actions.map((a) => {
    if (a.type === 'keep_ai' && a.executed) {
      return { ...a, type: 'skip' as const, executed: false, skippedReason: 'strict_kb_safety_block' };
    }
    return a;
  });
  return { ...result, actions, keepAi: false };
}

export function buildRoutingMetadata(result: RoutingEvaluationResult, phase?: 'pre_strategy' | 'post_strategy') {
  const tag = (a: ReturnType<typeof serializeAction>) => (phase ? { ...a, phase } : a);
  const executedActions = result.actions.filter((a) => a.executed).map(serializeAction).map(tag);
  const plannedActions = result.actions.filter((a) => !a.executed && a.type !== 'skip').map(serializeAction).map(tag);
  const skippedActions = result.actions.filter((a) => a.type === 'skip').map(serializeAction).map(tag);
  return {
    matchedRuleIds: result.matchedRuleIds,
    matchedRuleNames: result.matchedRuleNames,
    executedActions,
    plannedActions,
    skippedActions,
  };
}

export type RoutingMetadata = ReturnType<typeof buildRoutingMetadata>;

/** Merges pre-strategy and post-strategy routing metadata — never overwrite. */
export function mergeRoutingMetadata(pre: RoutingMetadata, post: RoutingMetadata): RoutingMetadata {
  return {
    matchedRuleIds: [...pre.matchedRuleIds, ...post.matchedRuleIds],
    matchedRuleNames: [...pre.matchedRuleNames, ...post.matchedRuleNames],
    executedActions: [...pre.executedActions, ...post.executedActions],
    plannedActions: [...pre.plannedActions, ...post.plannedActions],
    skippedActions: [...pre.skippedActions, ...post.skippedActions],
  };
}

function serializeAction(a: RuntimeAction) {
  return {
    type: a.type,
    source: a.source,
    sourceId: a.sourceId || null,
    sourceName: a.sourceName || null,
    reason: a.reason || null,
    payload: a.payload || null,
    executed: a.executed,
    skippedReason: a.skippedReason || null,
  };
}