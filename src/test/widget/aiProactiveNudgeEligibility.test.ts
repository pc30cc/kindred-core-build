/**
 * AI Proactive Nudge — deterministic gate unit tests (smartEngine.ts).
 *
 * Covers the cheap client/server-shared eligibility layer that MUST run
 * before any AI call: hard-suppression precedence (identical ordering to
 * evaluateSmartRule so the two surfaces never disagree), path targeting,
 * frequency/cooldown/dismissal state, duplicate-context dedup, and the
 * deterministic scoring model.
 */
import { describe, it, expect } from 'vitest';
import {
  AI_JOURNEY_MAX_PAGES,
  AI_MODE_DEFAULTS,
  normalizeTopicFromPath,
  matchesPathPattern,
  computeAiProactiveScore,
  computeAiProactiveFingerprint,
  evaluateAiProactiveEligibility,
  type AiProactiveConfig,
  type AiJourneyContext,
} from '@/lib/widget/smartEngine';
import type { SmartEvalContext } from '@/lib/widget/smartEngine';

function baseCtx(overrides: Partial<SmartEvalContext> = {}): SmartEvalContext {
  return {
    masterEnabled: true,
    mode: 'production',
    page: { url: '/pricing', path: '/pricing', hostname: 'example.com' },
    device: 'desktop',
    locale: 'en',
    visitor: { isReturning: false, sessionPageCount: 1 },
    availability: { online: true },
    interaction: {},
    signals: { elapsedMs: 0, scrollPercent: 0, inactiveMs: 0, exitIntent: false },
    ...overrides,
  } as SmartEvalContext;
}

function baseJourney(overrides: Partial<AiJourneyContext> = {}): AiJourneyContext {
  return {
    current: { path: '/pricing', ts: 1000 },
    recentPages: [],
    sessionPageCount: 1,
    returning: false,
    ...overrides,
  };
}

function baseConfig(overrides: Partial<AiProactiveConfig> = {}): AiProactiveConfig {
  return { mode: 'balanced', maxPerSession: 2, cooldownSeconds: 120, ...overrides };
}

describe('normalizeTopicFromPath', () => {
  it('buckets a nested path to its first segment', () => {
    expect(normalizeTopicFromPath('/pricing/enterprise')).toBe('pricing');
  });
  it('falls back to "home" for the root path', () => {
    expect(normalizeTopicFromPath('/')).toBe('home');
  });
  it('strips query/hash and lowercases', () => {
    expect(normalizeTopicFromPath('/Pricing?ref=x#top')).toBe('pricing');
  });
  it('truncates very long first segments', () => {
    const long = 'a'.repeat(80);
    expect(normalizeTopicFromPath(`/${long}`).length).toBeLessThanOrEqual(40);
  });
});

describe('matchesPathPattern', () => {
  it('matches an exact path', () => {
    expect(matchesPathPattern('/pricing', '/pricing')).toBe(true);
    expect(matchesPathPattern('/pricing/', '/pricing')).toBe(true);
  });
  it('does not match a different exact path', () => {
    expect(matchesPathPattern('/pricing/enterprise', '/pricing')).toBe(false);
  });
  it('matches a wildcard prefix', () => {
    expect(matchesPathPattern('/features/chat', '/features*')).toBe(true);
    expect(matchesPathPattern('/features', '/features*')).toBe(true);
  });
  it('does not match a wildcard prefix for an unrelated path', () => {
    expect(matchesPathPattern('/about', '/features*')).toBe(false);
  });
});

describe('computeAiProactiveScore', () => {
  it('starts at zero for a first-time, low-signal visit', () => {
    expect(computeAiProactiveScore(baseCtx(), baseJourney())).toBe(0);
  });
  it('adds points for a returning visitor', () => {
    const ctx = baseCtx({ visitor: { isReturning: true, sessionPageCount: 1 } });
    expect(computeAiProactiveScore(ctx, baseJourney())).toBe(15);
  });
  it('adds points for long dwell time and deep scroll', () => {
    const ctx = baseCtx({ signals: { elapsedMs: 60000, scrollPercent: 80, inactiveMs: 0, exitIntent: false } });
    expect(computeAiProactiveScore(ctx, baseJourney())).toBe(25);
  });
  it('adds points for revisiting the current page', () => {
    const journey = baseJourney({
      current: { path: '/pricing', ts: 2000 },
      recentPages: [{ path: '/pricing', ts: 1000 }],
    });
    expect(computeAiProactiveScore(baseCtx(), journey)).toBe(20);
  });
  it('adds points for visiting 3+ distinct pages this session', () => {
    const journey = baseJourney({
      current: { path: '/checkout', ts: 3000 },
      recentPages: [{ path: '/pricing', ts: 1000 }, { path: '/features', ts: 2000 }],
    });
    expect(computeAiProactiveScore(baseCtx(), journey)).toBe(20);
  });
  it('penalizes a topic the visitor already dismissed', () => {
    const journey = baseJourney({ previousNudge: { topic: 'pricing', dismissed: true, engaged: false } });
    expect(computeAiProactiveScore(baseCtx(), journey)).toBe(-50);
  });
  it('does not penalize when the previous nudge on this topic was engaged, not dismissed', () => {
    const journey = baseJourney({ previousNudge: { topic: 'pricing', dismissed: false, engaged: true } });
    expect(computeAiProactiveScore(baseCtx(), journey)).toBe(0);
  });
});

describe('computeAiProactiveFingerprint', () => {
  it('is stable regardless of recentPages insertion order', () => {
    const j1 = baseJourney({ recentPages: [{ path: '/a', ts: 1 }, { path: '/b', ts: 2 }] });
    const j2 = baseJourney({ recentPages: [{ path: '/b', ts: 2 }, { path: '/a', ts: 1 }] });
    expect(computeAiProactiveFingerprint(j1)).toBe(computeAiProactiveFingerprint(j2));
  });
  it('changes when the current topic changes', () => {
    const j1 = baseJourney({ current: { path: '/pricing', ts: 1 } });
    const j2 = baseJourney({ current: { path: '/features', ts: 1 } });
    expect(computeAiProactiveFingerprint(j1)).not.toBe(computeAiProactiveFingerprint(j2));
  });
});

describe('evaluateAiProactiveEligibility — hard suppression precedence', () => {
  const cases: [string, Partial<SmartEvalContext>, string][] = [
    ['master switch off', { masterEnabled: false }, 'MASTER_DISABLED'],
    ['a call is active', { interaction: { callActive: true } }, 'CALL_ACTIVE'],
    ['pre-chat form is open', { interaction: { prechatOpen: true } }, 'PRECHAT_OPEN'],
    ['visitor is typing', { interaction: { visitorTyping: true } }, 'VISITOR_TYPING'],
    ['another rule is showing', { interaction: { anotherRuleShowing: true } }, 'OTHER_RULE_SHOWING'],
    ['a conversation is active', { interaction: { conversationActive: true } }, 'CONVERSATION_ACTIVE'],
    ['the visitor already replied', { interaction: { visitorReplied: true } }, 'CONVERSATION_ACTIVE'],
    ['the widget is open', { interaction: { widgetOpen: true } }, 'WIDGET_OPEN'],
    ['the tab is hidden', { signals: { elapsedMs: 0, scrollPercent: 0, inactiveMs: 0, exitIntent: false, pageHidden: true } }, 'PAGE_HIDDEN'],
  ];

  for (const [label, ctxOverride, expectedReason] of cases) {
    it(`suppresses when ${label}`, () => {
      const result = evaluateAiProactiveEligibility(baseConfig(), baseCtx(ctxOverride), baseJourney(), undefined);
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain(expectedReason);
    });
  }

  it('suppresses on mobile when mobileEnabled is false', () => {
    const config = baseConfig({ mobileEnabled: false });
    const ctx = baseCtx({ device: 'mobile' });
    const result = evaluateAiProactiveEligibility(config, ctx, baseJourney(), undefined);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('MOBILE_BLOCKED');
  });

  it('does not suppress a widgetOpen interaction when stopAfterWidgetOpen is false', () => {
    const config = baseConfig({ stopAfterWidgetOpen: false, mode: 'active' });
    const ctx = baseCtx({
      interaction: { widgetOpen: true },
      visitor: { isReturning: true, sessionPageCount: 3 },
      signals: { elapsedMs: 60000, scrollPercent: 80, inactiveMs: 0, exitIntent: false },
    });
    const result = evaluateAiProactiveEligibility(config, ctx, baseJourney(), undefined);
    expect(result.reasons).not.toContain('WIDGET_OPEN');
  });
});

describe('evaluateAiProactiveEligibility — mode and targeting', () => {
  it('is never eligible when mode is off', () => {
    const result = evaluateAiProactiveEligibility(baseConfig({ mode: 'off' }), baseCtx(), baseJourney(), undefined);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('AI_MODE_OFF');
  });

  it('excludePaths always wins over includePaths for the same path', () => {
    const config = baseConfig({ includePaths: ['/pricing*'], excludePaths: ['/pricing/enterprise'] });
    const journey = baseJourney({ current: { path: '/pricing/enterprise', ts: 1 } });
    const result = evaluateAiProactiveEligibility(config, baseCtx(), journey, undefined);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('AI_PATH_EXCLUDED');
  });

  it('rejects a page outside includePaths', () => {
    const config = baseConfig({ includePaths: ['/pricing*'] });
    const journey = baseJourney({ current: { path: '/about', ts: 1 } });
    const result = evaluateAiProactiveEligibility(config, baseCtx(), journey, undefined);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('AI_PATH_NOT_INCLUDED');
  });

  it('allows every page when includePaths is empty', () => {
    const config = baseConfig();
    const journey = baseJourney({ current: { path: '/any-random-page', ts: 1 } });
    const ctx = baseCtx({ visitor: { isReturning: true, sessionPageCount: 3 }, signals: { elapsedMs: 60000, scrollPercent: 80, inactiveMs: 0, exitIntent: false } });
    const result = evaluateAiProactiveEligibility(config, ctx, journey, undefined);
    expect(result.reasons).not.toContain('AI_PATH_NOT_INCLUDED');
  });
});

describe('evaluateAiProactiveEligibility — frequency, cooldown, dedup', () => {
  it('suppresses a topic the visitor already dismissed when stopAfterDismiss is true', () => {
    const config = baseConfig({ stopAfterDismiss: true });
    const journey = baseJourney({ current: { path: '/pricing', ts: 1 } });
    const result = evaluateAiProactiveEligibility(config, baseCtx(), journey, { dismissedTopics: ['pricing'] });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('AI_TOPIC_DISMISSED');
  });

  it('does not suppress a dismissed topic when stopAfterDismiss is false', () => {
    const config = baseConfig({ stopAfterDismiss: false, mode: 'active' });
    const journey = baseJourney({ current: { path: '/pricing', ts: 1 } });
    const ctx = baseCtx({ visitor: { isReturning: true, sessionPageCount: 3 }, signals: { elapsedMs: 60000, scrollPercent: 80, inactiveMs: 0, exitIntent: false } });
    const result = evaluateAiProactiveEligibility(config, ctx, journey, { dismissedTopics: ['pricing'] });
    expect(result.reasons).not.toContain('AI_TOPIC_DISMISSED');
  });

  it('enforces maxPerSession', () => {
    const config = baseConfig({ maxPerSession: 1 });
    const result = evaluateAiProactiveEligibility(config, baseCtx(), baseJourney(), { shownInSession: 1 });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('AI_MAX_PER_SESSION');
  });

  it('enforces the cooldown window', () => {
    const config = baseConfig({ cooldownSeconds: 120 });
    const now = new Date(100000);
    const result = evaluateAiProactiveEligibility(config, baseCtx(), baseJourney(), { lastShownAt: 50000 }, now);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('AI_COOLDOWN');
  });

  it('allows again once the cooldown has elapsed', () => {
    const config = baseConfig({ cooldownSeconds: 10, mode: 'active' });
    const now = new Date(100000);
    const ctx = baseCtx({ visitor: { isReturning: true, sessionPageCount: 3 }, signals: { elapsedMs: 60000, scrollPercent: 80, inactiveMs: 0, exitIntent: false } });
    const result = evaluateAiProactiveEligibility(config, ctx, baseJourney(), { lastShownAt: 50000 }, now);
    expect(result.reasons).not.toContain('AI_COOLDOWN');
  });

  it('suppresses a duplicate context evaluated within the dedup window', () => {
    const journey = baseJourney();
    const fingerprint = computeAiProactiveFingerprint(journey);
    const now = new Date(100000);
    const result = evaluateAiProactiveEligibility(
      baseConfig(), baseCtx(), journey,
      { lastEvalFingerprint: fingerprint, lastEvalAt: 99000 },
      now,
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('AI_DUPLICATE_CONTEXT');
  });

  it('does not dedup once the fingerprint window has expired', () => {
    const config = baseConfig({ mode: 'active' });
    const journey = baseJourney();
    const fingerprint = computeAiProactiveFingerprint(journey);
    const now = new Date(100000 + 6 * 60000);
    const ctx = baseCtx({ visitor: { isReturning: true, sessionPageCount: 3 }, signals: { elapsedMs: 60000, scrollPercent: 80, inactiveMs: 0, exitIntent: false } });
    const result = evaluateAiProactiveEligibility(config, ctx, journey, { lastEvalFingerprint: fingerprint, lastEvalAt: 100000 }, now);
    expect(result.reasons).not.toContain('AI_DUPLICATE_CONTEXT');
  });
});

describe('evaluateAiProactiveEligibility — scoring threshold', () => {
  it('suppresses with AI_LOW_INTENT when the score is under the mode threshold', () => {
    const result = evaluateAiProactiveEligibility(baseConfig({ mode: 'conservative' }), baseCtx(), baseJourney(), undefined);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('AI_LOW_INTENT');
  });

  it('is eligible once enough deterministic signal accumulates', () => {
    const config = baseConfig({ mode: 'active' });
    const ctx = baseCtx({
      visitor: { isReturning: true, sessionPageCount: 3 },
      signals: { elapsedMs: 60000, scrollPercent: 80, inactiveMs: 0, exitIntent: false },
    });
    const journey = baseJourney({
      current: { path: '/checkout', ts: 3000 },
      recentPages: [{ path: '/pricing', ts: 1000 }, { path: '/features', ts: 2000 }],
    });
    const result = evaluateAiProactiveEligibility(config, ctx, journey, undefined);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toContain('AI_ELIGIBLE');
    expect(result.score).toBeGreaterThanOrEqual(result.threshold);
  });

  it('honors an explicit minScoreOverride instead of the mode default', () => {
    const config = baseConfig({ mode: 'active', minScoreOverride: 1000 });
    const ctx = baseCtx({ visitor: { isReturning: true, sessionPageCount: 3 }, signals: { elapsedMs: 60000, scrollPercent: 80, inactiveMs: 0, exitIntent: false } });
    const result = evaluateAiProactiveEligibility(config, ctx, baseJourney(), undefined);
    expect(result.eligible).toBe(false);
    expect(result.threshold).toBe(1000);
  });
});

describe('journey bounding constants', () => {
  it('caps the bounded recent-page journey at a small, fixed size', () => {
    expect(AI_JOURNEY_MAX_PAGES).toBe(12);
  });
  it('defines a maxPerSession/cooldown default for every non-off mode', () => {
    expect(AI_MODE_DEFAULTS.conservative.maxPerSession).toBeLessThanOrEqual(AI_MODE_DEFAULTS.balanced.maxPerSession);
    expect(AI_MODE_DEFAULTS.balanced.maxPerSession).toBeLessThanOrEqual(AI_MODE_DEFAULTS.active.maxPerSession);
  });
});
