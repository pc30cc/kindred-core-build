/**
 * Super Admin plan bodies (server/routes/plans.ts, phase 6 decision D19):
 * POST and PUT /api/plans/admin take a whitelist of billing_plans columns,
 * refuse an unknown key (400 INVALID_REQUEST with issues) and a negative or
 * fractional price of a currency the edition sells (400 INVALID_PRICE),
 * check the locked-data retention (1-3650 days or empty), store retention,
 * ai_allowance and is_hidden on create, and mirror ai_allowance.IRR into
 * limits.included_ai_allowance_irr (D17).
 *
 * Also billing v2's last admin writers (decision D22): POST
 * /api/billing/admin/grant, /api/billing/admin/plans and
 * /api/admin/billing/reset answer 410 BILLING_V2_RETIRED while
 * LEGACY_BILLING_ENABLED is off, after the admin gate and before any write.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';

type Row = Record<string, unknown>;
/** A JSON answer, read loosely by the assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

const h = vi.hoisted(() => ({
  plans: [] as Row[],
  inserts: [] as Row[],
  updates: [] as Array<{ id: unknown; patch: Row }>,
  db: [] as string[],
  edition: 'international' as 'iran' | 'international',
  admin: true,
  planChanged: vi.fn(async () => ({ ok: true, backgrounded: false, skipped: true })),
}));

function planClient() {
  return {
    from(table: string) {
      h.db.push(table);
      let filterId: unknown;
      let mode: 'select' | 'insert' | 'update' = 'select';
      let payload: Row = {};
      const b: Record<string, unknown> = {
        select: () => b,
        order: () => b,
        eq: (_col: string, value: unknown) => {
          filterId = value;
          return b;
        },
        insert: (row: Row) => {
          mode = 'insert';
          payload = row;
          return b;
        },
        update: (patch: Row) => {
          mode = 'update';
          payload = patch;
          return b;
        },
        maybeSingle: async () => ({ data: h.plans.find((p) => p.id === filterId) ?? null, error: null }),
        single: async () => {
          if (mode === 'insert') {
            const row = { id: 'new-plan', ...payload };
            h.inserts.push(row);
            return { data: row, error: null };
          }
          if (mode === 'update') {
            h.updates.push({ id: filterId, patch: payload });
            const current = h.plans.find((p) => p.id === filterId) ?? {};
            return { data: { ...current, ...payload }, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      };
      return b;
    },
    rpc: async (name: string) => {
      h.db.push(`rpc:${name}`);
      return { data: null, error: null };
    },
    auth: { getUser: async () => ({ data: { user: null }, error: new Error('no') }) },
  };
}

vi.mock('../../../../server/supabase.js', () => ({ getServiceClient: () => planClient() }));
vi.mock('../../../../server/lib/serviceClient.js', () => ({ serviceClientFor: () => planClient() }));
vi.mock('../../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_c: unknown, token: string | undefined) => (token ? { sessionId: 's', userId: 'admin-1', email: 'a@x.test' } : null),
  verifyOriginForMutation: () => true,
}));
vi.mock('../../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async () => h.admin,
  logGateBypass: async () => {},
}));
vi.mock('../../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/platformRegion.js')>()),
  getPlatformEdition: async () => h.edition,
  getPlatformEditionOrNull: async () => h.edition,
}));
vi.mock('../../../../server/services/billing/entitlementChange.js', () => ({
  handlePlanDefinitionChanged: h.planChanged,
  handleWorkspaceEntitlementChanged: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../../../server/middleware/featureGating.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/middleware/featureGating.js')>()),
  clearEntitlementCache: () => {},
}));

const { plansRouter, checkPlanBody } = await import('../../../../server/routes/plans.js');
const { billingRouter } = await import('../../../../server/routes/billing.js');
const { adminBillingRouter } = await import('../../../../server/routes/adminBilling.js');

const app = express();
app.use((req, _res, next) => {
  (req as express.Request & { serverConfig: Record<string, unknown> }).serverConfig = {
    supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'],
  };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/plans', plansRouter);
app.use('/api/billing', billingRouter);
app.use('/api/admin/billing', adminBillingRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function call(method: string, path: string, body?: unknown, token: string | null = 'admin'): Promise<{ status: number; json: Body }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers: Record<string, string> = { connection: 'close' };
  if (token) headers.cookie = `gs_session=${token}`;
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const PLAN_ID = 'plan-1';

beforeEach(() => {
  h.edition = 'international';
  h.admin = true;
  h.inserts.length = 0;
  h.updates.length = 0;
  h.db.length = 0;
  h.planChanged.mockClear();
  h.plans = [{ id: PLAN_ID, is_active: true, entitlements: {}, limits: { max_agents: 3, included_ai_allowance_irr: 1 } }];
});

describe('POST /api/plans/admin', () => {
  it('stores retention, ai_allowance and is_hidden, and mirrors ai_allowance.IRR into the limit', async () => {
    h.edition = 'iran';
    const res = await call('POST', '/api/plans/admin', {
      name: 'Pro', slug: 'pro', prices: { IRR: { monthly: 15_000_000, yearly: 150_000_000 } },
      limits: { max_agents: 5 }, is_hidden: true, locked_data_retention_days: 90, ai_allowance: { IRR: 2_000_000 },
    });
    expect(res.status).toBe(200);
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]).toMatchObject({
      name: 'Pro', slug: 'pro', is_hidden: true, locked_data_retention_days: 90, ai_allowance: { IRR: 2_000_000 },
      limits: expect.objectContaining({ max_agents: 5, included_ai_allowance_irr: 2_000_000 }),
    });
  });

  it('defaults: never deleted, no AI allowance, not hidden', async () => {
    expect((await call('POST', '/api/plans/admin', { name: 'Basic', slug: 'basic' })).status).toBe(200);
    expect(h.inserts[0]).toMatchObject({ locked_data_retention_days: null, ai_allowance: {}, is_hidden: false });
  });

  it('name and slug are required; an unknown key is refused with issues', async () => {
    const missing = await call('POST', '/api/plans/admin', { name: 'No slug' });
    expect(missing).toMatchObject({ status: 400, json: { error: 'INVALID_REQUEST' } });
    expect(missing.json.issues.map((i: { path: string }) => i.path)).toContain('slug');
    const unknown = await call('POST', '/api/plans/admin', { name: 'Pro', slug: 'pro', id: 'x', is_admin: true });
    expect(unknown).toMatchObject({ status: 400, json: { error: 'INVALID_REQUEST' } });
    expect(JSON.stringify(unknown.json.issues)).toContain('unrecognized_keys');
    expect(h.inserts).toEqual([]);
  });
});

describe('PUT /api/plans/admin/:planId', () => {
  it('a whitelisted partial update; unknown keys (id, created_at, anything) are refused', async () => {
    const ok = await call('PUT', `/api/plans/admin/${PLAN_ID}`, { is_hidden: true, locked_data_retention_days: null });
    expect(ok.status).toBe(200);
    expect(h.updates[0].patch).toMatchObject({ is_hidden: true, locked_data_retention_days: null });
    expect(Object.keys(h.updates[0].patch).sort()).toEqual(['is_hidden', 'locked_data_retention_days', 'updated_at']);
    for (const body of [{ id: 'other' }, { created_at: 'x' }, { stripe_secret: 'x' }]) {
      expect((await call('PUT', `/api/plans/admin/${PLAN_ID}`, body)).json.error).toBe('INVALID_REQUEST');
    }
    expect(h.updates).toHaveLength(1);
  });

  it('negative or fractional prices are refused (INVALID_PRICE); a currency the edition does not sell is kept as it is', async () => {
    for (const prices of [{ USD: { monthly: -1 } }, { USD: { monthly: 9.99 } }, { TRY: { yearly: '100' } }, { USD: 5 }, { usd: { monthly: 1 } }]) {
      const res = await call('PUT', `/api/plans/admin/${PLAN_ID}`, { prices });
      expect(res.status, JSON.stringify(prices)).toBe(400);
      expect(res.json.error).toBe('INVALID_PRICE');
    }
    expect(h.updates).toEqual([]);
    // International: a stored Rial price is not judged, and stays.
    const kept = await call('PUT', `/api/plans/admin/${PLAN_ID}`, { prices: { USD: { monthly: 2900, yearly: 29000 }, IRR: { monthly: 'legacy' } } });
    expect(kept.status).toBe(200);
    expect(h.updates[0].patch.prices).toEqual({ USD: { monthly: 2900, yearly: 29000 }, IRR: { monthly: 'legacy' } });
    // Iran sells every currency: the same value is refused there.
    h.edition = 'iran';
    expect((await call('PUT', `/api/plans/admin/${PLAN_ID}`, { prices: { IRR: { monthly: 'legacy' } } })).json.error).toBe('INVALID_PRICE');
  });

  it('retention: 1 to 3650 days, or null', async () => {
    for (const days of [0, -5, 3651, 1.5, '30']) {
      expect((await call('PUT', `/api/plans/admin/${PLAN_ID}`, { locked_data_retention_days: days })).status, String(days)).toBe(400);
    }
    for (const days of [1, 3650, null]) {
      expect((await call('PUT', `/api/plans/admin/${PLAN_ID}`, { locked_data_retention_days: days })).status, String(days)).toBe(200);
    }
  });

  it('ai_allowance: integers >= 0 per currency; IRR is mirrored into the stored limits when the body sends none', async () => {
    for (const allowance of [{ IRR: -1 }, { IRR: 1.5 }, { irr: 1 }, { IRR: '5' }]) {
      expect((await call('PUT', `/api/plans/admin/${PLAN_ID}`, { ai_allowance: allowance })).status, JSON.stringify(allowance)).toBe(400);
    }
    const res = await call('PUT', `/api/plans/admin/${PLAN_ID}`, { ai_allowance: { IRR: 5_000_000, USD: 300 } });
    expect(res.status).toBe(200);
    expect(h.updates[0].patch).toMatchObject({
      ai_allowance: { IRR: 5_000_000, USD: 300 },
      // The stored limits are kept; only the mirrored one changes.
      limits: { max_agents: 3, included_ai_allowance_irr: 5_000_000 },
    });
    // With limits in the body, the mirror goes into those.
    await call('PUT', `/api/plans/admin/${PLAN_ID}`, { ai_allowance: { IRR: 7 }, limits: { max_agents: 9, included_ai_allowance_irr: 1 } });
    expect(h.updates[1].patch.limits).toEqual({ max_agents: 9, included_ai_allowance_irr: 7 });
    // Without IRR nothing is mirrored.
    await call('PUT', `/api/plans/admin/${PLAN_ID}`, { ai_allowance: { USD: 500 } });
    expect(h.updates[2].patch).not.toHaveProperty('limits');
  });

  it('the plan form\'s whole payload passes', async () => {
    const form = {
      name: 'Pro', slug: 'pro', description: '', is_free: false, is_active: true, is_hidden: false, sort_order: 2, trial_days: 14,
      default_currency: 'USD', prices: { USD: { monthly: 2900, yearly: 29000 }, EUR: { monthly: 0, yearly: 0 }, TRY: { monthly: 99900, yearly: 999000 }, IRR: { monthly: 0, yearly: 0 } },
      entitlements: { ai_assistant: true }, limits: { max_agents: 5 }, provider_price_ids: {}, localized: { fa: { name: 'حرفه‌ای', description: '' } },
      locked_data_retention_days: 365, ai_allowance: { USD: 500 },
    };
    expect((await call('PUT', `/api/plans/admin/${PLAN_ID}`, form)).status).toBe(200);
    expect(h.planChanged).toHaveBeenCalledTimes(1);
  });
});

describe('checkPlanBody', () => {
  it('an unknown edition judges every currency', () => {
    expect(checkPlanBody({ prices: { IRR: { monthly: -1 } } }, 'update', null)).toMatchObject({ ok: false, body: { error: 'INVALID_PRICE' } });
    expect(checkPlanBody({ prices: { IRR: { monthly: 1, note: 'x' } } }, 'update', 'international')).toMatchObject({ ok: true });
  });
});

describe('billing v2 admin writers are retired (410)', () => {
  it.each([
    ['/api/billing/admin/grant', { workspaceId: 'w', planId: 'p' }],
    ['/api/billing/admin/plans', { name: 'X', slug: 'x' }],
    ['/api/admin/billing/reset', { confirm: 'RESET-BILLING' }],
  ])('%s answers 410 BILLING_V2_RETIRED and writes nothing', async (path, body) => {
    const res = await call('POST', path, body);
    expect(res).toMatchObject({ status: 410, json: { error: 'BILLING_V2_RETIRED' } });
    expect(h.db.filter((t) => t !== 'rpc:has_role')).toEqual([]);
  });

  it.each(['/api/billing/admin/grant', '/api/billing/admin/plans', '/api/admin/billing/reset'])('%s still needs a platform admin first', async (path) => {
    h.admin = false;
    expect((await call('POST', path, {})).status).toBe(403);
    expect((await call('POST', path, {}, null)).status).toBe(401);
  });
});
