/**
 * RESTRICTED-NETWORK ENTRYPOINT COVERAGE — AI Agent operator assist.
 *
 * Real HTTP request to POST /api/ai-agent/operator/suggest-reply with
 * provider egress blocked for Core. The suggestion's provider orchestration
 * (resolveAIConfig / executeAICompletion / runtimeClient → REAL runtime
 * handler) is untouched; membership, entitlement and conversation IO are
 * faked because they are outside the network boundary under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeSettings, makeHybridResult, makeHybridSource } from '../ai-agent/helpers/engineFixtures.js';
import {
  installRestrictedNetwork,
  restrictedServerConfig,
  RUNTIME_BASE,
  type RestrictedNetwork,
} from './helpers/restrictedNetwork.js';
import { AI_RUNTIME_ROUTES } from '../../../shared/ai/internalRoutes.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        insert: async () => ({ data: null, error: null }),
        maybeSingle: async () =>
          table === 'conversations'
            ? { data: { id: CONVERSATION_ID, workspace_id: WORKSPACE_ID }, error: null }
            : { data: null, error: null },
        single: async () =>
          table === 'provider_configs'
            ? {
                data: { provider_name: 'openai', config: { api_key: 'sk-key', model: 'gpt-4o-mini' } },
                error: null,
              }
            : { data: null, error: null },
        then: (resolve: any) =>
          resolve(
            table === 'conversation_messages'
              ? {
                  data: [
                    { id: 'm1', sender_type: 'visitor', body: 'My invoice is wrong', created_at: '2026-01-01T00:00:00Z' },
                  ],
                  error: null,
                }
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
  getOrCreateSettings: async () => makeSettings(),
}));

vi.mock('../../../server/services/ai-agent/retrievalHybrid.js', () => ({
  retrieveHybridSources: async () => makeHybridResult({ sources: [makeHybridSource()] }),
}));

vi.mock('../../../server/services/ai-agent/answerStrategy.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, countClarificationAttempts: async () => 0 };
});

const { operatorAssistRouter } = await import('../../../server/routes/ai-agent/operatorAssist.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = restrictedServerConfig();
  next();
});
app.use(express.json());
app.use('/api/ai-agent', operatorAssistRouter);

let net: RestrictedNetwork;
beforeEach(() => {
  net = installRestrictedNetwork();
});
afterEach(() => vi.unstubAllGlobals());

describe('restricted network — AI Agent operator assist (suggest-reply)', () => {
  it('drafts an operator suggestion through the AI Runtime with zero provider egress from Core', async () => {
    const res = await request(app)
      .post('/api/ai-agent/operator/suggest-reply')
      .send({ workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID, locale: 'en' });

    expect(res.status).toBe(200);
    expect(res.body.suggestion).toBe('hello from provider');

    expect(net.runtimeHits).toEqual([`${RUNTIME_BASE}${AI_RUNTIME_ROUTES.complete}`]);
    expect(net.providerHits).toHaveLength(1);
    expect(net.coreProviderViolations).toEqual([]);
    expect(net.otherHits).toEqual([]);
  });
});
