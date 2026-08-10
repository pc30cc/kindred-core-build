/**
 * Phase 1B — C15: pure automation evaluators, tested directly and in
 * isolation (no engine, no mocking needed — all four modules covered here
 * are pure functions with zero IO). Engine-level stage-ordering for
 * automation-driven handoff/stop-AI is already covered by the C8 tests in
 * handoff.test.ts (routing hard-handoff, message-trigger-forced handoff,
 * workflow handoff and stop-AI all proven to terminate before the LLM
 * call there) — not duplicated here per the "no enormous end-to-end
 * permutations" instruction.
 */
import { describe, it, expect } from 'vitest';
import { detectTopics } from '../../../server/services/ai-agent/topics/detector.js';
import { evaluateRoutingRules } from '../../../server/services/ai-agent/runtime/routingRuntime.js';
import { evaluateMessageTriggers } from '../../../server/services/ai-agent/runtime/triggerRuntime.js';
import { evaluateInternalTools } from '../../../server/services/ai-agent/runtime/toolRuntime.js';
import { makeSettings, makeConversationState } from './helpers/engineFixtures.js';

function topic(overrides: Record<string, any> = {}) {
  return {
    id: 't1', workspace_id: 'ws-1', name: 'Pricing', description: null, slug: 'pricing',
    keywords: ['price', 'pricing', 'plan'], examples: [], language: null,
    confidence_threshold: 0.5, action: 'label_only', action_json: {}, enabled: true, system: false,
    created_at: '', updated_at: '',
    ...overrides,
  };
}

function evalCtx(overrides: Record<string, any> = {}) {
  return {
    workspaceId: 'ws-1',
    conversationId: 'conv-1',
    visitorMessageId: 'vmsg-1',
    visitorText: 'hello',
    inputLanguage: 'en',
    responseLanguage: 'en',
    topTopic: null,
    detectedTopics: [],
    settings: makeSettings(),
    runtimeConfig: null,
    conversationState: makeConversationState(),
    answerStrategy: null,
    now: Date.now(),
    ...overrides,
  };
}

describe('C15 — Topics: detectTopics()', () => {
  it('no match when no keyword/example overlap', () => {
    const r = detectTopics('what is the weather like today', [topic()]);
    expect(r.detectedTopics).toHaveLength(0);
  });

  it('matches on keyword overlap above threshold', () => {
    // Word-boundary matching (keywordHit) means "pricing" and "plan" must
    // appear as whole words, not substrings — "pricing plan" (singular)
    // gives 2 whole-word keyword hits, which alone qualifies a match via
    // the `kwHits >= 2` condition regardless of confidence_threshold.
    const r = detectTopics('what is your pricing plan', [topic()]);
    expect(r.detectedTopics).toHaveLength(1);
    expect(r.detectedTopics[0].slug).toBe('pricing');
    expect(r.detectedTopics[0].matchedKeywords).toEqual(expect.arrayContaining(['pricing', 'plan']));
  });

  it('returns multiple candidates sorted by confidence descending', () => {
    const weak = topic({ id: 't2', slug: 'weak', keywords: ['plan'], confidence_threshold: 0.1 });
    const strong = topic({ id: 't3', slug: 'strong', keywords: ['pricing', 'plan'], confidence_threshold: 0.1 });
    const r = detectTopics('what is your pricing plan', [weak, strong]);
    expect(r.detectedTopics.length).toBeGreaterThanOrEqual(2);
    expect(r.detectedTopics[0].confidence).toBeGreaterThanOrEqual(r.detectedTopics[1].confidence);
  });

  it('a disabled topic never matches', () => {
    const r = detectTopics('what are your pricing plans', [topic({ enabled: false })]);
    expect(r.detectedTopics).toHaveLength(0);
  });

  it('the built-in "human-request" topic slug is detected like any other configured topic (engine.ts treats slug==="human-request" specially, not this function)', () => {
    const humanRequest = topic({ id: 't-hr', slug: 'human-request', keywords: ['operator', 'speak to an operator'], confidence_threshold: 0.5 });
    const r = detectTopics('can I speak to an operator please', [humanRequest]);
    expect(r.detectedTopics[0]?.slug).toBe('human-request');
  });
});

describe('C15 — Routing: evaluateRoutingRules()', () => {
  it('no match returns hardHandoff=false, keepAi=false, no matched rules', () => {
    const r = evaluateRoutingRules(evalCtx());
    expect(r.matchedRuleIds).toHaveLength(0);
    expect(r.hardHandoff).toBe(false);
    expect(r.keepAi).toBe(false);
  });

  it('a matched human_request rule with action_type=handoff sets hardHandoff=true', () => {
    const ctx = evalCtx({
      visitorText: 'can I speak to an operator',
      runtimeConfig: { routingRules: [{ id: 'r1', name: 'Escalate', trigger_type: 'human_request', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: true }] },
    });
    const r = evaluateRoutingRules(ctx);
    expect(r.matchedRuleIds).toContain('r1');
    expect(r.hardHandoff).toBe(true);
  });

  it('action_type=keep_ai sets keepAi=true without forcing a handoff', () => {
    const ctx = evalCtx({
      visitorText: 'can I speak to an operator',
      runtimeConfig: { routingRules: [{ id: 'r2', name: 'Keep AI', trigger_type: 'human_request', conditions_json: {}, action_type: 'keep_ai', action_json: {}, priority: 1, enabled: true }] },
    });
    const r = evaluateRoutingRules(ctx);
    expect(r.matchedRuleIds).toContain('r2');
    expect(r.keepAi).toBe(true);
    expect(r.hardHandoff).toBe(false);
  });

  it('low_confidence trigger_type matches only when answerStrategy.confidence is below the configured threshold', () => {
    const rule = { id: 'r3', name: 'Low conf', trigger_type: 'low_confidence', conditions_json: { confidence_below: 0.5 }, action_type: 'mark_priority', action_json: {}, priority: 1, enabled: true };
    const noMatch = evaluateRoutingRules(evalCtx({ runtimeConfig: { routingRules: [rule] }, answerStrategy: { confidence: 0.9 } }));
    const match = evaluateRoutingRules(evalCtx({ runtimeConfig: { routingRules: [rule] }, answerStrategy: { confidence: 0.2 } }));
    expect(noMatch.matchedRuleIds).toHaveLength(0);
    expect(match.matchedRuleIds).toContain('r3');
  });

  it('business_hours matches on availabilityReason="outside_hours" (weekly schedule closed)', () => {
    const rule = { id: 'r5', name: 'Outside hours', trigger_type: 'business_hours', conditions_json: {}, action_type: 'mark_priority', action_json: {}, priority: 1, enabled: true };
    const r = evaluateRoutingRules(evalCtx({ runtimeConfig: { routingRules: [rule] }, availabilityReason: 'outside_hours' }));
    expect(r.matchedRuleIds).toContain('r5');
  });

  it('business_hours matches on availabilityReason="override_closed" (specific-date override)', () => {
    const rule = { id: 'r6', name: 'Override closed', trigger_type: 'business_hours', conditions_json: {}, action_type: 'mark_priority', action_json: {}, priority: 1, enabled: true };
    const r = evaluateRoutingRules(evalCtx({ runtimeConfig: { routingRules: [rule] }, availabilityReason: 'override_closed' }));
    expect(r.matchedRuleIds).toContain('r6');
  });

  it('business_hours does NOT match on availabilityReason="no_operators_online" — operator presence is a distinct availability state, not a business-hours closure', () => {
    const rule = { id: 'r7', name: 'No ops', trigger_type: 'business_hours', conditions_json: {}, action_type: 'mark_priority', action_json: {}, priority: 1, enabled: true };
    const r = evaluateRoutingRules(evalCtx({ runtimeConfig: { routingRules: [rule] }, availabilityReason: 'no_operators_online' }));
    expect(r.matchedRuleIds).toHaveLength(0);
  });

  it('business_hours does NOT match on availabilityReason="always_offline" or "disabled" — configuration states, not a live schedule closure', () => {
    const rule = { id: 'r8', name: 'Always offline', trigger_type: 'business_hours', conditions_json: {}, action_type: 'mark_priority', action_json: {}, priority: 1, enabled: true };
    const always = evaluateRoutingRules(evalCtx({ runtimeConfig: { routingRules: [rule] }, availabilityReason: 'always_offline' }));
    const disabled = evaluateRoutingRules(evalCtx({ runtimeConfig: { routingRules: [rule] }, availabilityReason: 'disabled' }));
    expect(always.matchedRuleIds).toHaveLength(0);
    expect(disabled.matchedRuleIds).toHaveLength(0);
  });

  it('business_hours does NOT match when within business hours or when availabilityReason is absent', () => {
    const rule = { id: 'r9', name: 'Within hours', trigger_type: 'business_hours', conditions_json: {}, action_type: 'mark_priority', action_json: {}, priority: 1, enabled: true };
    const within = evaluateRoutingRules(evalCtx({ runtimeConfig: { routingRules: [rule] }, availabilityReason: 'within_hours' }));
    const absent = evaluateRoutingRules(evalCtx({ runtimeConfig: { routingRules: [rule] } }));
    expect(within.matchedRuleIds).toHaveLength(0);
    expect(absent.matchedRuleIds).toHaveLength(0);
  });

  it('vip_customer still never matches — no canonical data source exists, unaffected by business_hours wiring', () => {
    const rule = { id: 'r10', name: 'VIP', trigger_type: 'vip_customer', conditions_json: {}, action_type: 'mark_priority', action_json: {}, priority: 1, enabled: true };
    const r = evaluateRoutingRules(evalCtx({ runtimeConfig: { routingRules: [rule] }, availabilityReason: 'outside_hours' }));
    expect(r.matchedRuleIds).toHaveLength(0);
  });

  it('a disabled routing rule never matches', () => {
    const ctx = evalCtx({
      visitorText: 'can I speak to an operator',
      runtimeConfig: { routingRules: [{ id: 'r4', name: 'Disabled', trigger_type: 'human_request', conditions_json: {}, action_type: 'handoff', action_json: {}, priority: 1, enabled: false }] },
    });
    const r = evaluateRoutingRules(ctx);
    expect(r.matchedRuleIds).toHaveLength(0);
  });
});

describe('C15 — Message Triggers: evaluateMessageTriggers()', () => {
  const events: Array<'visitor_first_message' | 'topic_detected' | 'human_requested'> = [
    'visitor_first_message', 'topic_detected', 'human_requested',
  ];

  it.each(events)('matches a trigger configured for the "%s" event', (eventType) => {
    const trig = { id: 'tg1', name: 'T', event_type: eventType, conditions_json: {}, action_type: 'send_message', action_json: { message: 'hello there' }, delay_seconds: 0, enabled: true };
    const r = evaluateMessageTriggers(evalCtx({ runtimeConfig: { messageTriggers: [trig] } }), eventType);
    expect(r.matchedTriggerIds).toContain('tg1');
  });

  it('does not match a trigger configured for a different event', () => {
    const trig = { id: 'tg2', name: 'T', event_type: 'human_requested', conditions_json: {}, action_type: 'send_message', action_json: { message: 'x' }, delay_seconds: 0, enabled: true };
    const r = evaluateMessageTriggers(evalCtx({ runtimeConfig: { messageTriggers: [trig] } }), 'visitor_first_message');
    expect(r.matchedTriggerIds).toHaveLength(0);
  });

  it('send_message action is reported as executed=true (engine performs the actual insertion)', () => {
    const trig = { id: 'tg3', name: 'T', event_type: 'visitor_first_message', conditions_json: {}, action_type: 'send_message', action_json: { message: 'hello there' }, delay_seconds: 0, enabled: true };
    const r = evaluateMessageTriggers(evalCtx({ runtimeConfig: { messageTriggers: [trig] } }), 'visitor_first_message');
    expect(r.executed).toHaveLength(1);
    expect(r.executed[0].type).toBe('reply_template');
  });

  it('start_workflow / assign / tag / internal_note actions are reported as planned, never executed', () => {
    const trig = { id: 'tg4', name: 'T', event_type: 'visitor_first_message', conditions_json: {}, action_type: 'start_workflow', action_json: {}, delay_seconds: 0, enabled: true };
    const r = evaluateMessageTriggers(evalCtx({ runtimeConfig: { messageTriggers: [trig] } }), 'visitor_first_message');
    expect(r.planned).toHaveLength(1);
    expect(r.executed).toHaveLength(0);
  });

  it('a trigger already recorded as executed for this conversation is skipped (run_once_per_conversation default)', () => {
    const trig = { id: 'tg5', name: 'T', event_type: 'visitor_first_message', conditions_json: {}, action_type: 'send_message', action_json: { message: 'hi' }, delay_seconds: 0, enabled: true };
    const ctx = evalCtx({
      runtimeConfig: { messageTriggers: [trig] },
      conversationState: makeConversationState({ _metadata: { ai_trigger_executed_ids: ['tg5'] } }),
    });
    const r = evaluateMessageTriggers(ctx, 'visitor_first_message');
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].skippedReason).toBe('duplicate_trigger');
    expect(r.executed).toHaveLength(0);
  });

  it('a topic_slug condition gates the match to the detected topic', () => {
    const trig = { id: 'tg6', name: 'T', event_type: 'topic_detected', conditions_json: { topic_slug: 'pricing' }, action_type: 'send_message', action_json: { message: 'x' }, delay_seconds: 0, enabled: true };
    const noMatch = evaluateMessageTriggers(evalCtx({ runtimeConfig: { messageTriggers: [trig] }, topTopic: { slug: 'support' } as any }), 'topic_detected');
    const match = evaluateMessageTriggers(evalCtx({ runtimeConfig: { messageTriggers: [trig] }, topTopic: { slug: 'pricing' } as any }), 'topic_detected');
    expect(noMatch.matchedTriggerIds).toHaveLength(0);
    expect(match.matchedTriggerIds).toContain('tg6');
  });
});

describe('C15 — Tools: evaluateInternalTools()', () => {
  it('an enabled, executable tool (handoff_to_operator) is reported as allowed and used', () => {
    const ctx = evalCtx({ runtimeConfig: { internalTools: [{ id: 'it1', name: 'handoff_to_operator', tool_type: 'internal', risk_level: 'low', enabled: true, config_json: {}, permissions_json: {} }] } });
    const r = evaluateInternalTools(ctx, [{ name: 'handoff_to_operator', source: 'routing_rule' }]);
    expect(r.allowedTools).toContain('handoff_to_operator');
    expect(r.usedTools).toContain('handoff_to_operator');
  });

  it('a not-enabled tool is skipped, never used', () => {
    const ctx = evalCtx({ runtimeConfig: { internalTools: [] } });
    const r = evaluateInternalTools(ctx, [{ name: 'handoff_to_operator' }]);
    expect(r.usedTools).toHaveLength(0);
    expect(r.skippedTools).toContain('handoff_to_operator');
  });

  it('a known but not-yet-wired tool (create_ticket) is planned, not executed', () => {
    const ctx = evalCtx({ runtimeConfig: { internalTools: [{ id: 'it2', name: 'create_ticket', tool_type: 'internal', risk_level: 'low', enabled: true, config_json: {}, permissions_json: {} }] } });
    const r = evaluateInternalTools(ctx, [{ name: 'create_ticket' }]);
    expect(r.plannedTools).toContain('create_ticket');
    expect(r.usedTools).toHaveLength(0);
  });

  it('a duplicate handoff_to_operator request is skipped once already sent', () => {
    const ctx = evalCtx({
      runtimeConfig: { internalTools: [{ id: 'it1', name: 'handoff_to_operator', tool_type: 'internal', risk_level: 'low', enabled: true, config_json: {}, permissions_json: {} }] },
      conversationState: makeConversationState({ _metadata: { ai_handoff_sent: true } }),
    });
    const r = evaluateInternalTools(ctx, [{ name: 'handoff_to_operator' }]);
    expect(r.usedTools).toHaveLength(0);
    expect(r.skippedTools).toContain('handoff_to_operator');
  });

  it('an unknown tool name is skipped, never blocked-and-executed', () => {
    const ctx = evalCtx({ runtimeConfig: { internalTools: [{ id: 'it3', name: 'delete_workspace', tool_type: 'internal', risk_level: 'high', enabled: true, config_json: {}, permissions_json: {} }] } });
    const r = evaluateInternalTools(ctx, [{ name: 'delete_workspace' }]);
    expect(r.usedTools).toHaveLength(0);
    expect(r.skippedTools).toContain('delete_workspace');
  });
});
