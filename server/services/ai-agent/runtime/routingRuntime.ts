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

function ruleMatches(rule: RoutingRule, ctx: RuntimeEvaluationContext): boolean {
  const cond = (rule.conditions_json as any) || {};
  switch (rule.trigger_type) {
    case 'human_request': {
      if (ctx.topTopic?.slug === 'human-request') return true;
      return HUMAN_REQUEST_RE.test(ctx.visitorText || '');
    }
    case 'topic_detected': {
      const slug = cond.topic_slug || cond.topic;
      if (!slug) return ctx.detectedTopics.length > 0;
      return ctx.detectedTopics.some((t) => t.slug === slug);
    }
    case 'language': {
      const target = cond.language;
      if (!target) return false;
      return ctx.inputLanguage === target || ctx.responseLanguage === target;
    }
    case 'no_answer': {
      const a = ctx.answerStrategy?.action || '';
      return a === 'no_answer' || a === 'no_answer_silent';
    }
    case 'low_confidence': {
      const threshold = typeof cond.confidence_below === 'number' ? cond.confidence_below : 0.5;
      const c = typeof ctx.answerStrategy?.confidence === 'number' ? ctx.answerStrategy!.confidence : null;
      return c !== null && c < threshold;
    }
    case 'plan_limit': {
      const r = ctx.answerStrategy?.reason || '';
      return /limit|rate|max_replies|credit/i.test(r);
    }
    case 'business_hours': {
      // Only 'outside_hours' (weekly schedule) and 'override_closed' (a
      // specific-date closure) mean "outside the configured business-hours
      // window". 'no_operators_online' is a distinct operator-presence
      // state and must not be conflated with this trigger (Follow-up 9C).
      const r = ctx.availabilityReason || '';
      return r === 'outside_hours' || r === 'override_closed';
    }
    case 'vip_customer':
      // Not yet wired — no canonical VIP/tier source of truth exists.
      return false;
    default:
      return false;
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
    let matched = false;
    try {
      matched = ruleMatches(rule, ctx);
    } catch {
      matched = false;
    }
    if (!matched) continue;
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

export function buildRoutingMetadata(result: RoutingEvaluationResult) {
  const executedActions = result.actions.filter((a) => a.executed).map(serializeAction);
  const plannedActions = result.actions.filter((a) => !a.executed && a.type !== 'skip').map(serializeAction);
  const skippedActions = result.actions.filter((a) => a.type === 'skip').map(serializeAction);
  return {
    matchedRuleIds: result.matchedRuleIds,
    matchedRuleNames: result.matchedRuleNames,
    executedActions,
    plannedActions,
    skippedActions,
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