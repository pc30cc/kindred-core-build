/**
 * PUT /api/billing/account/:workspaceId/profile (routes/billingAccount.ts):
 * `invoice_email`, where receipts go, is blank or exactly one plain address,
 * checked at the route before anything is stored (platform:M2). Any text with
 * an "@" used to be taken, and a comma list went, over SMTP, to every address
 * in it. The refusal is the service's own code (INVALID_INVOICE_EMAIL, with
 * the field), so the page shows the same message either way.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';

const WS = '11111111-1111-4111-8111-111111111111';
const h = vi.hoisted(() => ({ saved: [] as Array<Record<string, unknown>> }));

vi.mock('../../../../server/lib/workspaceAuth.js', () => ({
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
  authorizeWorkspaceAccess: async () => ({ userId: 'u1', isAdmin: false, role: 'owner' }),
}));
vi.mock('../../../../server/services/billing/account/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../../server/services/billing/account/index.js')>()),
  updateBillingProfile: async (_c: unknown, _ws: string, profile: Record<string, unknown>) => {
    h.saved.push(profile);
    return { billing_profile: profile };
  },
}));

const { billingAccountRouter } = await import('../../../../server/routes/billingAccount.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k', corsOrigins: [] };
  next();
});
app.use(express.json());
app.use('/api/billing', billingAccountRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

function put(profile: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ profile });
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/api/billing/account/${WS}/profile`, method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) : {} }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

beforeEach(() => { h.saved.length = 0; });

describe('invoice_email at the route', () => {
  for (const bad of ['a@x.com, b@y.com', 'a@x.com;b@y.com', 'Finance <a@x.com>', 'not an address @', 'a@x.com\nBcc: c@z.com']) {
    it(`refuses ${JSON.stringify(bad)} before anything is stored`, async () => {
      const res = await put({ company: 'Acme', invoice_email: bad });
      expect(res).toEqual({ status: 400, body: { error: 'INVALID_INVOICE_EMAIL', details: { field: 'invoice_email' } } });
      expect(h.saved).toEqual([]);
    });
  }

  it('takes one plain address, and a blank one (the owner\'s address is then used)', async () => {
    expect((await put({ invoice_email: ' billing@acme.example ' })).status).toBe(200);
    expect((await put({ invoice_email: '' })).status).toBe(200);
    expect((await put({ company: 'Acme' })).status).toBe(200);
    expect(h.saved).toHaveLength(3);
  });
});
