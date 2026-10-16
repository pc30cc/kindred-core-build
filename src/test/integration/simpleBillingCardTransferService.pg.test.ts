// @vitest-environment node
/**
 * Card-to-card top-up service (server/services/billing/account/cardTransfer.ts)
 * against the real migration chain in postgres-only mode. Storage and email
 * are captured in memory.
 *
 *   C1 settings: bad card number / IBAN refused; saved; offered only in the
 *      Iranian edition, only when enabled and complete;
 *   C2 a request: VAT computed by the server; the receipt stored under the
 *      platform key; the declared type must match the file's bytes; size,
 *      amount, tracking number and date checked;
 *   C3 a tracking number backs one live request; three awaiting review at most;
 *   C4 approval credits the wallet with a numbered receipt, mails it, audits
 *      it, and replays; another amount recomputes VAT;
 *   C5 rejection with a reason; withdrawal by the workspace; neither twice;
 *   C6 the receipt file: its workspace and a Super Admin read it, another
 *      workspace does not.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_BILLING_DB === '1' && !DSN) {
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the card-to-card service suite is mandatory.');
}
const suite = DSN ? describe : describe.skip;

const captured = vi.hoisted(() => ({
  emails: [] as Array<{ to: string; templateSlug?: string; data: Record<string, string> }>,
  files: new Map<string, { data: Buffer; contentType: string; owner: string }>(),
}));
vi.mock('../../../server/services/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const send = async (_c: unknown, req: { to: string; templateSlug?: string; templateData?: Record<string, string> }) => {
    captured.emails.push({ to: req.to, templateSlug: req.templateSlug, data: req.templateData ?? {} });
    return { success: true, provider: 'capture', id: `m-${captured.emails.length}` };
  };
  return { ...actual, sendEmail: send, sendPlatformEmail: send };
});
vi.mock('../../../server/services/storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    uploadForOwner: async (_c: unknown, req: { owner: { kind: string }; fileKey: string; data: Buffer; contentType: string }) => {
      captured.files.set(req.fileKey, { data: Buffer.from(req.data), contentType: req.contentType, owner: req.owner.kind });
      return { success: true, path: req.fileKey };
    },
    downloadForOwner: async (_c: unknown, _owner: unknown, key: string) => {
      const file = captured.files.get(key);
      return file ? { success: true, data: file.data } : { success: false, error: 'missing' };
    },
    deleteForOwner: async (_c: unknown, _owner: unknown, key: string) => {
      captured.files.delete(key);
      return { success: true };
    },
  };
});

type Row = Record<string, unknown>;
let chain: FullChainDatabase;
let config: never;
let svc: typeof import('../../../server/services/billing/account/cardTransfer');
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 2)]);
const png = () => ({ fileName: 'fish.png', mimeType: 'image/png', dataBase64: PNG.toString('base64') });

// A valid Iranian card number (Luhn) and IBAN (mod 97).
const CARD = '6037997599102317';
const IBAN = 'IR820540102680020817909002';

async function workspace(): Promise<{ ws: string; owner: string }> {
  const owner = randomUUID();
  await q(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `owner-${owner.slice(0, 6)}@test.local`]);
  const ws = randomUUID();
  await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Shop', $2, $3)`, [ws, `shop-${ws.slice(0, 6)}`, owner]);
  return { ws, owner };
}

let refSeq = 70_000;
const create = (ws: string, owner: string, over: Partial<Parameters<typeof svc.createCardTransfer>[1]> = {}) =>
  svc.createCardTransfer(config, {
    workspaceId: ws,
    userId: owner,
    netMinor: 5_000_000,
    reference: String(++refSeq),
    paidAt: new Date(Date.now() - 3_600_000).toISOString(),
    payerCardLast4: '1234',
    note: null,
    receipt: png(),
    ...over,
  });

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'none';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

suite('card-to-card service against the real chain', () => {
  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `simplebilling_cardtransfer_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      APP_BASE_URL: 'http://127.0.0.1:5173',
      COMPLIANCE_AUDIT_LOGGING: 'true',
    });
    delete process.env.DATABASE_MODE;
    await q(`UPDATE public.platform_settings SET region_mode = 'iran'`);
    await q(`INSERT INTO public.billing_settings (edition, seller, vat_percent, receipt_prefix) VALUES ('iran', '{"legal_name":"WebYar"}', '{"IRR": 10}', 'W')
             ON CONFLICT (edition) DO UPDATE SET vat_percent = EXCLUDED.vat_percent, receipt_prefix = 'W'`);
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig() as never;
    svc = await import('../../../server/services/billing/account/cardTransfer');
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  it('C1 settings are checked, saved, and offered only when on in the Iranian edition', async () => {
    const { ws } = await workspace();
    const admin = randomUUID();
    expect(await codeOf(svc.saveCardTransferSettings(config, { enabled: true, holder_name: 'Ali', card_number: '6037997599102312', iban: IBAN }, admin)))
      .toBe('CARD_TRANSFER_CARD_INVALID');
    expect(await codeOf(svc.saveCardTransferSettings(config, { enabled: true, holder_name: 'Ali', card_number: CARD, iban: 'IR000540102680020817909002' }, admin)))
      .toBe('CARD_TRANSFER_IBAN_INVALID');
    expect(await codeOf(svc.saveCardTransferSettings(config, { enabled: true, holder_name: '', card_number: CARD, iban: IBAN }, admin)))
      .toBe('CARD_TRANSFER_HOLDER_INVALID');

    // Off: kept, but not offered.
    await svc.saveCardTransferSettings(config, { enabled: false, holder_name: 'علی رضایی', card_number: '۶۰۳۷ ۹۹۷۵ ۹۹۱۰ ۲۳۱۷', iban: 'ir82 0540 1026 8002 0817 9090 02', bank: 'بلوبانک' }, admin);
    expect(await svc.getCardTransferSettings(config)).toEqual({
      enabled: false, holder_name: 'علی رضایی', card_number: CARD, iban: IBAN, bank: 'بلوبانک',
    });
    expect(await svc.cardTransferForAccount(config, ws)).toBeNull();

    await svc.saveCardTransferSettings(config, { enabled: true, holder_name: 'علی رضایی', card_number: CARD, iban: IBAN, bank: 'بلوبانک' }, admin);
    expect(await svc.cardTransferForAccount(config, ws)).toMatchObject({ card_number: CARD, iban: IBAN });

    await q(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    const { invalidatePlatformRegionCache } = await import('../../../server/services/platformRegion.js') as { invalidatePlatformRegionCache?: () => void };
    invalidatePlatformRegionCache?.();
    try {
      expect(await svc.cardTransferForAccount(config, ws)).toBeNull();
    } finally {
      await q(`UPDATE public.platform_settings SET region_mode = 'iran'`);
      invalidatePlatformRegionCache?.();
    }
  });

  it('C2 a request: VAT by the server, receipt under the platform key, every input checked', async () => {
    const { ws, owner } = await workspace();
    const item = await create(ws, owner, { reference: '۱۲۳۴۵۶۷۸', payerCardLast4: '۹۸۷۶' });
    expect(item).toMatchObject({ status: 'pending', net_minor: 5_000_000, tax_minor: 500_000, amount_minor: 5_500_000, reference: '12345678', payer_card_last4: '9876' });
    const row = await one(`SELECT receipt_key, receipt_mime, receipt_size FROM public.billing_card_transfers WHERE id = $1`, [item.id]);
    expect(String(row.receipt_key)).toBe(`platform/billing/card-transfers/${ws}/${item.id}-receipt.png`);
    expect(captured.files.get(String(row.receipt_key))).toMatchObject({ owner: 'platform', contentType: 'image/png' });
    expect(Number(row.receipt_size)).toBe(PNG.length);

    // A PDF named as an image, or a too-large file, is refused.
    expect(await codeOf(create(ws, owner, { receipt: { fileName: 'x.png', mimeType: 'image/png', dataBase64: PDF.toString('base64') } }))).toBe('CARD_TRANSFER_RECEIPT_TYPE');
    expect(await codeOf(create(ws, owner, { receipt: { fileName: 'x.gif', mimeType: 'image/gif', dataBase64: PNG.toString('base64') } }))).toBe('CARD_TRANSFER_RECEIPT_TYPE');
    expect(await codeOf(create(ws, owner, { receipt: { fileName: 'x.pdf', mimeType: 'application/pdf', dataBase64: Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]).toString('base64') } })))
      .toBe('CARD_TRANSFER_RECEIPT_TOO_LARGE');
    expect(await codeOf(create(ws, owner, { netMinor: 1000 }))).toBe('TOPUP_AMOUNT_TOO_SMALL');
    expect(await codeOf(create(ws, owner, { reference: '12' }))).toBe('CARD_TRANSFER_REFERENCE_INVALID');
    expect(await codeOf(create(ws, owner, { payerCardLast4: '12' }))).toBe('CARD_TRANSFER_LAST4_INVALID');
    expect(await codeOf(create(ws, owner, { paidAt: new Date(Date.now() + 86_400_000).toISOString() }))).toBe('CARD_TRANSFER_DATE_INVALID');
    expect(await codeOf(create(ws, owner, { paidAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }))).toBe('CARD_TRANSFER_DATE_INVALID');
    // A PDF receipt is fine.
    await expect(create(ws, owner, { receipt: { fileName: 'fish.pdf', mimeType: 'application/pdf', dataBase64: `data:application/pdf;base64,${PDF.toString('base64')}` } }))
      .resolves.toMatchObject({ receipt_mime: 'application/pdf' });
  });

  it('C3 one live request per tracking number; three awaiting review at most', async () => {
    const a = await workspace();
    const b = await workspace();
    await create(a.ws, a.owner, { reference: '5550001' });
    expect(await codeOf(create(b.ws, b.owner, { reference: '5550001' }))).toBe('CARD_TRANSFER_REFERENCE_USED');
    await create(a.ws, a.owner);
    await create(a.ws, a.owner);
    expect(await codeOf(create(a.ws, a.owner))).toBe('CARD_TRANSFER_TOO_MANY_PENDING');
  });

  it('C4 approval credits the wallet with a numbered receipt, mails and audits it, replays', async () => {
    const { ws, owner } = await workspace();
    // The audit row names the admin (audit_logs.user_id references profiles).
    const admin = randomUUID();
    await q(`INSERT INTO public.profiles (id, email) VALUES ($1, 'admin@test.local')`, [admin]);
    const item = await create(ws, owner);
    captured.emails.length = 0;
    const r = await svc.approveCardTransfer(config, { requestId: item.id, adminId: admin });
    expect(r.replayed).toBe(false);
    expect(r.receipt_number).toMatch(/^W\d{4}-\d{6}$/);
    expect(r.balance_minor).toBe(5_000_000);
    const entry = await one(`SELECT kind, amount_minor, tax_minor, description FROM public.billing_account_ledger WHERE id = $1`, [r.ledger_id]);
    expect(entry).toMatchObject({ kind: 'topup' });
    expect(Number(entry.tax_minor)).toBe(500_000);
    await vi.waitFor(() => expect(captured.emails.map((m) => m.templateSlug)).toContain('billing_payment_receipt'), { timeout: 8000 });
    const audit = await one(`SELECT action, user_id, workspace_id FROM public.audit_logs WHERE entity_id = $1`, [item.id]);
    expect(audit).toMatchObject({ action: 'billing.card_transfer_approved', user_id: admin, workspace_id: ws });

    await expect(svc.approveCardTransfer(config, { requestId: item.id, adminId: admin })).resolves.toMatchObject({ replayed: true, ledger_id: r.ledger_id });
    expect(Number((await one(`SELECT balance_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).balance_minor)).toBe(5_000_000);

    // The admin credits less than asked: VAT is recomputed on what is credited.
    const other = await create(ws, owner);
    const r2 = await svc.approveCardTransfer(config, { requestId: other.id, adminId: admin, netMinor: 3_000_000 });
    const row = await one(`SELECT net_minor, tax_minor FROM public.billing_card_transfers WHERE id = $1`, [other.id]);
    expect([Number(row.net_minor), Number(row.tax_minor)]).toEqual([3_000_000, 300_000]);
    expect(r2.balance_minor).toBe(8_000_000);
    expect(await codeOf(svc.approveCardTransfer(config, { requestId: randomUUID(), adminId: admin }))).toBe('CARD_TRANSFER_NOT_FOUND');
  });

  it('C5 rejection with a reason, withdrawal by the workspace, neither twice', async () => {
    const { ws, owner } = await workspace();
    const admin = randomUUID();
    const a = await create(ws, owner);
    expect(await codeOf(svc.rejectCardTransfer(config, { requestId: a.id, adminId: admin, reason: 'x' }))).toBe('CARD_TRANSFER_REASON_INVALID');
    await expect(svc.rejectCardTransfer(config, { requestId: a.id, adminId: admin, reason: 'Amount not received' }))
      .resolves.toMatchObject({ status: 'rejected', review_note: 'Amount not received' });
    expect(await codeOf(svc.rejectCardTransfer(config, { requestId: a.id, adminId: admin, reason: 'again' }))).toBe('CARD_TRANSFER_NOT_PENDING');
    expect(await codeOf(svc.approveCardTransfer(config, { requestId: a.id, adminId: admin }))).toBe('CARD_TRANSFER_NOT_PENDING');

    const b = await create(ws, owner);
    const other = await workspace();
    expect(await codeOf(svc.cancelCardTransfer(config, other.ws, b.id))).toBe('CARD_TRANSFER_NOT_PENDING');
    await expect(svc.cancelCardTransfer(config, ws, b.id)).resolves.toMatchObject({ status: 'canceled' });
    expect(await codeOf(svc.cancelCardTransfer(config, ws, b.id))).toBe('CARD_TRANSFER_NOT_PENDING');

    const list = await svc.listCardTransfers(config, ws);
    expect(list.map((i) => i.status).sort()).toEqual(['canceled', 'rejected']);
    const adminList = await svc.listAdminCardTransfers(config, { status: 'rejected' });
    expect(adminList.items.find((i) => i.id === a.id)).toMatchObject({ workspace_name: 'Shop', requester_email: expect.stringContaining('@test.local') });
  });

  it('C6 the receipt file: its workspace and a Super Admin, never another workspace', async () => {
    const { ws, owner } = await workspace();
    const item = await create(ws, owner);
    await expect(svc.readCardTransferReceipt(config, item.id, ws)).resolves.toMatchObject({ mime: 'image/png' });
    expect((await svc.readCardTransferReceipt(config, item.id)).data.equals(PNG)).toBe(true);
    const other = await workspace();
    expect(await codeOf(svc.readCardTransferReceipt(config, item.id, other.ws))).toBe('CARD_TRANSFER_NOT_FOUND');
  });
});
