/**
 * P0 — canonical HumanRequest resolver hardening.
 *
 * Short questions that merely MENTION a human role must never authorize a
 * transfer; bare role requests still must.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveHumanRequestSignal,
  classifyConfiguredKeyword,
} from '../../../server/services/ai-agent/humanRequest.js';

const PROD_KEYWORDS = [
  'human', 'agent', 'operator', 'representative', 'speak to someone',
  'انسان', 'اپراتور', 'پشتیبان', 'insan', 'operatör', 'temsilci', 'yetkili',
];

const sig = (text: string) =>
  resolveHumanRequestSignal({ text, configuredKeywords: PROD_KEYWORDS });

describe('short informational questions never escalate', () => {
  const cases = [
    // fa
    'پشتیبانی دارید؟',
    'اپراتور آنلاین دارید؟',
    'کارشناس فروش دارید؟',
    'پشتیبان امروز هست؟',
    'اپراتور موجوده؟',
    // tr
    'insan desteği var mı?',
    'temsilci var mı?',
    // en
    'agent available?',
    'agent online?',
    'live agent hours?',
    'operator working today?',
  ];
  for (const text of cases) {
    it(`does not escalate: ${text}`, () => {
      const s = sig(text);
      expect(s.explicit).toBe(false);
      expect(s.confidence).toBeLessThan(0.5);
    });
  }
});

describe('bare explicit human requests still escalate', () => {
  const cases = [
    'اپراتور لطفا',
    'اپراتور',
    'یک آدم واقعی میخوام',
    'منو به اپراتور وصل کن',
    'با کارشناس صحبت کنم',
    'Canlı destek istiyorum',
    'Temsilci lütfen',
    'Connect me to an agent',
    'Agent please',
    'I want a real person',
  ];
  for (const text of cases) {
    it(`escalates: ${text}`, () => {
      const s = sig(text);
      expect(s.explicit).toBe(true);
      expect(s.confidence).toBeGreaterThanOrEqual(0.7);
    });
  }
});

describe('configured keyword semantics', () => {
  it('generic descriptive phrases are supporting even when long', () => {
    for (const kw of [
      'support team working hours',
      'ساعت کاری پشتیبانی ما',
      'destek ekibimiz hakkinda bilgi',
    ]) {
      expect(classifyConfiguredKeyword(kw)).toBe('supporting');
    }
  });
  it('bare generic nouns stay supporting', () => {
    for (const kw of ['پشتیبان', 'agent', 'insan', 'operator']) {
      expect(classifyConfiguredKeyword(kw)).toBe('supporting');
    }
  });
  it('real request semantics are strong', () => {
    expect(classifyConfiguredKeyword('speak to someone')).toBe('strong');
    expect(classifyConfiguredKeyword('وصل کن به اپراتور')).toBe('strong');
    expect(classifyConfiguredKeyword('connect me to an agent')).toBe('strong');
    expect(classifyConfiguredKeyword('gerçek bir insan')).toBe('strong');
  });
  it('a supporting configured phrase never authorizes a handoff', () => {
    const s = resolveHumanRequestSignal({
      text: 'ساعت کاری پشتیبانی ما چیست',
      configuredKeywords: ['ساعت کاری پشتیبانی ما'],
    });
    expect(s.explicit).toBe(false);
  });
});
