/**
 * Super Admin → AI credit packs (server/routes/adminSimpleBilling.ts, phase 5):
 * GET/PUT /ai-packs per edition. A PUT validates with the shared rules
 * (400 AI_PACKS_INVALID naming the field) and writes ONLY ai_packs, so the
 * seller, VAT and receipt prefix stay; PUT /settings never sends ai_packs,
 * so saving the other settings keeps the packs.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

const h = vi.hoisted(() => ({
  edition: 'international' as 'iran' | 'international',
  mode: 'METER_ONLY' as 'METER_ONLY' | 'ENFORCED',
  stored: {} as Record<string, unknown>,
  rates: { USD: 600_000, TRY: null, IRR: 1 } as Record<string, number | null>,
  upserts: [] as Array<{ row: Record<string, unknown>; options: unknown }>,
}));

vi.mock('../../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => ({
      upsert: async (row: Record<string, unknown>, options: unknown) => {
        if (table === 'billing_settings') h.upserts.push({ row, options });
        return { error: null };
      },
    }),
    rpc: async (name: string, args: { p_currency: string }) =>
      name === 'billing_ai_wallet_rate' ? { data: h.rates[args.p_currency] ?? null, error: null } : { data: null, error: { message: 'unexpected' } },
  }),
}));
vi.mock('../../../../server/lib/workspaceAuth.js', () => ({ serverConfigOf: () => ({}) }));
vi.mock('../../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/platformRegion.js')>()),
  getPlatformEdition: async () => h.edition,
}));
vi.mock('../../../../server/services/ai-billing/mode.js', () => ({ getBillingMode: async () => h.mode }));
vi.mock('../../../../server/services/billing/account/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/account/index.js')>()),
  getBillingSettings: async (_c: unknown, edition: string) => ({
    edition, seller: {}, vat_percent: { USD: 10, IRR: 10 }, receipt_prefix: 'R', ai_packs: h.stored,
  }),
}));

const { adminSimpleBillingRouter } = await import('../../../../server/routes/adminSimpleBilling.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { adminUser: { id: string } }).adminUser = { id: 'admin-1' };
  next();
});
app.use('/api/admin/simple-billing', adminSimpleBillingRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/api/admin/simple-billing${path}`, method, headers: { 'content-type': 'application/json', connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(data || '{}') }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const USD_PACK = { id: 'm', price_minor: 2000, credit_minor: 2200, active: true };

beforeEach(() => {
  h.edition = 'international';
  h.mode = 'METER_ONLY';
  h.stored = {};
  h.upserts.length = 0;
});

describe('GET /ai-packs', () => {
  it('International: USD and TRY, their rates (null when none), the mode and VAT', async () => {
    h.stored = { USD: [USD_PACK, { ...USD_PACK, id: 'off', active: false }] };
    const res = await call('GET', '/ai-packs');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      edition: 'international',
      currencies: ['USD', 'TRY'],
      // Inactive packs are shown to the admin too.
      packs: { USD: [USD_PACK, { ...USD_PACK, id: 'off', active: false }], TRY: [] },
      rates: { USD: 600_000, TRY: null },
      mode: 'METER_ONLY',
      vat_percent: { USD: 10, TRY: null },
    });
  });

  it('Iran: IRR only, with nothing saved yet', async () => {
    h.edition = 'iran';
    h.mode = 'ENFORCED';
    const res = await call('GET', '/ai-packs');
    expect(res.json).toEqual({
      edition: 'iran', currencies: ['IRR'], packs: { IRR: [] }, rates: { IRR: 1 }, mode: 'ENFORCED', vat_percent: { IRR: 10 },
    });
  });
});

describe('PUT /ai-packs', () => {
  it('writes only the packs of this edition (normalised), and answers like GET', async () => {
    const res = await call('PUT', '/ai-packs', { packs: { USD: [{ id: 'm', price_minor: 2000, credit_minor: 2200, label: { en: ' Medium ' } }] } });
    expect(res.status).toBe(200);
    expect(h.upserts).toHaveLength(1);
    const { row, options } = h.upserts[0];
    expect(Object.keys(row).sort()).toEqual(['ai_packs', 'edition', 'updated_at', 'updated_by']);
    expect(row).toMatchObject({
      edition: 'international',
      updated_by: 'admin-1',
      ai_packs: { USD: [{ id: 'm', price_minor: 2000, credit_minor: 2200, active: true, label: { en: 'Medium' } }], TRY: [] },
    });
    expect(options).toEqual({ onConflict: 'edition' });
    expect(res.json).toMatchObject({ edition: 'international', packs: row.ai_packs, rates: { USD: 600_000, TRY: null } });
  });

  it('Iran: IRR in whole Toman', async () => {
    h.edition = 'iran';
    expect((await call('PUT', '/ai-packs', { packs: { IRR: [{ id: 's', price_minor: 2_000_000, credit_minor: 2_000_000 }] } })).status).toBe(200);
    const bad = await call('PUT', '/ai-packs', { packs: { IRR: [{ id: 's', price_minor: 2_000_001, credit_minor: 2_000_000 }] } });
    expect(bad).toMatchObject({ status: 400, json: { error: 'AI_PACKS_INVALID', field: 'IRR.0.price_minor', reason: 'invalid' } });
    // A currency of the other edition.
    const usd = await call('PUT', '/ai-packs', { packs: { USD: [USD_PACK] } });
    expect(usd).toMatchObject({ status: 400, json: { error: 'AI_PACKS_INVALID', field: 'USD', reason: 'currency' } });
    expect(h.upserts).toHaveLength(1);
  });

  it('400 names the field (duplicate, too many); nothing is written', async () => {
    const dup = await call('PUT', '/ai-packs', { packs: { USD: [USD_PACK, USD_PACK] } });
    expect(dup).toMatchObject({ status: 400, json: { error: 'AI_PACKS_INVALID', field: 'USD.1.id', reason: 'duplicate' } });
    const many = await call('PUT', '/ai-packs', { packs: { TRY: Array.from({ length: 9 }, (_, i) => ({ ...USD_PACK, id: `p${i}` })) } });
    expect(many).toMatchObject({ status: 400, json: { field: 'TRY', reason: 'too_many' } });
    expect((await call('PUT', '/ai-packs', { nope: 1 })).json).toEqual({ error: 'INVALID_REQUEST' });
    expect(h.upserts).toEqual([]);
  });
});

describe('PUT /settings keeps the packs', () => {
  it('never sends ai_packs, so the stored packs stay', async () => {
    const res = await call('PUT', '/settings', { seller: { legal_name: 'Acme' }, vat_percent: { USD: 10 }, receipt_prefix: 'R' });
    expect(res.status).toBe(200);
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0].row).not.toHaveProperty('ai_packs');
  });
});
