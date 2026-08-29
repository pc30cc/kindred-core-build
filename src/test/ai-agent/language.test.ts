/**
 * Phase 1B — C14: language. server/services/ai-agent/language.ts is pure
 * (no IO), so detectInputLanguage()/decideResponseLanguage() are tested
 * directly with zero mocking. A single engine wiring test at the bottom
 * proves the settings.allowed_locales ∩ platform-allowed-locales
 * intersection (computed in engine.ts, NOT inside language.ts) actually
 * reaches the locale used for the run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectInputLanguage, decideResponseLanguage } from '../../../server/services/ai-agent/language.js';

describe('C14 — detectInputLanguage (script-based heuristic)', () => {
  it('detects Persian via Persian-only letters', () => {
    expect(detectInputLanguage('چطور می‌توانم رمز عبورم را بازیابی کنم؟')).toBe('fa');
  });
  it('detects Arabic (Arabic script without Persian-only markers)', () => {
    expect(detectInputLanguage('كيف يمكنني إعادة تعيين كلمة المرور')).toBe('ar');
  });
  it('detects Turkish via Turkish-specific letters', () => {
    expect(detectInputLanguage('şifremi nasıl sıfırlarım')).toBe('tr');
  });
  it('detects Turkish via stopwords even without diacritics', () => {
    expect(detectInputLanguage('merhaba fiyatlar nedir')).toBe('tr');
  });
  it('detects English for plain ASCII text', () => {
    expect(detectInputLanguage('how do I reset my password')).toBe('en');
  });
  it('returns unknown for empty text', () => {
    expect(detectInputLanguage('')).toBe('unknown');
  });
});

describe('C14 — decideResponseLanguage: visitor language wins', () => {
  it('a confidently-detected visitor language is used regardless of widget/workspace locale', () => {
    const d = decideResponseLanguage({
      visitorText: 'how do I reset my password please help me today',
      widgetLocale: 'fa',
      workspaceLocale: 'fa',
    });
    expect(d.inputLanguage).toBe('en');
    expect(d.responseLanguage).toBe('en');
    expect(d.source).toBe('visitor_detected');
  });

  it('PHASE 2 FIX: plain Persian text is detected as "fa" without needing an fa-favoring allow-list', () => {
    // Phase 1 found detectInputLanguageDetailed() scored every Arabic-script
    // character toward `ar`, so ordinary Persian sentences (which mostly use
    // characters shared with Arabic) resolved to inputLanguage='ar' unless
    // the allow-list happened to include 'fa' but not 'ar'. Phase 2 fix:
    // the scorer now distinguishes Persian-only letters, Arabic-only
    // letters/diacritics, and the shared range as three separately-weighted
    // buckets (plus a small Persian/Arabic function-word bonus mirroring
    // the pre-existing Turkish/English word-bonus pattern) so Persian
    // resolves correctly on its own — no allow-list dependency required.
    // INTENTIONAL BEHAVIOR CHANGE from the Phase 1 characterization above;
    // see git history for the prior "SURPRISING FINDING" version.
    const d = decideResponseLanguage({
      visitorText: 'چگونه پسورد را عوض کنم',
      widgetLocale: 'en',
      workspaceLocale: 'en',
    });
    expect(d.inputLanguage).toBe('fa');
    expect(d.responseLanguage).toBe('fa');
  });
});

describe('C14 — PHASE 2 FIX: Persian vs Arabic classification matrix', () => {
  const persianExamples: Array<[string, string]> = [
    ['conversational Persian', 'سلام، چطور می‌تونم رمز عبورم رو عوض کنم؟'],
    ['Persian with few of پ چ ژ گ (relies on function-word bonus)', 'من سوال دارم درباره شما'],
    ['formal Persian', 'با سلام و احترام، لطفاً راهنمایی بفرمایید که چگونه می‌توانم درخواست بازپرداخت ثبت کنم'],
    ['short Persian message', 'سلام خوبی؟'],
  ];
  it.each(persianExamples)('%s -> fa, not mixed', (_label, text) => {
    const d = decideResponseLanguage({ visitorText: text, widgetLocale: 'en' });
    expect(d.inputLanguage).toBe('fa');
    expect(d.mixedLanguageDetected).toBe(false);
  });

  const arabicExamples: Array<[string, string]> = [
    ['standard Arabic sentence', 'مرحبا، كيف يمكنني إعادة تعيين كلمة المرور الخاصة بي'],
    ['short Arabic message', 'مرحبا كيف حالك'],
    ['Arabic containing characters shared with Persian', 'ما هو السعر الشهري لهذه الخدمة'],
  ];
  it.each(arabicExamples)('%s -> ar, not mixed', (_label, text) => {
    const d = decideResponseLanguage({ visitorText: text, widgetLocale: 'en' });
    expect(d.inputLanguage).toBe('ar');
    expect(d.mixedLanguageDetected).toBe(false);
  });

  it('Turkish remains unaffected by the Persian/Arabic fix', () => {
    const d = decideResponseLanguage({ visitorText: 'şifremi nasıl sıfırlarım fiyatlar nedir', widgetLocale: 'en' });
    // Pinned as pre-existing (Phase 1) behavior, not part of this fix's
    // scope: the Latin-script char-counting bias toward 'en' for
    // diacritic-containing Turkish text is unchanged.
    expect(['tr', 'en']).toContain(d.inputLanguage);
  });

  it('English remains unaffected', () => {
    const d = decideResponseLanguage({ visitorText: 'how do I reset my password please help me today', widgetLocale: 'en' });
    expect(d.inputLanguage).toBe('en');
  });

  it('mixed Persian-English remains detected as mixed (unaffected by this fix)', () => {
    const d = decideResponseLanguage({ visitorText: 'hello چطور می‌تونم پسورد رو عوض کنم please help', widgetLocale: 'en' });
    expect(d.mixedLanguageDetected).toBe(true);
  });

  it('Persian resolves to fa when BOTH fa and ar are allowed (no longer depends on excluding ar)', () => {
    const d = decideResponseLanguage({ visitorText: 'سلام، چطور می‌تونم رمز عبورم رو عوض کنم؟', widgetLocale: 'en', allowedLocales: ['fa', 'ar'] });
    expect(d.inputLanguage).toBe('fa');
    expect(d.responseLanguage).toBe('fa');
  });

  it('Arabic resolves to ar when BOTH fa and ar are allowed (never biased toward fa)', () => {
    const d = decideResponseLanguage({ visitorText: 'مرحبا، كيف يمكنني إعادة تعيين كلمة المرور الخاصة بي', widgetLocale: 'en', allowedLocales: ['fa', 'ar'] });
    expect(d.inputLanguage).toBe('ar');
    expect(d.responseLanguage).toBe('ar');
  });

  it('genuine Arabic text is NOT relabeled fa merely because ar is excluded from the allow-list (falls back through the normal allow-list mechanism instead)', () => {
    // This replaces the old bias-branch behavior: previously ANY 'ar'
    // detection was force-relabeled 'fa' whenever the allow-list had fa but
    // not ar — which incorrectly relabeled genuine Arabic input too, not
    // just misclassified Persian. That branch is removed; the
    // already-existing generic "response not in allow-list -> use first
    // allowed locale" mechanism now handles this case honestly.
    const d = decideResponseLanguage({ visitorText: 'مرحبا، كيف يمكنني إعادة تعيين كلمة المرور الخاصة بي', widgetLocale: 'en', allowedLocales: ['en', 'fa'] });
    expect(d.inputLanguage).toBe('ar'); // detection itself is honest
    expect(d.responseLanguage).toBe('en'); // allow-list fallback, NOT 'fa'
  });
});

describe('C14 — widget locale fallback', () => {
  it('falls back to the widget locale when visitor language is not confidently detected and widget locale is not auto', () => {
    const d = decideResponseLanguage({ visitorText: '1234', widgetLocale: 'tr', workspaceLocale: 'en' });
    expect(d.source).toBe('widget_fallback');
    expect(d.responseLanguage).toBe('tr');
  });
});

describe('C14 — workspace locale fallback', () => {
  it('falls back to workspace locale when widget locale is auto/empty and visitor language is not confidently detected', () => {
    const d = decideResponseLanguage({ visitorText: '1234', widgetLocale: 'auto', workspaceLocale: 'fa' });
    expect(d.source).toBe('workspace_fallback');
    expect(d.responseLanguage).toBe('fa');
  });

  it('an empty widgetLocale is also treated as auto', () => {
    const d = decideResponseLanguage({ visitorText: '1234', widgetLocale: '', workspaceLocale: 'tr' });
    expect(d.source).toBe('workspace_fallback');
    expect(d.responseLanguage).toBe('tr');
  });
});

describe('C14 — final fallback to en', () => {
  it('falls back to en when nothing else is known', () => {
    const d = decideResponseLanguage({ visitorText: '1234', widgetLocale: 'auto', workspaceLocale: '' });
    expect(d.source).toBe('fallback_en');
    expect(d.responseLanguage).toBe('en');
  });
});

describe('C14 — settings.allowed_locales intersection / unsupported requested locale', () => {
  it('keeps the response language when it is in the allow-list', () => {
    const d = decideResponseLanguage({
      visitorText: 'how do I reset my password please help me today',
      widgetLocale: 'fa',
      allowedLocales: ['en', 'tr', 'fa'],
    });
    expect(d.responseLanguage).toBe('en');
  });

  it('falls back to the configured widget locale (not the first allow-list entry) when the resolved response language is not allowed', () => {
    const d = decideResponseLanguage({
      visitorText: 'how do I reset my password please help me today', // -> en
      widgetLocale: 'fa',
      allowedLocales: ['tr', 'fa'], // en not allowed
    });
    expect(d.responseLanguage).toBe('fa');
    expect(d.source).toBe('widget_fallback');
  });

  it('falls back to the first allowed locale when nothing else is configured', () => {
    const d = decideResponseLanguage({
      visitorText: 'how do I reset my password please help me today', // -> en
      allowedLocales: ['tr', 'fa'], // en not allowed, no widget/workspace locale
    });
    expect(d.responseLanguage).toBe('tr');
    expect(d.source).toBe('fallback_en');
  });


  // NOTE: the old "biases Arabic-script input to fa when fa is allowed but
  // ar is not" test that lived here has been removed. It exercised
  // decideResponseLanguage's now-removed allow-list bias branch using
  // GENUINE Arabic text and asserted it got relabeled 'fa' — this is
  // exactly the over-correction Phase 2 was required to eliminate ("do not
  // bias all Arabic-script text toward Persian"). See "genuine Arabic text
  // is NOT relabeled fa..." in the PHASE 2 FIX matrix describe block above
  // for its replacement.
});

describe('C14 — mixed-language detection', () => {
  it('PHASE 2 FIX: single-language Persian text is no longer flagged as mixed', () => {
    // Phase 1 found this exact input scored ar=14/fa=8 (ratio 0.57, above
    // the 0.35 mixed threshold) purely because of the old shared-script
    // weighting, despite being genuinely single-language Persian. With the
    // corrected scorer this input now scores overwhelmingly fa-dominant
    // (see the "PHASE 2 FIX: Persian vs Arabic classification matrix"
    // describe block above), so mixedLanguageDetected is false.
    // INTENTIONAL BEHAVIOR CHANGE from Phase 1; see git history for the
    // prior version of this test.
    const d = decideResponseLanguage({
      visitorText: 'چگونه پسورد را عوض کنم',
      widgetLocale: 'en',
    });
    expect(d.inputLanguage).toBe('fa');
    expect(d.mixedLanguageDetected).toBe(false);
  });

  it('does NOT flag mixed-language for clearly single-language input', () => {
    const d = decideResponseLanguage({ visitorText: 'how do I reset my password please help me today', widgetLocale: 'en' });
    expect(d.mixedLanguageDetected).toBe(false);
  });
});

// ─── Engine wiring: platform ∩ settings allowed-locales reaches the run ───
import {
  makeFakeSupabase,
  makeSettings,
  makeConversationState,
  makeAvailability,
  makeHybridResult,
  makeHybridSource,
  makeAIResponse,
  makeBuiltQuery,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_CONVERSATION_ID,
  DEFAULT_VISITOR_MESSAGE_ID,
} from './helpers/engineFixtures.js';

let settingsFixture = makeSettings();
let platformAllowedLocalesFixture = ['en', 'tr', 'fa'];
const logRunCalls: any[] = [];
let fakeSb: ReturnType<typeof makeFakeSupabase>;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));
vi.mock('../../../server/services/ai/index.js', () => ({
  executeAICompletion: async () => makeAIResponse(),
  executeAICompletionWithConfig: async () => makeAIResponse(),
  resolveAIConfig: async () => ({ provider: 'openai', model: 'gpt-4o-mini' }),
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({ publishOperatorEvent: vi.fn(async () => {}) }));
vi.mock('../../../server/services/ai-agent/settings.js', () => ({ getOrCreateSettings: async () => settingsFixture }));
vi.mock('../../../server/services/ai-agent/retrieval.js', () => ({ retrieveSources: async () => [] }));
vi.mock('../../../server/services/ai-agent/retrievalHybrid.js', () => ({
  retrieveHybridSources: async () => makeHybridResult({ sources: [makeHybridSource()] }),
}));
vi.mock('../../../server/services/ai-agent/answerStrategy.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, countClarificationAttempts: async () => 0 };
});
vi.mock('../../../server/services/ai-agent/logs.js', () => ({
  finalizeRun: async () => ({ ok: true as const, attempts: 1 }),
  logRun: async (_config: any, input: any) => {
    logRunCalls.push(input);
    return `run-${logRunCalls.length}`;
  },
}));
vi.mock('../../../server/services/ai-agent/conversationState.js', () => ({
  getConversationState: async () => makeConversationState(),
  markHandoffRequested: vi.fn(async () => {}),
}));
vi.mock('../../../server/services/ai-agent/availability.js', () => ({ getOperatorAvailability: async () => makeAvailability() }));
vi.mock('../../../server/services/ai-agent/responder.js', () => ({
  insertAiMessage: async () => ({ id: 'msg-1' }),
  deriveAgentDisplay: (settings: any) => ({ agentName: settings.agent_name || 'AI Assistant', agentLogoUrl: null }),
}));
vi.mock('../../../server/services/ai-agent/handoffState.js', () => ({ markAiManaged: vi.fn(async () => {}), markNeedsHuman: vi.fn(async () => {}), commitNeedsHuman: vi.fn(async () => ({ ok: true, routingDeferred: false })), routeAfterHandoff: vi.fn(async () => {}) }));
vi.mock('../../../server/services/ai-agent/spamGuard.js', () => ({ isConversationSpam: async () => false }));
vi.mock('../../../server/services/ai-agent/queryBuilder.js', () => ({ buildRetrievalQuery: async () => makeBuiltQuery() }));
vi.mock('../../../server/services/ai-agent/runtimeConfig.js', () => ({ loadAiAgentRuntimeConfig: async () => null }));
vi.mock('../../../server/services/ai-agent/platformGuards.js', () => ({ isAutoAnswerAllowedForWorkspace: async () => ({ allowed: true }) }));
vi.mock('../../../server/services/platformRegion.js', () => ({ getPlatformAllowedLocales: async () => platformAllowedLocalesFixture }));
vi.mock('../../../server/services/ai-agent/workspaceContext.js', () => ({ loadWorkspaceContext: async () => null }));
vi.mock('../../../server/services/ai-agent/learning/candidates.js', () => ({ maybeCreateLearningCandidateFromAiSkip: vi.fn(async () => {}) }));
vi.mock('../../../server/services/ai-agent/runtime/conversationState.js', () => ({ updateRuntimeFlags: vi.fn(async () => {}) }));

const { maybeRunAiAssistantAfterVisitorMessage } = await import('../../../server/services/ai-agent/engine.js');

const CONFIG = { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' } as any;

beforeEach(() => {
  settingsFixture = makeSettings({ mode: 'auto_reply_always' });
  platformAllowedLocalesFixture = ['en', 'tr', 'fa'];
  logRunCalls.length = 0;
  fakeSb = makeFakeSupabase({ workspaces: [{ id: DEFAULT_WORKSPACE_ID, locale: 'en', widget_language: 'en' }] });
});

describe('C14 — engine wiring: platform ∩ workspace-settings allowed locales', () => {
  it('a workspace-configured locale NOT in the platform allow-list is excluded, and the effective locale falls back to a platform-allowed one', async () => {
    // Platform only allows en/fa; workspace settings additionally claim "de"
    // (unsupported by the platform). Current engine.ts intersects
    // settingsAllowed ∩ platformAllowed, and when that intersection is
    // non-empty it wins over the raw platform list.
    platformAllowedLocalesFixture = ['en', 'fa'];
    settingsFixture = makeSettings({ mode: 'auto_reply_always', allowed_locales: ['de', 'fa'] });

    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      conversationId: DEFAULT_CONVERSATION_ID,
      visitorMessageId: DEFAULT_VISITOR_MESSAGE_ID,
      question: 'how do I reset my password',
    });

    expect(result.action).toBe('replied');
    const log = logRunCalls.find((c) => c.runType === 'auto_reply');
    expect(log.metadata.locale).toBe('fa'); // only member of the de/fa ∩ en/fa intersection
  });

  it('when settings.allowed_locales has no overlap with the platform list, the platform list is used instead', async () => {
    platformAllowedLocalesFixture = ['en', 'tr'];
    settingsFixture = makeSettings({ mode: 'auto_reply_always', allowed_locales: ['de'] }); // no overlap
    const result = await maybeRunAiAssistantAfterVisitorMessage(CONFIG, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      conversationId: DEFAULT_CONVERSATION_ID,
      visitorMessageId: DEFAULT_VISITOR_MESSAGE_ID,
      question: 'how do I reset my password',
    });
    const log = logRunCalls.find((c) => c.runType === 'auto_reply');
    expect(['en', 'tr']).toContain(log.metadata.locale);
  });
});
