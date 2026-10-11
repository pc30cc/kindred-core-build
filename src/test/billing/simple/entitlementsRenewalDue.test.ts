/**
 * The panel's renewal banner and sidebar read `renewal_due` from the
 * entitlements snapshot (GET /api/plans/workspace/:id/effective), which
 * passes renewalNotice.ts's answer field by field: a saved card whose
 * renewal payment failed (phase 3b) must reach the client as card_past_due.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';

let notice: Record<string, unknown> | null = null;

vi.mock('../../../../server/services/billing/account/renewalNotice.js', () => ({
  renewalDueNotice: async () => notice,
}));
vi.mock('../../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async () => ({ userId: 'u1' }),
  requirePlatformAdmin: async () => false,
}));
vi.mock('../../../../server/middleware/featureGating.js', () => ({
  checkEntitlementFromDB: async () => ({ allowed: true }),
  checkModuleAccess: async () => ({ allowed: true }),
  checkChannelAccess: async () => ({ allowed: true }),
  getWorkspacePlanInfo: async () => ({ plan: null, subscription: null, entitlements: {}, limits: {} }),
  getWorkspacePlanInfoDetailed: async () => ({
    ok: true,
    value: { plan: { name: 'Pro', slug: 'pro' }, subscription: null, entitlements: {}, limits: {}, planLimits: {}, limitOverrides: {} },
  }),
  clearEntitlementCache: () => {},
}));
vi.mock('../../../../server/lib/serviceClient.js', () => ({
  serviceClientFor: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
      return b;
    },
  }),
}));

const { plansRouter } = await import('../../../../server/routes/plans.js');

const app = express();
app.use((req, _res, next) => {
  (req as express.Request & { serverConfig?: unknown }).serverConfig = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'SERVICE_KEY',
  };
  next();
});
app.use('/api/plans', plansRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function effective(): Promise<Record<string, unknown>> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/api/plans/workspace/w1/effective' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
}

beforeEach(() => {
  notice = null;
});

describe('entitlements snapshot: renewal_due', () => {
  it('null while nothing is due', async () => {
    expect((await effective()).renewal_due).toBeNull();
  });

  it("carries the saved card's failed renewal (card_past_due)", async () => {
    notice = { days_left: 1, period_end: '2026-11-09T10:00:00.000Z', plan_id: 'pro', ends_on_free: false, card_past_due: true };
    expect((await effective()).renewal_due).toEqual({
      days_left: 1, period_end: '2026-11-09T10:00:00.000Z', ends_on_free: false, card_past_due: true,
    });
  });

  it('card_past_due is false without a failed card payment', async () => {
    notice = { days_left: 3, period_end: '2026-11-09T10:00:00.000Z', plan_id: 'pro', ends_on_free: true, card_past_due: false };
    expect((await effective()).renewal_due).toEqual({
      days_left: 3, period_end: '2026-11-09T10:00:00.000Z', ends_on_free: true, card_past_due: false,
    });
  });
});
