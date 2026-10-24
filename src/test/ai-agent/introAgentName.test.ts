/**
 * The intro's answer (POST /api/widget/ai-agent/intro) names the agent as
 * the row stores it, the built-in English name ('AI Assistant') included,
 * as on realtime, /poll and /history (realtime/publish.ts,
 * widget/senderIdentity.ts): the runtime.js loaded before this release
 * labels the intro bubble with it. Today's runtime treats the built-in name
 * as no name (runtime.js aiOwnName; src/test/widget/aiNamelessRun.test.ts).
 * The intro's text never speaks it: an agent without a name of its own
 * introduces itself as an AI assistant, in the visitor's language.
 *
 * maybeSendIntro runs for real; the data layer, the gates and the message
 * insert are fakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ settings: {} as Row, inserted: [] as Row[] }));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      // c-1, the conversation the tests name, is this workspace's and open.
      let named = false;
      const api: Record<string, unknown> = {
        select: () => api, neq: () => api, is: () => api, in: () => api, or: () => api, order: () => api, limit: () => api, contains: () => api,
        eq: (col: string, val: unknown) => { if (table === 'conversations' && col === 'id' && val === 'c-1') named = true; return api; },
        insert: () => Promise.resolve({ data: null, error: null }),
        maybeSingle: async () => ({ data: named ? { id: 'c-1' } : null, error: null }),
        then: (resolve: (r: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return api;
    },
  }),
}));
vi.mock('../../../server/services/ai-agent/platformGuards.js', () => ({
  isAutoAnswerAllowedForWorkspace: async () => ({ allowed: true }),
}));
vi.mock('../../../server/services/ai-agent/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/ai-agent/settings.js')>()),
  getOrCreateSettings: async () => state.settings,
}));
vi.mock('../../../server/services/ai-agent/visitorAiSnapshot.js', () => ({
  resolveVisitorAiSnapshot: async () => ({ visitorFacing: true, providerReady: true, introCapable: true, reason: 'ok' }),
}));
vi.mock('../../../server/services/ai-agent/responder.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/ai-agent/responder.js')>()),
  insertAiMessage: async (_config: unknown, input: Row) => {
    state.inserted.push(input);
    return { id: 'm-intro' };
  },
}));
vi.mock('../../../server/services/ai-agent/logs.js', () => ({ logRun: async () => undefined }));
vi.mock('../../../server/services/billing/conversationLimit.js', () => ({ checkMaxConversationsAllowance: async () => ({ allowed: true }) }));
vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformRegion.js')>()),
  clampLocaleToPlatformRegion: async (_config: unknown, locale: string) => locale,
  getPlatformAllowedLocales: async () => ['fa'],
}));

const { maybeSendIntro } = await import('../../../server/services/ai-agent/intro.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;

function settings(agent_name: string | null): Row {
  return {
    enabled: true, mode: 'auto_reply', ai_intro_enabled: true, agent_name, agent_logo_url: null,
    intro_message_localized: null, intro_message: null, welcome_message: null,
  };
}

beforeEach(() => {
  state.inserted = [];
});

describe('the intro\'s answer names the agent as the row stores it', () => {
  for (const name of ['AI Assistant', null]) {
    it(`agent_name ${JSON.stringify(name)}: the built-in name in the answer, not in the text`, async () => {
      state.settings = settings(name);
      const result = await maybeSendIntro(CONFIG, { workspaceId: 'ws-1', conversationId: 'c-1', locale: 'fa' });
      expect(result.sent).toBe(true);
      expect(result.agentName).toBe('AI Assistant');
      expect(result.body).not.toContain('AI Assistant');
    });
  }

  it('a name the owner chose is in the answer', async () => {
    state.settings = settings('نیلو');
    const result = await maybeSendIntro(CONFIG, { workspaceId: 'ws-1', conversationId: 'c-1', locale: 'fa' });
    expect(result.agentName).toBe('نیلو');
    expect(state.inserted[0]?.agentName).toBe('نیلو');
  });

  it('the preview (chat open since 2026-10-24) names the agent and words the text exactly as the written intro', async () => {
    for (const name of ['AI Assistant', null, 'نیلو']) {
      state.settings = settings(name);
      state.inserted = [];
      const written = await maybeSendIntro(CONFIG, { workspaceId: 'ws-1', conversationId: 'c-1', locale: 'fa' });
      const preview = await maybeSendIntro(CONFIG, { workspaceId: 'ws-1', locale: 'fa', preview: true });
      expect(preview).toMatchObject({ sent: true, preview: true, agentName: written.agentName, agentLogoUrl: written.agentLogoUrl, body: written.body });
      expect(state.inserted).toHaveLength(1);
    }
  });
});
