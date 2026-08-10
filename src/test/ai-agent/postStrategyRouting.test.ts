/**
 * Follow-up 9E.3 — pure-evaluator characterization of the post-strategy
 * Routing contract (low_confidence / no_answer trigger types), the
 * pre/post phase partition, the confidence_below validation contract, the
 * legacy-unsupported-condition dormancy contract, strict-KB applicability
 * normalization, and phase-tagged metadata merge.
 *
 * These tests drive server/services/ai-agent/runtime/routingRuntime.ts
 * directly with constructed RuntimeEvaluationContext fixtures — no engine
 * mocking needed, since the evaluator is a pure function.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateRoutingRules,
  evaluateRoutingRulesForTriggerTypes,
  applyStrictKbApplicability,
  buildRoutingMetadata,
  mergeRoutingMetadata,
  PRE_STRATEGY_ROUTING_TRIGGER_TYPES,
  POST_STRATEGY_ROUTING_TRIGGER_TYPES,
} from '../../../server/services/ai-agent/runtime/routingRuntime.js';
import type { RuntimeEvaluationContext } from '../../../server/services/ai-agent/runtime/types.js';
import { makeSettings } from './helpers/engineFixtures.js';

function baseCtx(overrides: Partial<RuntimeEvaluationContext> = {}): RuntimeEvaluationContext {
  return {
    workspaceId: 'ws-1',
    conversationId: 'conv-1',
    visitorMessageId: 'vmsg-1',
    visitorText: 'hello',
    inputLanguage: 'en',
    responseLanguage: 'en',
    topTopic: null,
    detectedTopics: [],
    settings: makeSettings() as any,
    runtimeConfig: null,
    conversationState: null,
    answerStrategy: null,
    availabilityReason: null,
    now: Date.now(),
    ...overrides,
  };
}

function rule(overrides: Record<string, any> = {}) {
  return {
    id: 'rule-1',
    name: 'Test rule',
    trigger_type: 'low_confidence',
    conditions_json: {},
    action_type: 'handoff',
    action_json: {},
    priority: 1,
    enabled: true,
    ...overrides,
  } as any;
}

function runtimeConfigWith(rules: any[]) {
  return { routingRules: rules } as any;
}

// ─── PHASE PARTITION ───────────────────────────────────────────────────────
describe('9E.3 — phase partition', () => {
  it('PRE allowlist evaluation never iterates a low_confidence/no_answer rule, even with a matching answerStrategy present', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([
        rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.9 }, action_type: 'handoff' }),
      ]),
    });
    const result = evaluateRoutingRulesForTriggerTypes(ctx, PRE_STRATEGY_ROUTING_TRIGGER_TYPES);
    expect(result.matchedRuleIds).not.toContain('lc-1');
    expect(result.hardHandoff).toBe(false);
    // Filtered out before evaluation -> not even a dormant skip entry.
    expect(result.actions.find((a) => a.sourceId === 'lc-1')).toBeUndefined();
  });

  it('POST allowlist evaluation never iterates a human_request/topic_detected/language/business_hours rule', () => {
    const ctx = baseCtx({
      visitorText: 'let me speak to an operator',
      runtimeConfig: runtimeConfigWith([
        rule({ id: 'hr-1', trigger_type: 'human_request', action_type: 'handoff' }),
      ]),
    });
    const result = evaluateRoutingRulesForTriggerTypes(ctx, POST_STRATEGY_ROUTING_TRIGGER_TYPES);
    expect(result.matchedRuleIds).not.toContain('hr-1');
    expect(result.actions.find((a) => a.sourceId === 'hr-1')).toBeUndefined();
  });

  it('plan_limit and vip_customer rules never match under either phase allowlist', () => {
    const ctx = baseCtx({
      runtimeConfig: runtimeConfigWith([
        rule({ id: 'pl-1', trigger_type: 'plan_limit', action_type: 'handoff' }),
        rule({ id: 'vip-1', trigger_type: 'vip_customer', action_type: 'handoff' }),
      ]),
    });
    const pre = evaluateRoutingRulesForTriggerTypes(ctx, PRE_STRATEGY_ROUTING_TRIGGER_TYPES);
    const post = evaluateRoutingRulesForTriggerTypes(ctx, POST_STRATEGY_ROUTING_TRIGGER_TYPES);
    expect(pre.matchedRuleIds).toEqual([]);
    expect(post.matchedRuleIds).toEqual([]);
  });

  it('a mixed rule set only evaluates the allowed subset per phase (both phases combined cover every enabled rule exactly once)', () => {
    const ctx = baseCtx({
      visitorText: 'talk to an operator',
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([
        rule({ id: 'hr-1', trigger_type: 'human_request', action_type: 'mark_priority' }),
        rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.9 }, action_type: 'mark_priority' }),
      ]),
    });
    const pre = evaluateRoutingRulesForTriggerTypes(ctx, PRE_STRATEGY_ROUTING_TRIGGER_TYPES);
    const post = evaluateRoutingRulesForTriggerTypes(ctx, POST_STRATEGY_ROUTING_TRIGGER_TYPES);
    expect(pre.matchedRuleIds).toEqual(['hr-1']);
    expect(post.matchedRuleIds).toEqual(['lc-1']);
  });
});

// ─── POST MATCH CONTRACT ────────────────────────────────────────────────────
describe('9E.3 — POST match contract: low_confidence', () => {
  it('matches when reason=low_confidence and confidence < confidence_below', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.2 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.5 } })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).toContain('lc-1');
  });

  it('does NOT match when confidence >= confidence_below', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.6 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.5 } })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).not.toContain('lc-1');
  });

  it('does NOT match when reason is not low_confidence, even with a qualifying confidence', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'no_kb_match', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.9 } })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).not.toContain('lc-1');
  });

  it('matches on reason=low_confidence with retrievalStrength irrelevant — is NOT additionally gated on retrievalStrength==="weak"', () => {
    // retrievalStrength is not even part of RuntimeEvaluationContext.answerStrategy —
    // this test documents that the evaluator has no access to it and cannot gate on it.
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.5 } })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).toContain('lc-1');
  });
});

describe('9E.3 — POST match contract: no_answer', () => {
  it('matches when reason=no_kb_match', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'no_kb_match', confidence: 0 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'na-1', trigger_type: 'no_answer' })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).toContain('na-1');
  });

  it('matches when reason=no_kb_match_silent', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'no_kb_match_silent', confidence: 0 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'na-1', trigger_type: 'no_answer' })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).toContain('na-1');
  });

  it('does NOT match on a legacy adapter-shaped {action:"handoff"} — only the real strategy.reason is read', () => {
    const ctx = baseCtx({
      // answerStrategy.action (legacy ai_no_answer adapter shape) is NOT the
      // discriminant; only .reason is. This context has no .reason set.
      answerStrategy: { action: 'handoff', confidence: 0 } as any,
      runtimeConfig: runtimeConfigWith([rule({ id: 'na-1', trigger_type: 'no_answer' })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).not.toContain('na-1');
  });

  it('does not match reason=low_confidence (mutual exclusivity with the low_confidence trigger)', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'na-1', trigger_type: 'no_answer' })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).not.toContain('na-1');
  });
});

// ─── CONFIDENCE_BELOW VALIDATION ────────────────────────────────────────────
describe('9E.3 — confidence_below validation', () => {
  it('missing key -> backward-compatible default 0.5', () => {
    const ctxMatch = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.4 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: {} })]),
    });
    expect(evaluateRoutingRules(ctxMatch).matchedRuleIds).toContain('lc-1');

    const ctxNoMatch = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.6 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: {} })]),
    });
    expect(evaluateRoutingRules(ctxNoMatch).matchedRuleIds).not.toContain('lc-1');
  });

  it('0 is a valid boundary value', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0 } })]),
    });
    // confidence(0) < confidence_below(0) is false -> never matches, but must
    // be treated as a VALID condition (not dormant/invalid).
    const result = evaluateRoutingRules(ctx);
    expect(result.actions.find((a) => a.sourceId === 'lc-1' && a.skippedReason === 'invalid_condition:confidence_below')).toBeUndefined();
  });

  it('1 is a valid boundary value and matches any sub-1 confidence', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.99 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { confidence_below: 1 } })]),
    });
    expect(evaluateRoutingRules(ctx).matchedRuleIds).toContain('lc-1');
  });

  it('0.5 is a valid value', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.3 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.5 } })]),
    });
    expect(evaluateRoutingRules(ctx).matchedRuleIds).toContain('lc-1');
  });

  it.each([
    ['string', '0.5'],
    ['null', null],
    ['negative', -0.1],
    ['greater than 1', 1.1],
    ['boolean', true],
    ['object', { x: 1 }],
    ['array', [0.5]],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('present-but-invalid confidence_below (%s) never matches and is reported dormant, never silently reinterpreted as 0.5', (_label, badValue) => {
    const ctx = baseCtx({
      // Even a confidence that WOULD match the 0.5 default must not match,
      // proving the value truly is not falling back to the default.
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { confidence_below: badValue } })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).not.toContain('lc-1');
    const skip = result.actions.find((a) => a.sourceId === 'lc-1');
    expect(skip?.type).toBe('skip');
    expect(skip?.executed).toBe(false);
    expect(skip?.skippedReason).toBe('invalid_condition:confidence_below');
  });
});

// ─── LEGACY UNSUPPORTED CONDITIONS ──────────────────────────────────────────
describe('9E.3 — legacy unsupported conditions force dormancy', () => {
  it('low_confidence: presence of "threshold" alone forces dormant', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { threshold: 0.5 } })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).not.toContain('lc-1');
    const skip = result.actions.find((a) => a.sourceId === 'lc-1');
    expect(skip?.skippedReason).toBe('unsupported_condition:threshold');
    expect(skip?.executed).toBe(false);
  });

  it('low_confidence: presence of "consecutive" alone forces dormant', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { consecutive: 2 } })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).not.toContain('lc-1');
    expect(result.actions.find((a) => a.sourceId === 'lc-1')?.skippedReason).toBe('unsupported_condition:consecutive');
  });

  it('low_confidence: both threshold AND consecutive present -> combined dormant reason', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { threshold: 0.55, consecutive: 2 } })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).not.toContain('lc-1');
    expect(result.actions.find((a) => a.sourceId === 'lc-1')?.skippedReason).toBe('unsupported_condition:threshold,consecutive');
  });

  it('low_confidence: canonical confidence_below PLUS an unsupported legacy key still remains dormant (never partially evaluated)', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.5, consecutive: 2 } })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).not.toContain('lc-1');
    expect(result.actions.find((a) => a.sourceId === 'lc-1')?.skippedReason).toBe('unsupported_condition:consecutive');
  });

  it('no_answer: presence of "max_attempts" forces dormant', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'no_kb_match', confidence: 0 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'na-1', trigger_type: 'no_answer', conditions_json: { max_attempts: 2 } })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).not.toContain('na-1');
    expect(result.actions.find((a) => a.sourceId === 'na-1')?.skippedReason).toBe('unsupported_condition:max_attempts');
  });

  it('a dormant rule never appears in matchedRuleIds/matchedRuleNames', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', name: 'Dormant rule', trigger_type: 'low_confidence', conditions_json: { threshold: 0.5 } })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).toEqual([]);
    expect(result.matchedRuleNames).toEqual([]);
  });
});

// ─── ACTION APPLICABILITY: no_answer -> keep_ai ─────────────────────────────
describe('9E.3 — no_answer -> keep_ai is not a valid runtime combination', () => {
  it('is rejected by the evaluator itself, not merely disabled in the UI — truthful skippedReason, keepAi stays false', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'no_kb_match', confidence: 0 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'na-keepai', trigger_type: 'no_answer', action_type: 'keep_ai' })]),
    });
    const result = evaluateRoutingRules(ctx);
    expect(result.keepAi).toBe(false);
    expect(result.matchedRuleIds).toContain('na-keepai'); // matched the condition...
    const action = result.actions.find((a) => a.sourceId === 'na-keepai');
    expect(action?.type).toBe('skip');
    expect(action?.executed).toBe(false);
    expect(action?.skippedReason).toBe('unsupported_action_for_trigger:keep_ai');
  });
});

// ─── STRICT-KB APPLICABILITY NORMALIZATION ──────────────────────────────────
describe('9E.3 — applyStrictKbApplicability', () => {
  it('rewrites an executed keep_ai action to a truthful skip when strictBlocked=true', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-keepai', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.5 }, action_type: 'keep_ai' })]),
    });
    const raw = evaluateRoutingRules(ctx);
    expect(raw.keepAi).toBe(true);
    const normalized = applyStrictKbApplicability(raw, true);
    expect(normalized.keepAi).toBe(false);
    const action = normalized.actions.find((a) => a.sourceId === 'lc-keepai');
    expect(action?.type).toBe('skip');
    expect(action?.executed).toBe(false);
    expect(action?.skippedReason).toBe('strict_kb_safety_block');
  });

  it('leaves the result unchanged when strictBlocked=false', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-keepai', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.5 }, action_type: 'keep_ai' })]),
    });
    const raw = evaluateRoutingRules(ctx);
    const normalized = applyStrictKbApplicability(raw, false);
    expect(normalized.keepAi).toBe(true);
    expect(normalized).toEqual(raw);
  });

  it('leaves a non-keep_ai result untouched even when strictBlocked=true', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'no_kb_match', confidence: 0 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'na-1', trigger_type: 'no_answer', action_type: 'handoff' })]),
    });
    const raw = evaluateRoutingRules(ctx);
    const normalized = applyStrictKbApplicability(raw, true);
    expect(normalized.hardHandoff).toBe(true);
    expect(normalized.actions.find((a) => a.sourceId === 'na-1')?.type).toBe('handoff');
  });
});

// ─── METADATA: phase tagging + merge ────────────────────────────────────────
describe('9E.3 — buildRoutingMetadata / mergeRoutingMetadata', () => {
  it('phase-tags every serialized action when a phase is provided', () => {
    const ctx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.5 }, action_type: 'mark_priority' })]),
    });
    const result = evaluateRoutingRules(ctx);
    const meta = buildRoutingMetadata(result, 'post_strategy');
    expect(meta.executedActions).toHaveLength(1);
    expect((meta.executedActions[0] as any).phase).toBe('post_strategy');
  });

  it('merges pre + post metadata without overwriting either side, across all 5 fields', () => {
    const preCtx = baseCtx({
      visitorText: 'talk to an operator',
      runtimeConfig: runtimeConfigWith([rule({ id: 'hr-1', name: 'Human req', trigger_type: 'human_request', action_type: 'mark_priority' })]),
    });
    const postCtx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-1', name: 'Low conf', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.5 }, action_type: 'mark_priority' })]),
    });
    const preResult = evaluateRoutingRulesForTriggerTypes(preCtx, PRE_STRATEGY_ROUTING_TRIGGER_TYPES);
    const postResult = evaluateRoutingRulesForTriggerTypes(postCtx, POST_STRATEGY_ROUTING_TRIGGER_TYPES);
    const merged = mergeRoutingMetadata(
      buildRoutingMetadata(preResult, 'pre_strategy'),
      buildRoutingMetadata(postResult, 'post_strategy'),
    );
    expect(merged.matchedRuleIds).toEqual(['hr-1', 'lc-1']);
    expect(merged.matchedRuleNames).toEqual(['Human req', 'Low conf']);
    expect(merged.executedActions).toHaveLength(2);
    expect((merged.executedActions[0] as any).phase).toBe('pre_strategy');
    expect((merged.executedActions[1] as any).phase).toBe('post_strategy');
  });

  it('a dormant/skipped rule never appears matched in the merged metadata even though it appears in skippedActions', () => {
    const postCtx = baseCtx({
      answerStrategy: { reason: 'low_confidence', confidence: 0.1 },
      runtimeConfig: runtimeConfigWith([rule({ id: 'lc-dormant', trigger_type: 'low_confidence', conditions_json: { threshold: 0.5 } })]),
    });
    const postResult = evaluateRoutingRulesForTriggerTypes(postCtx, POST_STRATEGY_ROUTING_TRIGGER_TYPES);
    const meta = buildRoutingMetadata(postResult, 'post_strategy');
    expect(meta.matchedRuleIds).not.toContain('lc-dormant');
    expect(meta.skippedActions.some((a: any) => a.sourceId === 'lc-dormant')).toBe(true);
  });
});
