/**
 * Follow-up 5 — characterization of a narrower Persian/Arabic classifier
 * edge case than the one Phase 2 already fixed: ordinary Persian sentences
 * that use ONLY letters shared with Arabic (none of پ چ ژ گ ک ی) and contain
 * none of the current Persian function-word markers. Phase 2's three-bucket
 * scoring (persianOnly / arabicOnly / shared-range) plus function-word bonus
 * already handles most real Persian text -- this file checks the residual
 * gap the bucket weighting alone cannot cover.
 *
 * Uses the REAL classifier (detectInputLanguage / detectInputLanguageDetailed
 * / decideResponseLanguage), no mocking -- this is characterization, not
 * unit-testing a mock.
 */
import { describe, it, expect } from 'vitest';
import {
  detectInputLanguage,
  detectInputLanguageDetailed,
  decideResponseLanguage,
} from '../../../server/services/ai-agent/language.js';

function detect(text: string) {
  return detectInputLanguageDetailed(text);
}

describe('P1 — obvious Persian-exclusive letters (must remain fa)', () => {
  const cases = [
    'چطور می‌توانم کمک بگیرم؟',
    'پرداخت من انجام نشده',
    'گزارش جدید کجاست؟',
  ];
  it.each(cases)('%s -> fa', (text) => {
    expect(detectInputLanguage(text)).toBe('fa');
  });
});

describe('P2 — ordinary Persian using ONLY shared Arabic-script letters', () => {
  // Each of these was hand-inspected: none contains پ چ ژ گ ک ی, and none
  // (pre-fix) matches any current Persian function-word marker.
  const cases: Array<[string, string]> = [
    ['سلام من خوبم', 'no persianOnly letters; no faWords marker present'],
    ['سلام حالت خوبه', 'no persianOnly letters; no faWords marker present'],
    ['حالم خوبه', 'no persianOnly letters; no faWords marker present'],
    ['من الان خوبم', 'no persianOnly letters; no faWords marker present'],
  ];
  it.each(cases)('%s (%s) -> fa', (text) => {
    const d = detect(text);
    // Characterization: record actual result. This assertion is the
    // pre-fix PROOF step -- expected to fail against current production
    // code for at least "سلام من خوبم" (the task's own example).
    expect(d.language).toBe('fa');
  });
});

describe('P2b — ordinary Persian sentences already covered by existing evidence (must remain fa, sanity check)', () => {
  const cases: Array<[string, string]> = [
    ['سلام حال شما چطور است', 'contains چ (persianOnly) via چطور'],
    ['من الان اینجا هستم', 'contains ی (persianOnly) via اینجا, plus هستم marker'],
    ['امروز هوا سرد است', 'است marker present'],
    ['این حساب برای من است', 'contains ی (persianOnly) via این/برای, plus است marker'],
    ['لطفا کمکم کن', 'contains ک (persianOnly) via کمکم/کن'],
  ];
  it.each(cases)('%s (%s) -> fa', (text) => {
    expect(detect(text).language).toBe('fa');
  });
});

describe('P3 — obvious Arabic (must remain ar, no regression)', () => {
  const cases = [
    'مرحبا كيف حالك',
    'أنا بخير',
    'هذا الحساب لي',
    'أريد المساعدة',
    'شكرا لك',
  ];
  it.each(cases)('%s -> ar', (text) => {
    expect(detectInputLanguage(text)).toBe('ar');
  });
});

describe('P4 — Arabic with few/no Arabic-exclusive letters (must NOT flip to fa)', () => {
  // Hand-inspected: these avoid ك/ي/ة/harakat (the arabicOnly bucket) as
  // much as natural Arabic allows, to make sure a Persian-leaning fix
  // doesn't over-correct and start mis-classifying plain Arabic as fa.
  const cases: Array<[string, string]> = [
    ['هذا هو السعر', 'contains هذا (arWords marker), no arabicOnly letters'],
    ['ما هذا', 'contains هذا (arWords marker)'],
  ];
  it.each(cases)('%s (%s) -> ar', (text) => {
    expect(detect(text).language).toBe('ar');
  });
});

describe('P5 — mixed Persian/Arabic (characterize existing contract, do not invent new policy)', () => {
  it('Persian with a couple of Arabic loan words still resolves fa (existing contract)', () => {
    const d = detect('چطور می‌توانم پسورد رو عوض کنم');
    expect(d.language).toBe('fa');
  });
});

describe('P6 — short ambiguous tokens (document current behavior, do not force)', () => {
  // These are intentionally NOT asserted against a specific language --
  // single shared tokens without sentence context are genuinely ambiguous.
  // We record the actual pre-fix/post-fix output for the report instead of
  // asserting a language, per the task's explicit instruction not to force
  // one when evidence is insufficient.
  const tokens = ['سلام', 'ممنون', 'مرسی', 'اوکی', 'بله', 'نه'];
  it('records current classification for each short token (informational)', () => {
    const results = tokens.map((t) => [t, detect(t).language, detect(t).confidence] as const);
    // eslint-disable-next-line no-console
    console.log('P6 short-token characterization:', results);
    expect(results.length).toBe(tokens.length);
  });
});

describe('P7 — Arabic/Persian shared greetings (documented ambiguity, not forced fa)', () => {
  it('سلام alone is not asserted either way -- shared token, no sentence context', () => {
    const d = detect('سلام');
    // Documented, not enforced: whichever way it currently resolves, it
    // must NOT be forced to fa by this follow-up (that would be the
    // forbidden "ambiguous Arabic script -> fa" global policy).
    expect(['fa', 'ar', 'unknown']).toContain(d.language);
  });
});

describe('P8 — Persian colloquial chat-widget replies (must be fa)', () => {
  const cases = [
    'خوبم',
    'میخوام کمکم کنی',
    'نمیدونم چی شده',
    'الان باید چیکار کنم',
  ];
  it.each(cases)('%s -> fa', (text) => {
    expect(detect(text).language).toBe('fa');
  });
});

describe('P9 — Turkish / English regression (no change expected)', () => {
  it('Turkish diacritic text still resolves tr/en as before', () => {
    const d = detect('Merhaba nasılsın');
    expect(['tr', 'en']).toContain(d.language);
  });
  it('English plain text still resolves en', () => {
    expect(detectInputLanguage('Hello how are you')).toBe('en');
  });
});

describe('Word-boundary characterization — JS \\b against Unicode Persian/Arabic letters', () => {
  it('a bare \\b-wrapped Persian word marker ("را") does not match even when standalone with spaces around it (documents the \\b bug)', () => {
    // \b in JS is defined via \w ([A-Za-z0-9_]), which never matches Perso-
    // Arabic letters, so \b never asserts a boundary next to them -- this
    // proves (not assumes) the three \b-wrapped fa markers and four
    // \b-wrapped ar markers in language.ts are currently dead weight.
    const re = /\bرا\b/g;
    expect('این را من دارم'.match(re)).toBeNull();
  });
});

describe('Response-language user-visible impact', () => {
  it('a misclassified/correctly-classified P2 sentence flows through to responseLanguage when widget locale is auto', () => {
    const d = decideResponseLanguage({
      visitorText: 'سلام من خوبم',
      widgetLocale: 'auto',
      workspaceLocale: 'en',
      allowedLocales: ['en', 'fa', 'ar'],
    });
    // This is the user-visible assertion: whatever detectInputLanguageDetailed
    // returns for this sentence becomes the actual AI reply language when
    // the widget is in auto-detect mode. Pinned to the CORRECT expectation
    // (fa) -- pre-fix this fails exactly like the raw detector test above.
    expect(d.inputLanguage).toBe('fa');
    expect(d.responseLanguage).toBe('fa');
    expect(d.source).toBe('visitor_detected');
  });
});
