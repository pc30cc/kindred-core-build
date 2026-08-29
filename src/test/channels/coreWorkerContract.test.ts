// @vitest-environment node
/**
 * CORE ↔ WORKER DEPLOYMENT CONTRACT.
 *
 * Two production blockers are pinned here:
 *
 *  1. READINESS — the Channels Worker refuses to claim jobs until Core
 *     advertises every route it depends on. The required set MUST match what
 *     Core actually serves, otherwise the worker pauses forever on a healthy
 *     deployment (and a stale Core must still pause it).
 *  2. WEBHOOK REPAIR — repair/reconnect targets an ALREADY-OWNED bot, so it
 *     asks Core for the ingress contract, never for the connect preflight.
 */

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNELS_WORKER_REQUIRED_CORE_ROUTES,
  CORE_INTERNAL_SERVICE_NAME,
  INTERNAL_CHANNEL_ROUTES,
  evaluateCoreReadiness,
  missingWorkerRoutes,
} from '../../../shared/channels/internalRoutes.js';

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({}),
  getAnonClient: () => ({}),
}));

// The worker opens real Telegram sockets in production; here every provider
// call is a spy so the contract can be asserted without a network.
const telegram = {
  setWebhook: vi.fn(async () => {}),
  getWebhookInfo: vi.fn(async () => ({ url: '', pending_update_count: 0 })),
};

vi.mock('../../../channels/providers/telegram/client.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    setWebhook: (...args: any[]) => telegram.setWebhook(...(args as [])),
    getWebhookInfo: (...args: any[]) => telegram.getWebhookInfo(...(args as [])),
  };
});

const { internalChannelsRouter } = await import('../../../server/routes/internalChannels.js');
const { __channelsWorkerTesting } = await import('../../../worker/channels/index.js');
const { executeProviderOperation } = await import('../../../worker/channels/providerOperations.js');

const SECRET = 'internal-secret-value';

/** Real Core router, mounted exactly as production mounts it. */
function startCore(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use((req: any, _res, next) => {
    req.serverConfig = { coreInternalSecret: SECRET };
    next();
  });
  app.use('/internal/channels', internalChannelsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** A Core deployment that predates the provider-isolation routes. */
function startStaleCore(routes: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.get('/internal/channels/ready', (_req, res) => {
    res.json({ ok: true, service: CORE_INTERNAL_SERVICE_NAME, build: 'old', routes });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** Records claim attempts so "did the worker start working?" is observable. */
function fakeSupabase() {
  const claims: any[] = [];
  return {
    claims,
    rpc: async (fn: string, args: any) => {
      claims.push({ fn, args });
      return { data: [], error: null };
    },
    from: () => ({
      upsert: async () => ({ error: null }),
      insert: async () => ({ error: null }),
    }),
  };
}

describe('readiness contract (pure)', () => {
  it('every route the worker requires is actually served by Core', () => {
    for (const route of CHANNELS_WORKER_REQUIRED_CORE_ROUTES) {
      expect(INTERNAL_CHANNEL_ROUTES).toContain(route);
    }
  });

  it('accepts a current Core build', () => {
    expect(
      evaluateCoreReadiness({
        service: CORE_INTERNAL_SERVICE_NAME,
        build: 'abc',
        routes: [...INTERNAL_CHANNEL_ROUTES],
      }),
    ).toMatchObject({ ready: true });
  });

  it('names the missing routes of a stale Core', () => {
    const routes = INTERNAL_CHANNEL_ROUTES.filter((r) => r !== 'POST /webhook-contract');
    expect(missingWorkerRoutes(routes)).toEqual(['POST /webhook-contract']);
    const verdict = evaluateCoreReadiness({ service: CORE_INTERNAL_SERVICE_NAME, routes });
    expect(verdict.ready).toBe(false);
    expect((verdict as any).reason).toContain('POST /webhook-contract');
  });

  it('rejects another service answering on the internal base URL', () => {
    const verdict = evaluateCoreReadiness({ service: 'some-other-app', routes: ['GET /ready'] });
    expect(verdict.ready).toBe(false);
    expect((verdict as any).reason).toContain('does not point at the Channels Core service');
  });

  it('rejects a readiness answer with no route contract', () => {
    expect(evaluateCoreReadiness({ service: CORE_INTERNAL_SERVICE_NAME, routes: [] }).ready).toBe(false);
    expect(evaluateCoreReadiness(null).ready).toBe(false);
  });

  it('tolerates Core gaining new routes', () => {
    expect(
      evaluateCoreReadiness({
        service: CORE_INTERNAL_SERVICE_NAME,
        routes: [...INTERNAL_CHANNEL_ROUTES, 'POST /something-new'],
      }).ready,
    ).toBe(true);
  });
});

describe('worker readiness against a live Core', () => {
  let core: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    core = await startCore();
  });
  afterAll(async () => {
    await core.close();
  });

  it('Core /ready advertises the full contract without secrets', async () => {
    const response = await fetch(`${core.url}/internal/channels/ready`, {
      headers: { 'X-Core-Internal-Secret': SECRET },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.service).toBe(CORE_INTERNAL_SERVICE_NAME);
    expect(body.routes).toEqual([...INTERNAL_CHANNEL_ROUTES]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('the worker becomes ready and claims jobs against the current Core', async () => {
    const sb = fakeSupabase();
    __channelsWorkerTesting.configure({ sb, coreBaseUrl: core.url, coreSecret: SECRET });

    await expect(__channelsWorkerTesting.processBatch()).resolves.toBe(0);
    expect(__channelsWorkerTesting.isCoreAuthReady()).toBe(true);
    expect(sb.claims.map((c) => c.fn)).toEqual(['claim_channel_jobs']);
  });

  it('the worker claims nothing when Core is missing a required route', async () => {
    const stale = await startStaleCore([
      'POST /ingest',
      'POST /process-inbound',
      'POST /outbound-result',
      'POST /heartbeat',
      'GET /ready',
    ]);
    try {
      const sb = fakeSupabase();
      __channelsWorkerTesting.configure({ sb, coreBaseUrl: stale.url, coreSecret: SECRET });

      await expect(__channelsWorkerTesting.processBatch()).resolves.toBe(0);
      expect(__channelsWorkerTesting.isCoreAuthReady()).toBe(false);
      expect(sb.claims).toHaveLength(0);
    } finally {
      await stale.close();
    }
  });

  it('the worker claims nothing when the internal secret is wrong', async () => {
    const sb = fakeSupabase();
    __channelsWorkerTesting.configure({ sb, coreBaseUrl: core.url, coreSecret: 'wrong-secret-value' });

    await expect(__channelsWorkerTesting.processBatch()).resolves.toBe(0);
    expect(sb.claims).toHaveLength(0);
  });
});

describe('webhook repair asks Core for the ingress contract', () => {
  const CONTRACT = {
    webhook_url: 'https://channels.example.com/webhook/telegram/pub_one',
    secret_token: 'derived-secret',
    integration_id: 'int_one',
  };

  function ctxFor(calls: Array<{ path: string; body: any }>, contract: any = CONTRACT) {
    return {
      coreGet: async () => ({
        operation: {
          id: 'op-1',
          provider: 'telegram',
          operation: 'webhook_repair',
          workspace_id: 'ws_one',
          integration_id: 'int_one',
          installation_id: 'inst_one',
          request: {},
        },
      }),
      corePost: async (path: string, body: any) => {
        calls.push({ path, body });
        if (path.endsWith('/webhook-contract')) {
          if (!contract) throw new Error('core webhook-contract failed [400]');
          return contract;
        }
        return { ok: true };
      },
      coreUpload: async () => ({ ok: true }),
      resolveToken: async () => '111:TOKEN',
    } as any;
  }

  beforeEach(() => {
    telegram.setWebhook.mockClear();
    telegram.getWebhookInfo.mockClear();
  });

  it('uses /webhook-contract and never the connect preflight', async () => {
    telegram.getWebhookInfo.mockResolvedValueOnce({ url: CONTRACT.webhook_url, pending_update_count: 0 } as any);
    const calls: Array<{ path: string; body: any }> = [];

    await executeProviderOperation(ctxFor(calls), 'op-1');

    const paths = calls.map((c) => c.path);
    expect(paths).toContain('/internal/channels/webhook-contract');
    expect(paths).not.toContain('/internal/channels/connect-preflight');
    expect(telegram.setWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ token: '111:TOKEN' }),
      CONTRACT.webhook_url,
      CONTRACT.secret_token,
      undefined,
    );
    expect(calls.at(-1)).toMatchObject({
      path: '/internal/channels/operation-result',
      body: { operation_id: 'op-1', status: 'succeeded' },
    });
  });

  it('reports a failure instead of guessing when Core cannot supply the contract', async () => {
    const calls: Array<{ path: string; body: any }> = [];

    await executeProviderOperation(ctxFor(calls, null), 'op-1');

    expect(telegram.setWebhook).not.toHaveBeenCalled();
    expect(calls.at(-1)).toMatchObject({
      path: '/internal/channels/operation-result',
      body: { status: 'failed', error_code: 'ingress_unavailable' },
    });
  });

  it('fails the repair when the provider confirms a different URL', async () => {
    telegram.getWebhookInfo.mockResolvedValueOnce({ url: 'https://evil.example.com/hook' } as any);
    const calls: Array<{ path: string; body: any }> = [];

    await executeProviderOperation(ctxFor(calls), 'op-1');

    expect(calls.at(-1)).toMatchObject({
      path: '/internal/channels/operation-result',
      body: { status: 'failed' },
    });
  });
});
