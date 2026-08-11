/**
 * Phase 1 characterization — C4/C5/C6/C7 (and the mode-decision slice of
 * C1): server/services/ai-agent/runtimePolicy.ts `decideRuntime()`.
 *
 * This is a pure function (settings + conversation state + operator
 * availability + visitor text in, a RuntimeDecision out — no IO). Per the
 * Phase 1 instructions ("test evaluators independently before testing
 * orchestration"), the full mode matrix is pinned here directly against the
 * real decision function with zero mocking, which is both more reliable and
 * far cheaper than driving every mode combination through the full engine.
 * A smaller number of true engine-integration tests (engineModes.test.ts)
 * separately prove the engine actually calls this function and acts on its
 * output correctly — this file is the exhaustive decision-matrix source of
 * truth.
 */
import { describe, it, expect } from 'vitest';
import { decideRuntime } from '../../../server/services/ai-agent/runtimePolicy.js';
import { makeSettings, makeConversationState, makeAvailability } from './helpers/engineFixtures.js';

function decide(overrides: {
  settings?: Record<string, any>;
  state?: Record<string, any>;
  availability?: Record<string, any>;
  visitorText?: string;
} = {}) {
  return decideRuntime({
    settings: makeSettings(overrides.settings) as any,
    state: makeConversationState(overrides.state) as any,
    availability: makeAvailability(overrides.availability) as any,
    visitorText: overrides.visitorText ?? 'how do I reset my password',
  });
}

describe('decideRuntime — disabled/off (C1 decision layer)', () => {
  it('skip disabled_or_off when enabled=false', () => {
    const d = decide({ settings: { enabled: false, mode: 'auto_reply_always' } });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('disabled_or_off');
  });

  it('skip disabled_or_off when mode=off even if enabled=true', () => {
    const d = decide({ settings: { enabled: true, mode: 'off' } });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('disabled_or_off');
  });

  it('fails closed (skip disabled_or_off) for an unrecognized mode value', () => {
    const d = decide({ settings: { enabled: true, mode: 'not_a_real_mode' as any } });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('disabled_or_off');
  });
});

describe('decideRuntime — human_request keyword precedence', () => {
  it('handoff wins over everything when a configured keyword is present, even in auto_reply_always', () => {
    const d = decide({
      settings: { mode: 'auto_reply_always', handoff_on_human_request: true, handoff_keywords: ['human', 'agent'] },
      visitorText: 'I want to talk to a human please',
    });
    expect(d.action).toBe('handoff');
    expect(d.reason).toBe('human_request');
  });

  it('does not handoff on keyword match when handoff_on_human_request=false', () => {
    const d = decide({
      settings: { mode: 'auto_reply_always', handoff_on_human_request: false, handoff_keywords: ['human'] },
      visitorText: 'connect me to a human',
    });
    expect(d.action).not.toBe('handoff');
  });

  it('keyword match is case-insensitive and substring-based (pinned as-is)', () => {
    const d = decide({
      settings: { handoff_keywords: ['Operator'] },
      visitorText: 'can I speak with an OPERATOR now',
    });
    expect(d.action).toBe('handoff');
  });
});

describe('decideRuntime — pending handoff', () => {
  it('skips while a handoff is pending and stop_on_handoff is not explicitly false', () => {
    const d = decide({
      settings: { stop_on_handoff: true },
      state: { pendingHandoffRequested: true },
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('pending_handoff');
  });

  it('does not skip for a pending handoff when stop_on_handoff=false', () => {
    const d = decide({
      settings: { stop_on_handoff: false, mode: 'auto_reply_always' },
      state: { pendingHandoffRequested: true },
    });
    expect(d.action).toBe('auto_reply');
  });
});

describe('decideRuntime — reply caps', () => {
  it('skip max_replies_reached at the per-conversation cap', () => {
    const d = decide({
      settings: { max_replies_per_conversation: 3 },
      state: { aiRepliesCountInConversation: 3 },
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('max_replies_reached');
  });

  it('does not cap one reply below the limit', () => {
    const d = decide({
      settings: { max_replies_per_conversation: 3, mode: 'auto_reply_always' },
      state: { aiRepliesCountInConversation: 2 },
    });
    expect(d.action).toBe('auto_reply');
  });

  it('skip rate_limited at the per-hour cap', () => {
    const d = decide({
      settings: { max_replies_per_hour: 20 },
      state: { aiRepliesInLastHour: 20 },
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('rate_limited');
  });

  it('max_auto_replies_per_conversation overrides max_replies_per_conversation when both are set', () => {
    const d = decide({
      settings: { max_replies_per_conversation: 10, max_auto_replies_per_conversation: 1 } as any,
      state: { aiRepliesCountInConversation: 1 },
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('max_replies_reached');
  });
});

describe('C4 — suggest_only', () => {
  it('always suggests, never auto-replies, regardless of availability', () => {
    const online = decide({ settings: { mode: 'suggest_only' }, availability: { state: 'online' } });
    const offline = decide({ settings: { mode: 'suggest_only' }, availability: { state: 'offline' } });
    expect(online.action).toBe('suggest');
    expect(online.canSuggest).toBe(true);
    expect(online.canAutoReply).toBe(false);
    expect(offline.action).toBe('suggest');
    expect(offline.reason).toBe('mode_suggest_only');
  });
});

describe('C5 — auto_reply_when_offline', () => {
  it('auto-replies when operators are offline', () => {
    const d = decide({ settings: { mode: 'auto_reply_when_offline' }, availability: { state: 'offline' } });
    expect(d.action).toBe('auto_reply');
    expect(d.reason).toBe('ok');
    expect(d.canAutoReply).toBe(true);
  });

  it('only suggests (does not auto-reply) when operators are online', () => {
    const d = decide({ settings: { mode: 'auto_reply_when_offline' }, availability: { state: 'online' } });
    expect(d.action).toBe('suggest');
    expect(d.reason).toBe('operators_online');
    expect(d.canAutoReply).toBe(false);
    expect(d.canSuggest).toBe(true);
  });
});

describe('C6 — auto_reply_until_human_joins', () => {
  it('auto-replies before any human participation', () => {
    const d = decide({
      settings: { mode: 'auto_reply_until_human_joins' },
      state: { hasHumanAgentReplied: false, aiState: null, humanTakeoverAt: null },
    });
    expect(d.action).toBe('auto_reply');
    expect(d.reason).toBe('ok');
  });

  it('stops auto-replying once a human agent has replied (suggest, since allow_suggestions_after_takeover defaults true)', () => {
    const d = decide({
      settings: { mode: 'auto_reply_until_human_joins' },
      state: { hasHumanAgentReplied: true },
    });
    expect(d.action).toBe('suggest');
    expect(d.reason).toBe('human_already_joined');
  });

  it('skips (not suggest) after human takeover when allow_suggestions_after_takeover=false', () => {
    const d = decide({
      settings: { mode: 'auto_reply_until_human_joins', allow_suggestions_after_takeover: false },
      state: { hasHumanAgentReplied: true },
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('human_already_joined');
  });

  it('treats aiState=human_active as takeover even without hasHumanAgentReplied', () => {
    const d = decide({
      settings: { mode: 'auto_reply_until_human_joins' },
      state: { hasHumanAgentReplied: false, aiState: 'human_active' },
    });
    expect(d.action).toBe('suggest');
    expect(d.reason).toBe('human_already_joined');
  });

  it('treats a set humanTakeoverAt as takeover on its own', () => {
    const d = decide({
      settings: { mode: 'auto_reply_until_human_joins' },
      state: { hasHumanAgentReplied: false, humanTakeoverAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(d.action).toBe('suggest');
    expect(d.reason).toBe('human_already_joined');
  });

  it('treats managedByAi=false + aiState=needs_human as takeover', () => {
    const d = decide({
      settings: { mode: 'auto_reply_until_human_joins' },
      state: { hasHumanAgentReplied: false, managedByAi: false, aiState: 'needs_human' },
    });
    expect(d.action).toBe('suggest');
    expect(d.reason).toBe('human_already_joined');
  });
});

describe('C7 — auto_reply_always', () => {
  it('auto-replies normally when no human has participated', () => {
    const d = decide({ settings: { mode: 'auto_reply_always' }, state: { hasHumanAgentReplied: false, aiState: null } });
    expect(d.action).toBe('auto_reply');
    expect(d.reason).toBe('ok');
  });

  it('pauses to suggest-only once a human has replied (pause_auto_reply_after_human_reply defaults true)', () => {
    const d = decide({ settings: { mode: 'auto_reply_always' }, state: { hasHumanAgentReplied: true } });
    expect(d.action).toBe('suggest');
    expect(d.reason).toBe('human_already_joined');
  });

  it('does NOT pause after a human reply when pause_auto_reply_after_human_reply=false', () => {
    const d = decide({
      settings: { mode: 'auto_reply_always', pause_auto_reply_after_human_reply: false },
      state: { hasHumanAgentReplied: true },
    });
    expect(d.action).toBe('auto_reply');
    expect(d.reason).toBe('ok');
  });

  it('skips (not suggest) after human reply when both pause and allow_suggestions_after_takeover are off-favoring skip', () => {
    const d = decide({
      settings: { mode: 'auto_reply_always', allow_suggestions_after_takeover: false },
      state: { hasHumanAgentReplied: true },
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('human_already_joined');
  });
});
