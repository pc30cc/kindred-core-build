/**
 * RESTRICTED-NETWORK ENTRYPOINT COVERAGE — POST /api/ai/complete.
 *
 * Real HTTP request through the real router, with provider egress blocked
 * for Core. Nothing on the AI egress path is mocked: the route calls the
 * real executeAICompletion → resolveAIConfig → runtimeClient → REAL runtime
 * handler → provider mock. Auth/entitlement/credits are stubbed because they
 * are not part of the network boundary under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  installRestrictedNetwork,
  restrictedServerConfig,
  RUNTIME_BASE,
  type RestrictedNetwork,
} from './helpers/restrictedNetwork.js';
import { AI_RUNTIME_ROUTES } from '../../../shared/ai/internalRoutes.js';

const usageLogs: any[] = [];

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        single: async () =>
          table === 'provider_configs'
            ? {
                data: { provider_name: 'openai', config: { api_key: 'sk-key', model: 'gpt-4o-mini' } },
                error: null,
              }
            : { data: null, error: null },
        insert: async (row: any) => {
          if (table === 'ai_usage_logs') usageLogs.push(row);
          return { data: null, error: null };
        },
      };
      return chain;
    },
  }),
}));

vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async () => true,
  requirePlatformAdmin: async () => false,
  checkOutboundUrl: async () => ({ ok: true }),
}));

vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkModuleAccess: async () => ({ allowed: true }),
  deductAICredits: async () => ({ success: true, credits_used: 1, credits_limit: 100 }),
  incrementUsage: () => {},
}));

vi.mock('../../../server/middleware/security.js', () => ({
  logSecurityEvent: async () => {},
}));

const { aiRouter } = await import('../../../server/routes/ai.js');

const CONFIG = restrictedServerConfig();
const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = CONFIG;
  next();
});
app.use(express.json());
app.use('/api/ai', aiRouter);

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
let net: RestrictedNetwork;

beforeEach(() => {
  usageLogs.length = 0;
  net = installRestrictedNetwork();
});
afterEach(() => vi.unstubAllGlobals());

describe('restricted network — POST /api/ai/complete', () => {
  it('completes via the AI Runtime while Core has zero provider egress', async () => {
    const res = await request(app)
      .post('/api/ai/complete')
      .send({ workspaceId: WORKSPACE_ID, prompt: 'Hello there' });

    expect(res.status).toBe(200);
    expect(res.body.text).toBe('hello from provider');

    expect(net.runtimeHits).toEqual([`${RUNTIME_BASE}${AI_RUNTIME_ROUTES.complete}`]);
    expect(net.providerHits).toHaveLength(1);
    expect(net.coreProviderViolations).toEqual([]);
    expect(net.otherHits).toEqual([]);
  });

  it('surfaces a runtime failure as an error instead of falling back to a provider call from Core', async () => {
    // Runtime configured but the secret is wrong → runtime_unauthorized.
    (app as any).set('x', 0);
    const badApp = express();
    badApp.use((req, _res, next) => {
      (req as any).serverConfig = restrictedServerConfig({ aiRuntimeInternalSecret: 'wrong-secret' });
      next();
    });
    badApp.use(express.json());
    badApp.use('/api/ai', aiRouter);

    const res = await request(badApp)
      .post('/api/ai/complete')
      .send({ workspaceId: WORKSPACE_ID, prompt: 'Hello there' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    // Core still only ever spoke to the runtime; no provider fallback.
    expect(net.runtimeHits.length).toBeGreaterThan(0);
    expect(net.providerHits).toEqual([]);
    expect(net.coreProviderViolations).toEqual([]);
  });
});
