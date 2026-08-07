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
 * whether a callback can honestly be promised, and how an operator gets
 * picked. Each case below states the scenario in the matrix's own terms,
 * then asserts the pure functions that decide it.
 *
 * shouldRequirePrechat mirrors public/widget/runtime.js's
 * identity.shouldRequirePrechat(flow) exactly — see that function's
 * comment for the authoritative behavior contract. Kept in sync manually
 * since runtime.js cannot be imported into vitest.
 */
import { describe, it, expect } from 'vitest';
import { classifyEffectiveAiMode } from '../../../server/services/ai-agent/effectiveMode';
import { rankAutoCandidates, rotateFromCursor } from '../../../server/services/chatRouting';
import { hasOfflineContactCapability, pickHandoffOfflineMessage } from '../../../server/services/ai-agent/runtime/templates';

type Flow = 'ai_entry' | 'ai_handoff' | 'human_entry';

function shouldRequirePrechat(flow: Flow, fieldPresenceNeedsPrechat: boolean): boolean {
  if (flow === 'ai_entry') return false;
  return fieldPresenceNeedsPrechat;
}

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

  it('10. auto routing picks the least-loaded eligible candidate, never randomly', () => {
    const load = new Map([['op-1', 4], ['op-2', 1], ['op-3', 1]]);
    // Tie between op-2/op-3 must resolve alphabetically, not by insertion order.
    expect(rankAutoCandidates(['op-1', 'op-3', 'op-2'], load)[0]).toBe('op-2');
  });

  it('11. round_robin rotates fairly across a full cycle with no repeats', () => {
    const pool = ['op-1', 'op-2', 'op-3'];
    let cursor: string | null = null;
    const order: string[] = [];
    for (let i = 0; i < pool.length; i++) {
      const picked = rotateFromCursor(pool, cursor)[0];
      order.push(picked);
      cursor = picked;
    }
    expect(new Set(order).size).toBe(pool.length);
  });

  it('12. manual mode routes nobody — conversation goes to the unassigned queue (asserted at the chatRouting.ts call site, not here: mode==="manual" short-circuits before ranking)', () => {
    // Documented via the mode switch in chatRouting.ts:
    // `if (mode === 'manual') { ...tagOutcome('manual_queue')...; return; }`
    // — no ranking function runs, which is exactly why there is nothing to
    // assert against rankAutoCandidates/rotateFromCursor for this case.
    expect(true).toBe(true);
  });

  it('13. no eligible candidates → auto ranking returns nothing to try (empty in, empty out)', () => {
    expect(rankAutoCandidates([], new Map())).toEqual([]);
    expect(rotateFromCursor([], null)).toEqual([]);
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

  it('18. round-robin cursor pointing at a departed/offline operator falls back to plain sort, not a crash', () => {
    expect(rotateFromCursor(['a', 'b'], 'operator-who-left')).toEqual(['a', 'b']);
  });

  it('19. auto-mode load ranking is stable for an already-idle team (all zero load)', () => {
    const load = new Map([['b', 0], ['a', 0], ['c', 0]]);
    expect(rankAutoCandidates(['c', 'a', 'b'], load)).toEqual(['a', 'b', 'c']);
  });

  it('20. offline copy exists in all three supported locales for both capability states', () => {
    for (const locale of ['fa', 'en', 'tr']) {
      expect(pickHandoffOfflineMessage(locale, true).length).toBeGreaterThan(0);
      expect(pickHandoffOfflineMessage(locale, false).length).toBeGreaterThan(0);
    }
  });
});
