/**
 * Follow-up 9F.1 — pure-evaluator characterization of the closed
 * topic_detected Routing condition contract (Follow-up 9F audit ->
 * closed decisions): canonical {topic}, legacy-compat {topic_slug} and
 * historical single-element {topic_slugs}, and the strict fail-closed
 * dormancy rules for everything else (missing/invalid/ambiguous/
 * unsupported/extra-key conditions never broaden to "match any detected
 * topic").
 *
 * Drives server/services/ai-agent/runtime/routingRuntime.ts's
 * evaluateRoutingRules() directly — pure function, no engine mocking.
 */
import { describe, it, expect } from 'vitest';
import { evaluateRoutingRules } from '../../../server/services/ai-agent/runtime/routingRuntime.js';
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

function topicRule(conditions_json: Record<string, unknown>, overrides: Record<string, any> = {}) {
  return {
    id: 'rule-1',
    name: 'Topic rule',
    trigger_type: 'topic_detected',
    conditions_json,
    action_type: 'handoff',
    action_json: {},
    priority: 1,
    enabled: true,
    ...overrides,
  } as any;
}

function detected(...slugs: string[]) {
  return slugs.map((slug) => ({ slug, name: slug, confidence: 0.9, matchedKeywords: [] })) as any;
}

function runtimeConfigWith(rules: any[]) {
  return { routingRules: rules } as any;
}

function expectDormant(result: ReturnType<typeof evaluateRoutingRules>, ruleId: string, reason?: string) {
  expect(result.matchedRuleIds).not.toContain(ruleId);
  expect(result.matchedRuleNames).not.toContain('Topic rule');
  const action = result.actions.find((a) => a.sourceId === ruleId);
  expect(action).toBeTruthy();
  expect(action?.type).toBe('skip');
  expect(action?.executed).toBe(false);
  if (reason) expect(action?.skippedReason).toBe(reason);
}

function expectMatched(result: ReturnType<typeof evaluateRoutingRules>, ruleId: string) {
  expect(result.matchedRuleIds).toContain(ruleId);
  const action = result.actions.find((a) => a.sourceId === ruleId);
  expect(action?.type).toBe('handoff');
  expect(action?.executed).toBe(true);
}

describe('9F.1 — topic_detected: valid canonical/compatibility shapes', () => {
  it('TOPIC1 — {topic:"billing"} matches billing', () => {
    const ctx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic: 'billing' })]) });
    expectMatched(evaluateRoutingRules(ctx), 'rule-1');
  });

  it.each(['pricing', 'sales', 'support', 'technical'])('TOPIC2 — {topic:"billing"} does NOT match %s', (slug) => {
    const ctx = baseCtx({ detectedTopics: detected(slug), runtimeConfig: runtimeConfigWith([topicRule({ topic: 'billing' })]) });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).not.toContain('rule-1');
    // A non-matching (but validly-shaped) condition is a plain non-match,
    // not a dormant/skip entry.
    expect(result.actions.find((a) => a.sourceId === 'rule-1')).toBeUndefined();
  });

  it('TOPIC3 — {topic_slug:"billing"} matches billing only', () => {
    const matchCtx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic_slug: 'billing' })]) });
    expectMatched(evaluateRoutingRules(matchCtx), 'rule-1');
    const noMatchCtx = baseCtx({ detectedTopics: detected('pricing'), runtimeConfig: runtimeConfigWith([topicRule({ topic_slug: 'billing' })]) });
    expect(evaluateRoutingRules(noMatchCtx).matchedRuleIds).not.toContain('rule-1');
  });

  it('TOPIC4 — {topic_slugs:["billing"]} matches billing only (narrow historical compatibility)', () => {
    const matchCtx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic_slugs: ['billing'] })]) });
    expectMatched(evaluateRoutingRules(matchCtx), 'rule-1');
    const noMatchCtx = baseCtx({ detectedTopics: detected('pricing'), runtimeConfig: runtimeConfigWith([topicRule({ topic_slugs: ['billing'] })]) });
    expect(evaluateRoutingRules(noMatchCtx).matchedRuleIds).not.toContain('rule-1');
  });
});

describe('9F.1 — topic_detected: dormant / fail-closed shapes', () => {
  it('TOPIC5 — {topic_slugs:["billing","sales"]} is dormant, not multi-match', () => {
    const ctx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic_slugs: ['billing', 'sales'] })]) });
    expectDormant(evaluateRoutingRules(ctx), 'rule-1', 'unsupported_condition:topic_slugs_multi');
  });

  it('TOPIC6 — {} is dormant and does not match even when detectedTopics is non-empty', () => {
    const ctx = baseCtx({ detectedTopics: detected('billing', 'pricing'), runtimeConfig: runtimeConfigWith([topicRule({})]) });
    expectDormant(evaluateRoutingRules(ctx), 'rule-1', 'missing_condition:topic');
  });

  it('TOPIC7 — {topic:null} is dormant', () => {
    const ctx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic: null })]) });
    expectDormant(evaluateRoutingRules(ctx), 'rule-1', 'invalid_condition:topic');
  });

  it('TOPIC8 — {topic:""} and whitespace-only {topic:" "} are dormant', () => {
    const blankCtx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic: '' })]) });
    expectDormant(evaluateRoutingRules(blankCtx), 'rule-1', 'invalid_condition:topic');
    const whitespaceCtx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic: ' ' })]) });
    expectDormant(evaluateRoutingRules(whitespaceCtx), 'rule-1', 'invalid_condition:topic');
  });

  it('TOPIC9 — {topic:123} is dormant', () => {
    const ctx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic: 123 })]) });
    expectDormant(evaluateRoutingRules(ctx), 'rule-1', 'invalid_condition:topic');
  });

  it('TOPIC9b — {topic_slug:null}, {topic_slug:""}, {topic_slug:123} are dormant', () => {
    for (const v of [null, '', 123]) {
      const ctx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic_slug: v })]) });
      expectDormant(evaluateRoutingRules(ctx), 'rule-1', 'invalid_condition:topic_slug');
    }
  });

  it('TOPIC10 — {topic_slugs:[]} is dormant', () => {
    const ctx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic_slugs: [] })]) });
    expectDormant(evaluateRoutingRules(ctx), 'rule-1', 'invalid_condition:topic_slugs');
  });

  it('TOPIC11 — {topic_slugs:"billing"} (string, not array) is dormant', () => {
    const ctx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic_slugs: 'billing' as any })]) });
    expectDormant(evaluateRoutingRules(ctx), 'rule-1', 'invalid_condition:topic_slugs');
  });

  it('TOPIC11b — {topic_slugs:[123]} and {topic_slugs:[""]} are dormant', () => {
    const numCtx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic_slugs: [123] })]) });
    expectDormant(evaluateRoutingRules(numCtx), 'rule-1', 'invalid_condition:topic_slugs');
    const blankCtx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic_slugs: [''] })]) });
    expectDormant(evaluateRoutingRules(blankCtx), 'rule-1', 'invalid_condition:topic_slugs');
  });

  it('TOPIC12 — mixed {topic, topic_slug} is dormant even when values AGREE', () => {
    const ctx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic: 'billing', topic_slug: 'billing' })]) });
    expectDormant(evaluateRoutingRules(ctx), 'rule-1', 'ambiguous_condition:topic_filter_keys');
  });

  it('TOPIC13 — mixed {topic, topic_slug} is dormant when values CONFLICT', () => {
    const ctx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic: 'billing', topic_slug: 'sales' })]) });
    expectDormant(evaluateRoutingRules(ctx), 'rule-1', 'ambiguous_condition:topic_filter_keys');
  });

  it('TOPIC14 — mixed {topic, topic_slugs} is dormant', () => {
    const ctx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic: 'billing', topic_slugs: ['billing'] })]) });
    expectDormant(evaluateRoutingRules(ctx), 'rule-1', 'ambiguous_condition:topic_filter_keys');
  });

  it('TOPIC14b — mixed {topic_slug, topic_slugs} is dormant', () => {
    const ctx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic_slug: 'billing', topic_slugs: ['billing'] })]) });
    expectDormant(evaluateRoutingRules(ctx), 'rule-1', 'ambiguous_condition:topic_filter_keys');
  });

  it('TOPIC15 — unknown-only {foo:"bar"} is dormant', () => {
    const ctx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ foo: 'bar' })]) });
    expectDormant(evaluateRoutingRules(ctx), 'rule-1', 'unsupported_condition:foo');
  });

  it('TOPIC16 — valid {topic} plus an unknown extra condition key is dormant', () => {
    const ctx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([topicRule({ topic: 'billing', foo: true })]) });
    expectDormant(evaluateRoutingRules(ctx), 'rule-1', 'unsupported_condition:foo');
  });
});

describe('9F.1 — historical Billing seed regression (Follow-up 9F audit -> 9F.1 fix)', () => {
  // The literal semantic shape from
  // supabase/migrations/20260504091511_..._.sql's 'Billing topic → handoff'
  // seed row (trigger_type='topic_detected', conditions_json:{topic_slugs:
  // ['billing']}, action_type='handoff', priority 20, enabled true). This
  // migration file itself is untouched (Follow-up 9F.1 forbids editing it)
  // — this test proves the runtime now makes that exact persisted shape
  // safe without any data migration.
  function seedRule() {
    return topicRule({ topic_slugs: ['billing'] }, {
      id: 'seed-billing', name: 'Billing topic → handoff',
      action_type: 'handoff', action_json: { reason: 'billing_topic', department: 'billing' },
      priority: 20, enabled: true,
    });
  }

  it('SEED1 — billing detected -> rule matches / handoff action produced', () => {
    const ctx = baseCtx({ detectedTopics: detected('billing'), runtimeConfig: runtimeConfigWith([seedRule()]) });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).toContain('seed-billing');
    expect(result.hardHandoff).toBe(true);
    const action = result.actions.find((a) => a.sourceId === 'seed-billing');
    expect(action?.type).toBe('handoff');
    expect(action?.executed).toBe(true);
  });

  it('SEED2 — pricing detected -> no match', () => {
    const ctx = baseCtx({ detectedTopics: detected('pricing'), runtimeConfig: runtimeConfigWith([seedRule()]) });
    const result = evaluateRoutingRules(ctx);
    expect(result.matchedRuleIds).not.toContain('seed-billing');
    expect(result.hardHandoff).toBe(false);
  });

  it('SEED3 — sales detected -> no match', () => {
    const ctx = baseCtx({ detectedTopics: detected('sales'), runtimeConfig: runtimeConfigWith([seedRule()]) });
    expect(evaluateRoutingRules(ctx).matchedRuleIds).not.toContain('seed-billing');
  });

  it('SEED4 — technical detected -> no match', () => {
    const ctx = baseCtx({ detectedTopics: detected('technical'), runtimeConfig: runtimeConfigWith([seedRule()]) });
    expect(evaluateRoutingRules(ctx).matchedRuleIds).not.toContain('seed-billing');
  });

  it('support detected -> no match (not in the original bug report list but same class)', () => {
    const ctx = baseCtx({ detectedTopics: detected('support'), runtimeConfig: runtimeConfigWith([seedRule()]) });
    expect(evaluateRoutingRules(ctx).matchedRuleIds).not.toContain('seed-billing');
  });

  it('no topic detected -> no match', () => {
    const ctx = baseCtx({ detectedTopics: [], runtimeConfig: runtimeConfigWith([seedRule()]) });
    expect(evaluateRoutingRules(ctx).matchedRuleIds).not.toContain('seed-billing');
  });
});
