/**
 * "Auto-reply when operators are offline" does not greet while the team is
 * online (R-02).
 *
 * The AI's greeting marks the conversation the AI's (`ai_state:
 * ai_managed`). In this mode the AI only drafts suggestions while operators
 * are online (runtimePolicy.ts), so a daytime greeting parked the chat in the
 * AI's queue — out of the Inbox, with no notification — while nobody
 * answered it. Now the intro is not sent then (reason `operators_online`):
 * the visitor gets the widget's ordinary greeting and the conversation is the
 * team's. Offline, the AI greets as before.
 *
 * maybeSendIntro runs for real; the data layer, the gates, availability and
 * the message insert are fakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ settings: {} as Row, inserted: [] as Row[], created: [] as Row[], teamOnline: true }));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => {
      const api: Record<string, unknown> = {
        select: () => api, eq: () => api, neq: () => api, is: () => api, order: () => api, limit: () => api, contains: () => api,
        insert: (row: Row) => {
          state.created.push(row);
          return { select: () => ({ single: async () => ({ data: { id: 'c-new' }, error: null }) }), then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r) };
        },
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (r: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return api;
    },
  }),
}));
vi.mock('../../../server/services/ai-agent/platformGuards.js', () => ({ isAutoAnswerAllowedForWorkspace: async () => ({ allowed: true }) }));
vi.mock('../../../server/services/ai-agent/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/ai-agent/settings.js')>()),
  getOrCreateSettings: async () => state.settings,
}));
vi.mock('../../../server/services/ai-agent/visitorAiSnapshot.js', () => ({
  resolveVisitorAiSnapshot: async () => ({ visitorFacing: true, providerReady: true, introCapable: true, reason: 'ok' }),
}));
vi.mock('../../../server/services/ai-agent/availability.js', () => ({
  getOperatorAvailability: async () => ({ state: state.teamOnline ? 'online' : 'offline', reason: 'test', source: 'widget_resolver', schedule: null }),
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
vi.mock('../../../server/services/widget/anonymousContact.js', () => ({ ensureVisitorContact: async () => null }));
vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformRegion.js')>()),
  clampLocaleToPlatformRegion: async (_config: unknown, locale: string) => locale,
  getPlatformAllowedLocales: async () => ['fa'],
}));

const { maybeSendIntro } = await import('../../../server/services/ai-agent/intro.js');
const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;

beforeEach(() => {
  state.inserted = [];
  state.created = [];
  state.settings = { enabled: true, mode: 'auto_reply_when_offline', ai_intro_enabled: true, agent_name: null, intro_message_localized: null };
});

describe('the intro in "auto-reply when operators are offline"', () => {
  it('the team is online: no greeting, no AI-held conversation', async () => {
    state.teamOnline = true;
    const result = await maybeSendIntro(CONFIG, { workspaceId: 'ws-1', visitorSessionId: 's-1', locale: 'fa' });
    expect(result).toEqual({ sent: false, reason: 'operators_online' });
    expect(state.created).toEqual([]);
    expect(state.inserted).toEqual([]);
  });

  it('the team is offline: the AI greets, and the conversation is the AI\'s', async () => {
    state.teamOnline = false;
    const result = await maybeSendIntro(CONFIG, { workspaceId: 'ws-1', visitorSessionId: 's-1', locale: 'fa' });
    expect(result).toMatchObject({ sent: true, conversationId: 'c-new' });
    expect(state.created[0]).toMatchObject({ metadata: expect.objectContaining({ ai_state: 'ai_managed' }) });
    expect(state.inserted).toHaveLength(1);
  });

  it('the other auto modes greet whatever the team does', async () => {
    state.teamOnline = true;
    for (const mode of ['auto_reply_always', 'auto_reply_until_human_joins']) {
      state.inserted = [];
      state.settings = { ...state.settings, mode };
      expect((await maybeSendIntro(CONFIG, { workspaceId: 'ws-1', conversationId: 'c-1', locale: 'fa' })).sent, mode).toBe(true);
    }
  });
});
