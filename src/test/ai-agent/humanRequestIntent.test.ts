/**
 * P0 regression — AI must NOT hand off ordinary questions to a human.
 *
 * Production bug: every new conversation answered the first normal question
 * with "باشه — همین الان شما را به یک کارشناس انسانی وصل می‌کنم." because
 * generic nouns in handoff keywords / topic examples were treated as an
 * explicit human request.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveHumanRequestSignal,
  classifyConfiguredKeyword,
} from '../../../server/services/ai-agent/humanRequest.js';
import { exampleHit } from '../../../server/services/ai-agent/topics/detector.js';

// The real keyword list configured on the affected production workspace.
const PROD_KEYWORDS = [
  'human', 'agent', 'operator', 'representative', 'speak to someone',
  'انسان', 'اپراتور', 'پشتیبان', 'insan', 'operatör', 'temsilci', 'yetkili',
];

const normal = (text: string) =>
  resolveHumanRequestSignal({ text, configuredKeywords: PROD_KEYWORDS });

describe('normal questions never authorize a handoff', () => {
  const cases = [
    // Persian
    'اسمت چیه',
    'سلام',
    'ساعت کاری شما چطوره؟',
    'پشتیبانی شما چطور کار می‌کنه؟',
    'اپراتورها چه ساعتی آنلاین هستند؟',
    'قیمت پلن حرفه‌ای چقدره؟',
    'میخوام بدونم پشتیبانی چطوریه',
    // Turkish
    'Merhaba',
    'Destek sisteminiz nasıl çalışıyor?',
    'Temsilcileriniz ne zaman çevrimiçi?',
    'Fiyatlarınız hakkında bilgi alabilir miyim?',
    // English
    'hello',
    'what is your name?',
    'How does your support work?',
    'When are your agents online?',
  ];
  for (const text of cases) {
    it(`does not escalate: ${text}`, () => {
      const s = normal(text);
      expect(s.explicit).toBe(false);
      expect(s.confidence).toBeLessThan(0.5);
    });
  }
});

describe('genuine human requests still escalate', () => {
  const cases = [
    'منو به اپراتور وصل کن',
    'لطفاً من را به یک کارشناس انسانی وصل کنید',
    'میخوام با پشتیبانی صحبت کنم',
    'با یک آدم واقعی میخوام حرف بزنم',
    'دیگه نمیخوام با ربات حرف بزنم',
    'اپراتور لطفا',
    'Beni bir temsilciye bağlar mısınız',
    'Canlı destek istiyorum',
    'Botla konuşmak istemiyorum',
    'Connect me to a human',
    'I want to talk to a real person',
    'transfer me to an agent please',
  ];
  for (const text of cases) {
    it(`escalates: ${text}`, () => {
      const s = normal(text);
      expect(s.explicit).toBe(true);
      expect(s.confidence).toBeGreaterThanOrEqual(0.7);
    });
  }
});

describe('topic evidence alone is supporting, never authority (P0-4)', () => {
  it('topic human-request without explicit intent does not authorize', () => {
    const s = resolveHumanRequestSignal({
      text: 'سلام',
      configuredKeywords: PROD_KEYWORDS,
      topicHumanRequest: true,
    });
    expect(s.explicit).toBe(false);
    expect(s.reason).toBe('topic_support');
    expect(s.supporting.topicHumanRequest).toBe(true);
  });
});

describe('configured keyword classification (P0-5)', () => {
  it('bare generic nouns are supporting only', () => {
    for (const kw of ['پشتیبان', 'agent', 'insan', 'operator']) {
      expect(classifyConfiguredKeyword(kw)).toBe('supporting');
    }
  });
  it('intent phrases stay strong', () => {
    expect(classifyConfiguredKeyword('speak to someone')).toBe('strong');
    expect(classifyConfiguredKeyword('وصل کن به اپراتور')).toBe('strong');
  });
  it('a strong configured phrase authorizes', () => {
    const s = resolveHumanRequestSignal({
      text: 'I would like to speak to someone about my order',
      configuredKeywords: PROD_KEYWORDS,
    });
    expect(s.explicit).toBe(true);
  });
  it('a generic keyword mention is recorded but not authoritative', () => {
    const s = normal('پشتیبان شما چطور کار می‌کنه؟');
    expect(s.explicit).toBe(false);
    expect(s.supporting.genericKeywordMention).toBe('پشتیبان');
    // The inflected form "پشتیبانی" is not even a boundary match.
    expect(normal('پشتیبانی شما چطور کار می‌کنه؟').supporting.genericKeywordMention).toBeNull();
  });
});

describe('topic example matching (P0-3)', () => {
  it('short greeting inside a long example is NOT a match', () => {
    expect(exampleHit('سلام', 'سلام لطفا من را به اپراتور وصل کنید')).toBe(false);
  });
  it('full example inside a longer message IS a match', () => {
    expect(exampleHit('سلام من را به اپراتور وصل کنید ممنون', 'من را به اپراتور وصل کنید')).toBe(true);
  });
  it('exact match still works', () => {
    expect(exampleHit('operator lutfen', 'operator lutfen')).toBe(true);
  });
});
