/**
 * The reply language outside the engine's turn (replyLanguage.ts): "Say
 * now" (sayNow.ts, the operator's dictation rewritten for the visitor) and
 * the AI's greeting (intro.ts resolveIntroGreeting) write to the visitor in
 * the agent's voice, so they follow instructions.reply_language as the
 * agent's own replies do: 'workspace_default' writes in the workspace's
 * default language when it is an allowed one; 'visitor' (and unset) keeps
 * each one's rule. Neither ever leaves allowed_locales ∩ the platform's
 * visitor languages (Iran: Persian only) — "Say now" used to ignore the
 * platform's lock and answer an English visitor on a Persian-only platform
 * in English.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSettings } from './helpers/engineFixtures.js';

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  settings: {} as Row,
  platform: ['en', 'fa', 'tr'] as string[],
  workspaceRow: null as Row | null,
  visitorText: 'Hello, where is my order?',
  prompts: [] as string[],
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
        insert: () => Promise.resolve({ data: null, error: null }),
        maybeSingle: async () => ({
          data: table === 'conversations' ? { id: 'c-1', status: 'open', metadata: {} }
            : table === 'workspaces' ? h.workspaceRow
              : null,
          error: null,
        }),
        then: (resolve: (r: { data: Row[]; error: null }) => unknown) => Promise.resolve({
          data: table === 'conversation_messages'
            ? [{ id: 'm-1', sender_type: 'contact', body: h.visitorText, created_at: '2026-11-01T10:00:00Z' }]
            : [],
          error: null,
        }).then(resolve),
      };
      return chain;
    },
  }),
}));
vi.mock('../../../server/services/ai-agent/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/ai-agent/settings.js')>()),
  getOrCreateSettings: async () => h.settings,
}));
vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformRegion.js')>()),
  getPlatformAllowedLocales: async () => h.platform,
  clampLocaleToPlatformRegion: async (_config: unknown, locale?: string) => {
    const l = String(locale || '').toLowerCase().split('-')[0];
    return h.platform.includes(l) ? l : h.platform[0];
  },
}));
vi.mock('../../../server/services/ai/index.js', () => ({
  resolveAIConfig: async () => ({ provider: 'openai', model: 'gpt-4o-mini' }),
  executeAICompletion: async (_config: unknown, input: { systemPrompt: string }) => {
    h.prompts.push(input.systemPrompt);
    return { text: 'Your order ships tomorrow.', provider: 'openai', model: 'gpt-4o-mini' };
  },
}));
vi.mock('../../../server/services/ai-billing/runContext.js', () => ({
  beginAiRunGuarded: async () => null,
  settleAiRun: async () => undefined,
  failAiRun: async () => undefined,
}));
vi.mock('../../../server/services/ai-agent/logs.js', () => ({ logRun: async () => 'run-1' }));
vi.mock('../../../server/services/ai-agent/responder.js', () => ({
  insertAiMessage: async () => ({ id: 'msg-1' }),
  deriveAgentDisplay: () => ({ agentName: 'Aria', agentLogoUrl: null }),
}));
vi.mock('../../../server/services/ai-agent/handoffState.js', () => ({ markAiManaged: async () => {} }));
vi.mock('../../../server/services/ai-agent/platformGuards.js', () => ({
  isAutoAnswerAllowedForWorkspace: async () => ({ allowed: true }),
}));
vi.mock('../../../server/services/ai-agent/visitorAiSnapshot.js', () => ({
  resolveVisitorAiSnapshot: async () => ({ visitorFacing: true, providerReady: true, introCapable: true, reason: 'ok' }),
}));

const { operatorSayNow } = await import('../../../server/services/ai-agent/sayNow.js');
const { resolveIntroGreeting } = await import('../../../server/services/ai-agent/intro.js');

const CONFIG = { supabaseUrl: 'x', supabaseServiceRoleKey: 'z' } as never;

/** The language "Say now" ordered the model to write in. */
async function sayNowLanguage(locale?: string): Promise<string> {
  h.prompts.length = 0;
  const result = await operatorSayNow(CONFIG, {
    workspaceId: 'ws-1', conversationId: 'c-1', operatorId: 'op-1', body: 'it ships tomorrow', locale,
  });
  expect(result.ok).toBe(true);
  // "Persian (Farsi) (fa)": the code is the last parenthesis.
  return /MANDATORY OUTPUT LANGUAGE: [^(]+(?:\([^)]*\) )?\((\w+)\)/.exec(h.prompts[0] || '')?.[1] ?? 'none';
}

async function greeting(locale: string): Promise<string> {
  const result = await resolveIntroGreeting(CONFIG, 'ws-1', locale);
  expect(result.ok).toBe(true);
  return result.ok ? result.body : '';
}

const withReplyLanguage = (reply_language?: string, extra: Row = {}) => makeSettings({
  mode: 'auto_reply_always', agent_name: 'Aria', allowed_locales: ['en', 'fa', 'tr'],
  instructions: reply_language ? { reply_language } : {}, ...extra,
});

beforeEach(() => {
  h.platform = ['en', 'fa', 'tr'];
  h.workspaceRow = { default_locale: 'tr' };
  h.visitorText = 'Hello, where is my order?';
  h.settings = withReplyLanguage();
});

describe('"Say now" follows the reply language', () => {
  it("'visitor' (unset): the visitor's language, as before", async () => {
    expect(await sayNowLanguage('fa')).toBe('en');
  });

  it("'workspace_default': the workspace's default language", async () => {
    h.settings = withReplyLanguage('workspace_default');
    expect(await sayNowLanguage('fa')).toBe('tr');
  });

  it("'workspace_default' with a default outside allowed_locales: the visitor's rule", async () => {
    h.settings = withReplyLanguage('workspace_default', { allowed_locales: ['en', 'fa'] });
    expect(await sayNowLanguage()).toBe('en');
  });

  it("never past the platform's lock: an English visitor on a Persian-only platform reads Persian", async () => {
    h.platform = ['fa'];
    expect(await sayNowLanguage('en')).toBe('fa');
    h.settings = withReplyLanguage('workspace_default');
    expect(await sayNowLanguage('en')).toBe('fa');
  });
});

describe("the greeting follows the reply language", () => {
  it("'visitor' (unset): the widget's language, as before", async () => {
    expect(await greeting('en')).toMatch(/^Hi! I'm Aria/);
  });

  it("'workspace_default': the workspace's default language, the one the answers will be in", async () => {
    h.settings = withReplyLanguage('workspace_default');
    expect(await greeting('en')).toMatch(/^Merhaba! Ben Aria/);
  });

  it("'workspace_default' never passes the platform's languages or allowed_locales", async () => {
    h.settings = withReplyLanguage('workspace_default', { allowed_locales: ['en', 'fa'] });
    expect(await greeting('en')).toMatch(/^Hi! I'm Aria/);
    h.settings = withReplyLanguage('workspace_default');
    h.platform = ['en', 'fa'];
    expect(await greeting('fa')).toMatch(/^سلام! من Aria/);
  });
});
