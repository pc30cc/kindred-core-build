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

  it('SURPRISING FINDING (documented, not fixed): plain Persian text without an fa-favoring allow-list is detected as "ar", not "fa"', () => {
    // detectInputLanguageDetailed() scores every Arabic-script character
    // (U+0600-U+06FF etc.) toward `ar`, and ONLY the six Persian-specific
    // letters (پ چ ژ ک گ ی) toward `fa` (at 2x weight vs ar's 1x). For
    // ordinary Persian sentences, the many shared Arabic-script characters
    // usually outweigh the few Persian-only letters, so plain Persian input
    // resolves to inputLanguage='ar' UNLESS the caller's allowedLocales
    // includes 'fa' but not 'ar' (see decideResponseLanguage's explicit
    // "Bias Persian" comment/branch, exercised in the allow-list describe
    // block below). This is exactly why that bias branch exists — it is
    // pinned here as a real, current characterization, not fixed.
    const d = decideResponseLanguage({
      visitorText: 'چگونه پسورد را عوض کنم',
      widgetLocale: 'en',
      workspaceLocale: 'en',
    });
    expect(d.inputLanguage).toBe('ar');
    expect(d.responseLanguage).toBe('ar');
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

  it('falls back to the first allowed locale when the resolved response language is not in the allow-list (unsupported requested locale)', () => {
    const d = decideResponseLanguage({
      visitorText: 'how do I reset my password please help me today', // -> en
      widgetLocale: 'fa',
      allowedLocales: ['tr', 'fa'], // en not allowed
    });
    expect(d.responseLanguage).toBe('tr');
    expect(d.source).toBe('fallback_en'); // pinned as-is: `source` stays 'fallback_en' for ANY allow-list override, not just the literal en case
  });

  it('biases Arabic-script input to fa when fa is allowed but ar is not (documented special case)', () => {
    const d = decideResponseLanguage({
      visitorText: 'كيف يمكنني إعادة تعيين كلمة المرور',
      widgetLocale: 'en',
      allowedLocales: ['en', 'fa'],
    });
    expect(d.inputLanguage).toBe('fa');
    expect(d.responseLanguage).toBe('fa');
  });
});

describe('C14 — mixed-language detection', () => {
  it('flags mixed-language input when a second script has a comparable signal to the dominant one (ar/fa ambiguity from the same finding above)', () => {
    const d = decideResponseLanguage({
      visitorText: 'چگونه پسورد را عوض کنم',
      widgetLocale: 'en',
    });
    // Same input as the "ar vs fa" finding above: ar=14, fa=8 -> fa/ar
    // ratio 0.57 >= the mixed threshold (0.35), so this is flagged mixed
    // even though it's genuinely single-language (Persian) text — a second
    // real, current-behavior quirk of the shared-script scoring approach.
    expect(d.mixedLanguageDetected).toBe(true);
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
vi.mock('../../../server/services/ai-agent/handoffState.js', () => ({ markAiManaged: vi.fn(async () => {}), markNeedsHuman: vi.fn(async () => {}) }));
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
