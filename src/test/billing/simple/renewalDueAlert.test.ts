/**
 * The alerts bell (server/routes/workspaceAlerts.ts) warns of a paid period
 * that will not renew (renewalNotice.ts): 'renewal_due', critical in the
 * last 2 days, linking to the billing page — unless the older
 * 'subscription_ending' (cancel_at_period_end) already says so.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';

let notice: Record<string, unknown> | null = null;
let sub: Record<string, unknown> | null = null;

vi.mock('../../../../server/services/billing/account/renewalNotice.js', () => ({
  renewalDueNotice: async () => notice,
}));
vi.mock('../../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async () => ({ userId: 'u1' }),
  serverConfigOf: () => ({}),
}));
vi.mock('../../../../server/middleware/featureGating.js', () => ({
  getWorkspacePlanInfo: async () => ({ plan: { name: 'Pro' }, subscription: sub, limits: {} }),
}));
vi.mock('../../../../server/services/auth/identity.js', () => ({
  findIdentityById: async () => ({ emailVerifiedAt: '2026-01-01T00:00:00Z' }),
}));
vi.mock('../../../../server/services/phoneVerification/index.js', () => ({
  getPhoneVerificationState: async () => ({ verified: true }),
}));
vi.mock('../../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
      return b;
    },
  }),
}));

const { workspaceAlertsRouter } = await import('../../../../server/routes/workspaceAlerts.js');

const app = express();
app.use('/api/workspace-alerts', workspaceAlertsRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function alerts(): Promise<Array<Record<string, unknown>>> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/api/workspace-alerts/w1' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body).alerts));
      })
      .on('error', reject);
  });
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

beforeEach(() => {
  notice = null;
  sub = { status: 'active', current_period_end: inDays(4), cancel_at_period_end: false };
});

describe('renewal_due alert', () => {
  it('none while the period renews', async () => {
    expect((await alerts()).map((a) => a.kind)).not.toContain('renewal_due');
  });

  it('a warning with its days, dismissible, linking to billing', async () => {
    notice = { days_left: 4, period_end: inDays(4), plan_id: 'pro', ends_on_free: false, card_past_due: false };
    const alert = (await alerts()).find((a) => a.kind === 'renewal_due');
    expect(alert).toMatchObject({
      id: 'renewal_due', severity: 'warning', params: { days: '4', plan: 'Pro' }, action: '/billing', dismissible: true,
    });
  });

  it('critical (not dismissible) in the last 2 days', async () => {
    notice = { days_left: 2, period_end: inDays(1.5), plan_id: 'pro', ends_on_free: false, card_past_due: false };
    const alert = (await alerts()).find((a) => a.kind === 'renewal_due');
    expect(alert).toMatchObject({ severity: 'critical', dismissible: false });
  });

  it('a change to Free the customer chose is its own kind (cancelling it keeps the plan; renewing is refused)', async () => {
    notice = { days_left: 2, period_end: inDays(1.5), plan_id: 'pro', ends_on_free: true, card_past_due: false };
    const kinds = (await alerts()).map((a) => a.kind);
    expect(kinds).toContain('change_to_free');
    expect(kinds).not.toContain('renewal_due');
  });

  it('not twice when subscription_ending already warns', async () => {
    sub = { status: 'active', current_period_end: inDays(4), cancel_at_period_end: true };
    notice = { days_left: 4, period_end: inDays(4), plan_id: 'pro', ends_on_free: false, card_past_due: false };
    const kinds = (await alerts()).map((a) => a.kind);
    expect(kinds).toContain('subscription_ending');
    expect(kinds).not.toContain('renewal_due');
  });
});
