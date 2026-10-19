/**
 * The AI's automatic sentences reach the visitor in the widget's language
 * (owner, 2026-10-18: no automatic message in another language):
 *
 *  - the hand-over line (`settings.fallback_message`) is the owner's single
 *    string with no language. Its column default is English, so a Persian
 *    or Turkish visitor read "I'm not sure about that yet. I'll connect you
 *    with a human agent." Now it is used only in the visitor's script
 *    (platformRegion textMatchesLocale, the rule intro.ts applies to legacy
 *    single-string fields), the English default only for an English
 *    visitor; otherwise the built-in localized hand-over line;
 *  - "this page is not indexed" told the VISITOR to sync it from
 *    "AI Agent → Train → Web Pages" (a dashboard path); now it offers a person;
 *  - the intro introduced the agent by its English default name
 *    ("سلام! من AI Assistant هستم"); now the default reads in the visitor's
 *    language.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const { ownerFallbackMessage, pickPageNotIndexed } = await import('../../../server/services/ai-agent/engine/helpers.js');
const { buildIntroBody } = await import('../../../server/services/ai-agent/intro.js');
const { DEFAULT_AI_FALLBACK_MESSAGE } = await import('../../../shared/systemMessages.js');

describe('the owner\'s hand-over line is used only in the visitor\'s language', () => {
  it('the column\'s English default: only for an English visitor', () => {
    expect(DEFAULT_AI_FALLBACK_MESSAGE).toBe("I'm not sure about that yet. I'll connect you with a human agent.");
    expect(ownerFallbackMessage(DEFAULT_AI_FALLBACK_MESSAGE, 'en')).toBe(DEFAULT_AI_FALLBACK_MESSAGE);
    expect(ownerFallbackMessage(DEFAULT_AI_FALLBACK_MESSAGE, 'en-US')).toBe(DEFAULT_AI_FALLBACK_MESSAGE);
    expect(ownerFallbackMessage(DEFAULT_AI_FALLBACK_MESSAGE, 'fa')).toBeNull();
    expect(ownerFallbackMessage(DEFAULT_AI_FALLBACK_MESSAGE, 'tr')).toBeNull();
  });

  it('the owner\'s own text: when its script is the visitor\'s', () => {
    const fa = 'مطمئن نیستم؛ شما را به همکارم وصل می‌کنم.';
    expect(ownerFallbackMessage(fa, 'fa')).toBe(fa);
    expect(ownerFallbackMessage(fa, 'en')).toBeNull();
    expect(ownerFallbackMessage(fa, 'tr')).toBeNull();
    const tr = 'Emin değilim, sizi bir temsilciye bağlıyorum.';
    expect(ownerFallbackMessage(tr, 'tr')).toBe(tr);
    expect(ownerFallbackMessage(tr, 'fa')).toBeNull();
  });

  it('nothing set: nothing', () => {
    expect(ownerFallbackMessage('', 'fa')).toBeNull();
    expect(ownerFallbackMessage('   ', 'en')).toBeNull();
    expect(ownerFallbackMessage(null, 'en')).toBeNull();
  });

  it('both hand-over paths (no answer, no valid generation) go through it', () => {
    for (const file of ['answerStage', 'generationStage']) {
      const src = readFileSync(`server/services/ai-agent/engine/${file}.ts`, 'utf8');
      expect(src, file).toContain('ownerFallbackMessage(settings.fallback_message, locale)');
      // The line itself is never sent unchecked (the prompt's own guidance
      // may still quote it: the model answers in the visitor's language).
      expect(src, file).not.toMatch(/(?:body|AckBody)\s*=\s*settings\.fallback_message/);
    }
  });
});

describe('"this page is not indexed" speaks to the visitor', () => {
  for (const locale of ['fa', 'en', 'tr']) {
    it(`${locale}: no dashboard path, no training jargon`, () => {
      const text = pickPageNotIndexed(locale);
      expect(text).not.toMatch(/AI Agent|Train|Web Pages|→|sync|senkron|ایندکس|index/i);
      expect(text.length).toBeGreaterThan(20);
    });
  }

  it('each in its own language, offering a person', () => {
    expect(pickPageNotIndexed('fa')).toMatch(/[؀-ۿ]/);
    expect(pickPageNotIndexed('fa')).toContain('همکار');
    expect(pickPageNotIndexed('tr')).toMatch(/[çğıöşüÇĞİÖŞÜ]/);
    expect(pickPageNotIndexed('tr')).not.toMatch(/[؀-ۿ]/);
    expect(pickPageNotIndexed('en')).toMatch(/teammate|team/i);
    expect(pickPageNotIndexed(undefined)).toBe(pickPageNotIndexed('en'));
  });
});

describe('the intro names the agent in the visitor\'s language when the owner did not', () => {
  const settings = (agent_name: string | null) => ({
    agent_name, intro_message_localized: null, intro_message: null, welcome_message: null,
  }) as never;

  it('the default name, or none: an unnamed assistant, in one sentence of its own', () => {
    // Not the named template with a stand-in name ("Ben Yapay zekâ asistanı,
    // bir yapay zeka asistanıyım", «من دستیار هوش مصنوعی هستم، یک دستیار
    // هوشمند»): the same idea twice.
    for (const name of ['AI Assistant', '', null]) {
      const fa = buildIntroBody(settings(name), 'fa', ['fa']);
      expect(fa.startsWith('سلام! من یک دستیار هوش مصنوعی هستم.')).toBe(true);
      expect(fa).not.toContain('AI Assistant');
      expect(fa).not.toContain('دستیار هوشمند');
      const tr = buildIntroBody(settings(name), 'tr', ['tr', 'en']);
      expect(tr.startsWith('Merhaba! Ben bir yapay zekâ asistanıyım.')).toBe(true);
      expect(tr).not.toContain('AI Assistant');
      expect(tr).not.toMatch(/Ben Yapay|zeka /);
      const en = buildIntroBody(settings(name), 'en', ['en']);
      expect(en.startsWith("Hi! I'm an AI assistant.")).toBe(true);
      expect(en).not.toContain('AI Assistant');
    }
  });

  it('the owner\'s intro in another language is not used: the built-in one is, in the visitor\'s', () => {
    const own = (intro_message_localized: Record<string, string> | null, intro_message: string | null = null) => ({
      agent_name: null, intro_message_localized, intro_message, welcome_message: null,
    }) as never;
    // Only English written, a Turkish or Persian visitor on a multi-language platform.
    expect(buildIntroBody(own({ en: 'Welcome to Acme!' }), 'tr', ['en', 'tr'])).toMatch(/^Merhaba!/);
    expect(buildIntroBody(own({ en: 'Welcome to Acme!' }), 'fa', ['en', 'fa'])).toMatch(/^سلام!/);
    // Their own language wins, and English still reads English.
    expect(buildIntroBody(own({ en: 'Welcome to Acme!', tr: 'Acme\'ye hoş geldiniz!' }), 'tr', ['en', 'tr'])).toBe('Acme\'ye hoş geldiniz!');
    expect(buildIntroBody(own({ en: 'Welcome to Acme!' }), 'en', ['en', 'tr'])).toBe('Welcome to Acme!');
    // A single legacy string (no language) only in the visitor's script.
    expect(buildIntroBody(own(null, 'به فروشگاه ما خوش آمدید'), 'en', ['en', 'fa'])).toMatch(/^Hi!/);
    expect(buildIntroBody(own(null, 'به فروشگاه ما خوش آمدید'), 'fa', ['en', 'fa'])).toBe('به فروشگاه ما خوش آمدید');
  });

  it('a name the owner chose stays as written', () => {
    expect(buildIntroBody(settings('نیلو'), 'fa', ['fa'])).toContain('نیلو');
    expect(buildIntroBody(settings('Nilo'), 'tr', ['tr'])).toContain('Nilo');
  });
});
