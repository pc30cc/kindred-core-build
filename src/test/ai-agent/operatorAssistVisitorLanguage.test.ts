/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles are intentionally untyped. */
/**
 * The operator's AI-assist draft (POST /api/ai-agent/operator/suggest-reply,
 * server/routes/ai-agent/operatorAssist.ts) goes to a VISITOR, so its
 * language stays inside the visitors' languages (getPlatformAllowedLocales;
 * Iran: Persian only), as the AI agent's own replies do
 * (engine/contextStage.ts). The panel sends its UI language, which is the
 * dashboard's: on WebYar the Super Admin may open it to English while the
 * visitors stay Persian, and the draft must stay Persian. RESPOK (multi, en
 * and tr) drafts in the operator's language, as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeSettings, makeHybridResult, makeHybridSource } from './helpers/engineFixtures.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  platform: null as Record<string, unknown> | null,
  workspaceLocales: [] as string[],
  visitorText: 'سلام، سفارشم کجاست؟',
  prompts: [] as string[],
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        insert: () => chain,
        update: () => chain,
        maybeSingle: async () => (
          table === 'conversations'
            ? { data: { id: CONVERSATION_ID, workspace_id: WORKSPACE_ID }, error: null }
            : table === 'platform_settings'
              ? { data: h.platform, error: null }
              : { data: null, error: null }
        ),
        single: async () => ({ data: null, error: null }),
        then: (resolve: any) => resolve(
          table === 'conversation_messages'
            ? { data: [{ id: 'm1', sender_type: 'visitor', body: h.visitorText, created_at: '2026-10-31T00:00:00Z' }], error: null }
            : { data: [], error: null },
        ),
      };
      return chain;
    },
  }),
}));
vi.mock('../../../server/routes/ai-agent/shared.js', () => ({
  authorizeMember: async () => ({ userId: 'user-1', role: 'admin', isAdmin: false }),
  isOwnerOrAdmin: () => true,
  requireWorkspace: () => true,
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkEntitlementFromDB: async () => ({ allowed: true, plan: 'pro' }),
}));
vi.mock('../../../server/services/ai-agent/settings.js', () => ({
  getOrCreateSettings: async () => makeSettings({ allowed_locales: h.workspaceLocales }),
}));
vi.mock('../../../server/services/ai-agent/retrievalHybrid.js', () => ({
  retrieveHybridSources: async () => makeHybridResult({ sources: [makeHybridSource()] }),
}));
vi.mock('../../../server/services/ai-agent/answerStrategy.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, countClarificationAttempts: async () => 0 };
});
vi.mock('../../../server/services/ai-billing/runContext.js', () => ({
  beginAiRunGuarded: async () => null,
  settleAiRun: async () => undefined,
  failAiRun: async () => undefined,
}));
vi.mock('../../../server/services/ai/index.js', () => ({
  resolveAIConfig: async () => ({ provider: 'openai', model: 'gpt-4o-mini' }),
  executeAICompletion: async (_c: unknown, input: { systemPrompt: string }) => {
    h.prompts.push(input.systemPrompt);
    return { text: 'draft', provider: 'openai', model: 'gpt-4o-mini' };
  },
}));
vi.mock('../../../server/services/ai-agent/logs.js', () => ({ logRun: async () => 'run_x' }));

const { operatorAssistRouter } = await import('../../../server/routes/ai-agent/operatorAssist.js');
const { __resetPlatformRegionCache } = await import('../../../server/services/platformRegion.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'k' };
  next();
});
app.use(express.json());
app.use('/api/ai-agent', operatorAssistRouter);

function platform(row: Record<string, unknown>) {
  h.platform = row;
  __resetPlatformRegionCache();
}

/** The draft's language, as the prompt orders it. */
async function draftLanguage(locale: string): Promise<string> {
  h.prompts.length = 0;
  const res = await request(app)
    .post('/api/ai-agent/operator/suggest-reply')
    .send({ workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID, locale });
  expect(res.status).toBe(200);
  expect(h.prompts).toHaveLength(1);
  const match = /MANDATORY OUTPUT LANGUAGE: [^(]+(?:\([^)]*\) )?\((\w+)\)/.exec(h.prompts[0]);
  return match?.[1] ?? 'none';
}

const WEBYAR_EN_PANEL = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'multi_language' };
const RESPOK = { region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'en', site_mode: 'multi_language' };

beforeEach(() => {
  h.workspaceLocales = [];
  h.visitorText = 'سلام، سفارشم کجاست؟';
  platform(WEBYAR_EN_PANEL);
});

describe('the operator-assist draft is in a visitor language', () => {
  it('WebYar with an English dashboard: the draft is Persian, whatever the panel reads', async () => {
    expect(await draftLanguage('en')).toBe('fa');
    expect(await draftLanguage('tr')).toBe('fa');
    expect(await draftLanguage('fa')).toBe('fa');
  });

  it('WebYar: a workspace that also lists English still drafts Persian', async () => {
    h.workspaceLocales = ['fa', 'en'];
    expect(await draftLanguage('en')).toBe('fa');
    h.workspaceLocales = ['en'];
    expect(await draftLanguage('en')).toBe('fa');
  });

  it('RESPOK (multi, en and tr): the operator\'s own language, as before', async () => {
    platform(RESPOK);
    h.visitorText = 'Merhaba, fiyat nedir?';
    expect(await draftLanguage('en')).toBe('en');
    expect(await draftLanguage('tr')).toBe('tr');
    h.workspaceLocales = ['en', 'tr'];
    expect(await draftLanguage('tr')).toBe('tr');
    h.workspaceLocales = ['tr'];
    expect(await draftLanguage('en')).toBe('tr');
  });
});
