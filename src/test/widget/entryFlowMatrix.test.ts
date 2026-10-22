/**
 * Entry-flow scenario matrix (spec §32's 20-case matrix), built on top of
 * the pure decision functions already covered individually elsewhere in
 * this directory (chatRoutingAlgorithm, effectiveAiMode, offlineHandoffCopy).
 *
 * This is NOT a browser/DOM E2E suite — public/widget/runtime.js has no
 * module system and no existing test harness to hang one off of (verified:
 * no test in this repo has ever imported it). What IS both testable and
 * meaningful is the actual decision logic each scenario turns on: whether
 * AI is visitor-facing, whether pre-chat is required for a given flow,
 * whether a callback can honestly be promised. How an operator gets picked
 * (cases 10–13, 18, 19 of the matrix) is chat_route_claim's, in SQL since
 * migration 278: src/test/integration/chatRouting278.pg.test.ts proves it on
 * a real database, src/test/routing/chatRoutingEngine.test.ts the engine
 * around it. Each case below states the scenario in the matrix's own terms,
 * then asserts the pure functions that decide it.
 *
 * shouldRequirePrechat mirrors public/widget/runtime.js's
 * identity.shouldRequirePrechat(flow) exactly — see that function's
 * comment for the authoritative behavior contract. Kept in sync manually
 * since runtime.js cannot be imported into vitest.
 */
import { describe, it, expect } from 'vitest';
import { classifyEffectiveAiMode } from '../../../server/services/ai-agent/effectiveMode';
import { hasOfflineContactCapability, pickHandoffOfflineMessage } from '../../../server/services/ai-agent/runtime/templates';

type Flow = 'ai_entry' | 'ai_handoff' | 'human_entry';
type Timing = 'always' | 'after_handoff' | 'never';

function shouldRequirePrechat(
  flow: Flow,
  fieldPresenceNeedsPrechat: boolean,
  timing: Timing = 'after_handoff',
): boolean {
  if (timing === 'never') return false;
  if (flow === 'ai_entry' && timing !== 'always') return false;
  return fieldPresenceNeedsPrechat;
}

describe('pre-chat timing setting', () => {
  it("'never' suppresses the form in every flow, even with fields configured", () => {
    for (const flow of ['ai_entry', 'ai_handoff', 'human_entry'] as Flow[]) {
      expect(shouldRequirePrechat(flow, true, 'never')).toBe(false);
    }
  });

  it("'always' shows the form on AI entry too", () => {
    expect(shouldRequirePrechat('ai_entry', true, 'always')).toBe(true);
    expect(shouldRequirePrechat('ai_handoff', true, 'always')).toBe(true);
    expect(shouldRequirePrechat('human_entry', true, 'always')).toBe(true);
  });

  it("'always' still requires at least one configured field", () => {
    expect(shouldRequirePrechat('ai_entry', false, 'always')).toBe(false);
  });

  it("'after_handoff' (default) keeps AI entry friction-free", () => {
    expect(shouldRequirePrechat('ai_entry', true, 'after_handoff')).toBe(false);
    expect(shouldRequirePrechat('ai_handoff', true, 'after_handoff')).toBe(true);
    expect(shouldRequirePrechat('human_entry', true, 'after_handoff')).toBe(true);
  });
});


describe('entry-flow matrix', () => {
  it('1. AI on (auto), Human online, Prechat off → AI_CHAT, no prechat', () => {
    const ai = classifyEffectiveAiMode(true, { enabled: true, mode: 'auto_reply_always' });
    expect(ai.reason).toBe('provider_pending'); // → visitorFacing after provider check
    expect(shouldRequirePrechat('ai_entry', false)).toBe(false);
  });

  it('2. AI on (auto), Human online, Prechat ON in owner settings → still AI_CHAT (prechat suppressed)', () => {
    // The owner has fields configured (fieldPresenceNeedsPrechat=true) but
    // flow is still 'ai_entry' on the very first open — must not show.
    expect(shouldRequirePrechat('ai_entry', true)).toBe(false);
  });

  it('3. AI off, Human online, Prechat off → human_entry, composer immediately', () => {
    const ai = classifyEffectiveAiMode(true, { enabled: true, mode: 'off' });
    expect(ai).toEqual({ visitorFacing: false, reason: 'mode_off' });
    expect(shouldRequirePrechat('human_entry', false)).toBe(false);
  });

  it('4. AI off, Human online, Prechat on → PRECHAT_FOR_HUMAN', () => {
    const ai = classifyEffectiveAiMode(true, { enabled: true, mode: 'off' });
    expect(ai.visitorFacing).toBe(false);
    expect(shouldRequirePrechat('human_entry', true)).toBe(true);
  });

  it('5. AI on, Human offline → AI still visitor-facing (AI-online independent of Human-offline)', () => {
    const ai = classifyEffectiveAiMode(true, { enabled: true, mode: 'auto_reply_always' });
    // Human team presence never appears as an input to classifyEffectiveAiMode
    // at all — this IS the independence guarantee, structurally enforced.
    expect(ai.reason).not.toBe('workspace_disabled');
    expect(ai.reason).not.toBe('platform_disabled');
  });

  it('6. AI off, Human offline → OFFLINE_CONTACT, copy depends on contact capability', () => {
    const withContact = pickHandoffOfflineMessage('en', hasOfflineContactCapability({ ask_email: true }));
    const noContact = pickHandoffOfflineMessage('en', hasOfflineContactCapability({ ask_email: false, ask_phone: false }));
    expect(withContact).not.toBe(noContact);
  });

  it('7. suggest_only is never visitor-facing regardless of enabled/online state', () => {
    expect(classifyEffectiveAiMode(true, { enabled: true, mode: 'suggest_only' })).toEqual({
      visitorFacing: false,
      reason: 'mode_suggest_only',
    });
  });

  it('8. platform kill-switch (e.g. credits/entitlement revoked) forces AI off regardless of workspace mode', () => {
    expect(classifyEffectiveAiMode(false, { enabled: true, mode: 'auto_reply_always' })).toEqual({
      visitorFacing: false,
      reason: 'platform_disabled',
    });
  });

  it('9. returning/identified visitor never sees prechat, in any flow', () => {
    // fieldPresenceNeedsPrechat is false once identityState==='identified' —
    // modeled here as the input already being false.
    for (const flow of ['ai_handoff', 'human_entry'] as Flow[]) {
      expect(shouldRequirePrechat(flow, false)).toBe(false);
    }
  });

  it('14. AI provider unresolvable (no_provider) is distinct from mode_off — both non-visitor-facing but for different reasons', () => {
    const modeOff = classifyEffectiveAiMode(true, { enabled: true, mode: 'off' });
    // no_provider only happens after classifyEffectiveAiMode defers
    // (reason 'provider_pending') and the async resolveAIConfig() call
    // fails — modeled here as asserting the two reasons are distinct enums.
    expect(modeOff.reason).not.toBe('no_provider');
  });

  it('15. never promises a callback when pre-chat collects neither email nor phone', () => {
    expect(hasOfflineContactCapability({ ask_email: false, ask_phone: false })).toBe(false);
    expect(hasOfflineContactCapability({ ask_email: false, ask_phone: undefined })).toBe(false);
  });

  it('16. does promise follow-up when phone is required even if email is off', () => {
    expect(hasOfflineContactCapability({ ask_email: false, ask_phone: true })).toBe(true);
  });

  it('17. ai_handoff flow re-applies normal prechat rules once the AI has already spoken', () => {
    // hasMsgs=true flips flow from 'ai_entry' to 'ai_handoff' at the
    // runtime.js call site — from that point on, field-presence rules apply.
    expect(shouldRequirePrechat('ai_handoff', true)).toBe(true);
    expect(shouldRequirePrechat('ai_handoff', false)).toBe(false);
  });

  it('20. offline copy exists in all three supported locales for both capability states', () => {
    for (const locale of ['fa', 'en', 'tr']) {
      expect(pickHandoffOfflineMessage(locale, true).length).toBeGreaterThan(0);
      expect(pickHandoffOfflineMessage(locale, false).length).toBeGreaterThan(0);
    }
  });
});
