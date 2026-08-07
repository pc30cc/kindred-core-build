/**
 * AI handoff offline copy — localization + no-false-promise unit tests.
 *
 * Spec requirement: never promise a callback the workspace has no way to
 * make. Copy must only say "we'll reach out" when pre-chat actually
 * collects email or phone; otherwise it must point the visitor back to
 * this chat. All new visitor-facing text must exist in fa/en/tr with no
 * Persian-only hardcoding (server/services/ai-agent/runtime/templates.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  pickHandoffOfflineMessage,
  hasOfflineContactCapability,
} from '../../../server/services/ai-agent/runtime/templates';

describe('hasOfflineContactCapability', () => {
  it('defaults to true (still asking) when no pre-chat policy row exists', () => {
    expect(hasOfflineContactCapability(null)).toBe(true);
    expect(hasOfflineContactCapability(undefined)).toBe(true);
  });

  it('true when email is asked (ask_email defaults to true when unset)', () => {
    expect(hasOfflineContactCapability({})).toBe(true);
    expect(hasOfflineContactCapability({ ask_email: true })).toBe(true);
  });

  it('true when phone is explicitly required, even if email is off', () => {
    expect(hasOfflineContactCapability({ ask_email: false, ask_phone: true })).toBe(true);
  });

  it('false only when both email is explicitly off and phone is not asked', () => {
    expect(hasOfflineContactCapability({ ask_email: false, ask_phone: false })).toBe(false);
    expect(hasOfflineContactCapability({ ask_email: false })).toBe(false);
  });
});

describe('pickHandoffOfflineMessage', () => {
  const locales = ['fa', 'en', 'tr'] as const;

  it.each(locales)('returns non-empty copy for locale=%s with contact capability', (locale) => {
    const msg = pickHandoffOfflineMessage(locale, true);
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });

  it.each(locales)('returns non-empty copy for locale=%s without contact capability', (locale) => {
    const msg = pickHandoffOfflineMessage(locale, false);
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });

  it('with-contact and no-contact copy differ for every supported locale', () => {
    for (const locale of locales) {
      expect(pickHandoffOfflineMessage(locale, true)).not.toBe(pickHandoffOfflineMessage(locale, false));
    }
  });

  it('falls back to English for an unrecognized/missing locale', () => {
    expect(pickHandoffOfflineMessage(undefined, true)).toBe(pickHandoffOfflineMessage('en', true));
    expect(pickHandoffOfflineMessage('xx', false)).toBe(pickHandoffOfflineMessage('en', false));
  });

  it('is locale-prefix tolerant (e.g. fa-IR, tr-TR, en-US)', () => {
    expect(pickHandoffOfflineMessage('fa-IR', true)).toBe(pickHandoffOfflineMessage('fa', true));
    expect(pickHandoffOfflineMessage('tr-TR', false)).toBe(pickHandoffOfflineMessage('tr', false));
    expect(pickHandoffOfflineMessage('en-US', true)).toBe(pickHandoffOfflineMessage('en', true));
  });

  it('no-contact-capability copy never claims a callback across any supported locale', () => {
    // Best-effort lexical guard against the "we'll call/contact you" promise
    // leaking into the no-contact-capability variant. Real wording review
    // still matters — this only catches an obvious regression.
    const noCallbackTokens: Record<(typeof locales)[number], RegExp[]> = {
      en: [/we'?ll (call|contact) you/i, /we will (call|contact) you/i],
      fa: [/تماس می.?گیریم/, /باهات تماس/],
      tr: [/sizi ara(cağız|yacağız)/i],
    };
    for (const locale of locales) {
      const msg = pickHandoffOfflineMessage(locale, false);
      for (const pattern of noCallbackTokens[locale]) {
        expect(pattern.test(msg)).toBe(false);
      }
    }
  });
});
