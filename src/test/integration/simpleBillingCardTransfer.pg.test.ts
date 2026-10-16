// @vitest-environment node
/**
 * 274 — card-to-card wallet top-up, against real PostgreSQL built by the
 * whole migration chain.
 *
 *   T1  approval books what a gateway payment books: a `manual` payment,
 *       verified and settled, a numbered `topup` receipt with the VAT, the
 *       balance; the request records the payment and the ledger row;
 *   T2  approving again replays (one payment, one receipt, one credit);
 *   T3  a rejected or canceled request cannot be approved; a missing one
 *       answers not found;
 *   T4  only the Iranian edition approves;
 *   T5  the admin may credit another amount (VAT recomputed by the backend);
 *   T6  a bank tracking number backs one live request; a rejected one frees it;
 *   T7  the table's checks (amount = net + tax, digits only, statuses);
 *   T8  only service_role reaches the table and the function; 274 runs twice;
 *       billing_settings.card_transfer exists with an empty default.
 *
 * Its own database (CREATE DATABASE on the TEST_DATABASE_URL server).
 * Skipped without TEST_DATABASE_URL; REQUIRE_BILLING_DB=1 makes that a failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_BILLING_DB === '1' && !DSN) {
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the card-to-card SQL tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `simplebilling274_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '274_billing_card_transfer.sql';

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

async function makeWorkspace(): Promise<{ ws: string; owner: string }> {
  const owner = randomUUID();
  await q(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
  const ws = randomUUID();
  await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
  return { ws, owner };
}

let refSeq = 6_000_000;
async function request(ws: string, owner: string, o: { net?: number; tax?: number; reference?: string | null; status?: string } = {}): Promise<string> {
  const net = o.net ?? 5_000_000;
  const tax = o.tax ?? Math.round(net / 10);
  const row = await one(
    `INSERT INTO public.billing_card_transfers
       (workspace_id, created_by, net_minor, tax_minor, tax_percent, amount_minor, reference, receipt_key, receipt_mime, receipt_size, status)
     VALUES ($1, $2, $3, $4, 10, $5, $6, 'platform/billing/card-transfers/x/y-receipt.jpg', 'image/jpeg', 1234, $7)
     RETURNING id`,
    [ws, owner, net, tax, net + tax, o.reference === undefined ? String(++refSeq) : o.reference, o.status ?? 'pending'],
  );
  return String(row.id);
}

const approve = async (id: string, net = 5_000_000, tax = 500_000, adminId: string | null = null) =>
  (await one(`SELECT public.billing_card_transfer_approve($1, $2, $3, $4, 10) AS r`, [id, adminId, net, tax])).r as Row;

const errorOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

suite('274 card-to-card top-up', () => {
  beforeAll(async () => {
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    const url = new URL(DSN!);
    url.pathname = `/${DB}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    await db.query('SET client_min_messages = warning');
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files.filter((f) => f <= FILE)) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
    await q(`UPDATE public.platform_settings SET region_mode = 'iran'`);
    await q(`INSERT INTO public.billing_settings (edition, receipt_prefix, vat_percent) VALUES ('iran', 'W', '{"IRR": 10}')
             ON CONFLICT (edition) DO UPDATE SET receipt_prefix = 'W'`);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  it('T1 approval books a manual payment, a numbered receipt and the balance', async () => {
    const { ws, owner } = await makeWorkspace();
    const adminId = randomUUID();
    const id = await request(ws, owner);
    const r = await approve(id, 5_000_000, 500_000, adminId);
    expect(r.replayed).toBe(false);
    expect(r.request_id).toBe(id);
    expect(String(r.receipt_number)).toMatch(/^W\d{4}-\d{6}$/);

    const pay = await one(`SELECT * FROM public.billing_account_payments WHERE id = $1`, [r.payment_id]);
    expect(pay).toMatchObject({ provider: 'manual', status: 'succeeded', purpose: 'topup', currency: 'IRR', created_by: owner });
    expect(Number(pay.amount_minor)).toBe(5_500_000);
    expect(pay.provider_payment_id).toBe(`card_transfer:${id}`);
    expect((pay.purpose_detail as Row).card_transfer_id).toBe(id);

    const entry = await one(`SELECT * FROM public.billing_account_ledger WHERE id = $1`, [r.ledger_id]);
    expect(entry).toMatchObject({ kind: 'topup', receipt_number: r.receipt_number });
    expect(Number(entry.amount_minor)).toBe(5_000_000);
    expect(Number(entry.tax_minor)).toBe(500_000);
    expect((entry.description as Row).provider).toBe('manual');

    const account = await one(`SELECT currency, balance_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws]);
    expect(account.currency).toBe('IRR');
    expect(Number(account.balance_minor)).toBe(5_000_000);

    const req = await one(`SELECT * FROM public.billing_card_transfers WHERE id = $1`, [id]);
    expect(req).toMatchObject({ status: 'approved', payment_id: r.payment_id, ledger_id: r.ledger_id, reviewed_by: adminId });
    expect(req.reviewed_at).not.toBeNull();
  });

  it('T2 approving again replays: one payment, one receipt, one credit', async () => {
    const { ws, owner } = await makeWorkspace();
    const id = await request(ws, owner);
    const first = await approve(id);
    const again = await approve(id);
    expect(again).toMatchObject({ replayed: true, request_id: id, payment_id: first.payment_id, ledger_id: first.ledger_id });
    expect((await q(`SELECT 1 FROM public.billing_account_payments WHERE workspace_id = $1`, [ws])).length).toBe(1);
    expect((await q(`SELECT 1 FROM public.billing_account_ledger WHERE workspace_id = $1`, [ws])).length).toBe(1);
    expect(Number((await one(`SELECT balance_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).balance_minor)).toBe(5_000_000);
  });

  it('T3 rejected, canceled and missing requests are not approved', async () => {
    const { ws, owner } = await makeWorkspace();
    const rejected = await request(ws, owner, { status: 'rejected' });
    const canceled = await request(ws, owner, { status: 'canceled' });
    expect(await errorOf(approve(rejected))).toContain('card_transfer_not_pending');
    expect(await errorOf(approve(canceled))).toContain('card_transfer_not_pending');
    expect(await errorOf(approve(randomUUID()))).toContain('card_transfer_not_found');
    expect((await q(`SELECT 1 FROM public.billing_account_payments WHERE workspace_id = $1`, [ws])).length).toBe(0);
  });

  it('T4 only the Iranian edition approves', async () => {
    const { ws, owner } = await makeWorkspace();
    const id = await request(ws, owner);
    await q(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    try {
      expect(await errorOf(approve(id))).toContain('card_transfer_not_available');
      expect((await one(`SELECT status FROM public.billing_card_transfers WHERE id = $1`, [id])).status).toBe('pending');
    } finally {
      await q(`UPDATE public.platform_settings SET region_mode = 'iran'`);
    }
    await expect(approve(id)).resolves.toMatchObject({ replayed: false });
  });

  it('T5 another amount: the request and the receipt carry what was credited', async () => {
    const { ws, owner } = await makeWorkspace();
    const id = await request(ws, owner, { net: 5_000_000, tax: 500_000 });
    const r = await approve(id, 4_000_000, 400_000);
    expect(Number((await one(`SELECT balance_minor FROM public.billing_accounts WHERE workspace_id = $1`, [ws])).balance_minor)).toBe(4_000_000);
    const req = await one(`SELECT net_minor, tax_minor, amount_minor FROM public.billing_card_transfers WHERE id = $1`, [id]);
    expect([Number(req.net_minor), Number(req.tax_minor), Number(req.amount_minor)]).toEqual([4_000_000, 400_000, 4_400_000]);
    expect(Number((await one(`SELECT amount_minor FROM public.billing_account_ledger WHERE id = $1`, [r.ledger_id])).amount_minor)).toBe(4_000_000);
    expect(await errorOf(approve(await request(ws, owner), 0, 0))).toContain('card_transfer_amount_invalid');
  });

  it('T6 a tracking number backs one live request; a rejected one frees it', async () => {
    const { ws, owner } = await makeWorkspace();
    await request(ws, owner, { reference: '123456789' });
    expect(await errorOf(request(ws, owner, { reference: '123456789' }))).toContain('uq_billing_card_transfers_reference');
    const other = await makeWorkspace();
    expect(await errorOf(request(other.ws, other.owner, { reference: '123456789' }))).toContain('uq_billing_card_transfers_reference');
    await q(`UPDATE public.billing_card_transfers SET status = 'rejected' WHERE reference = '123456789'`);
    await expect(request(other.ws, other.owner, { reference: '123456789' })).resolves.toMatch(/^[0-9a-f-]{36}$/);
    // Requests without a tracking number never collide.
    await request(ws, owner, { reference: null });
    await expect(request(ws, owner, { reference: null })).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('T7 the table checks amounts, digits and statuses', async () => {
    const { ws, owner } = await makeWorkspace();
    const insert = (net: number, tax: number, amount: number, reference: string | null, status = 'pending', last4: string | null = null) =>
      q(`INSERT INTO public.billing_card_transfers
           (workspace_id, created_by, net_minor, tax_minor, amount_minor, reference, payer_card_last4, receipt_key, receipt_mime, receipt_size, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'k', 'image/png', 1, $8)`, [ws, owner, net, tax, amount, reference, last4, status]);
    expect(await errorOf(insert(100, 10, 111, null))).toContain('billing_card_transfers_amount_check');
    expect(await errorOf(insert(0, 0, 0, null))).toContain('billing_card_transfers_amount_check');
    expect(await errorOf(insert(100, 10, 110, '12ab'))).toContain('billing_card_transfers_reference_check');
    expect(await errorOf(insert(100, 10, 110, null, 'paid'))).toContain('billing_card_transfers_status_check');
    expect(await errorOf(insert(100, 10, 110, null, 'pending', '12'))).toContain('billing_card_transfers_last4_check');
  });

  it('T8 service_role only; 274 runs twice; billing_settings.card_transfer exists', async () => {
    for (const role of ['anon', 'authenticated']) {
      const exists = await one(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS e`, [role]);
      if (!exists.e) continue;
      const priv = await one(
        `SELECT has_table_privilege($1, 'public.billing_card_transfers', 'SELECT') AS t,
                has_function_privilege($1, 'public.billing_card_transfer_approve(uuid, uuid, bigint, bigint, numeric)', 'EXECUTE') AS f`,
        [role],
      );
      expect(priv).toEqual({ t: false, f: false });
    }
    const definer = await one(
      `SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'billing_card_transfer_approve' AND pronamespace = 'public'::regnamespace`,
    );
    expect(definer.prosecdef).toBe(true);
    expect(String(definer.proconfig)).toContain('search_path=public, pg_temp');
    await applyMigrationSql(db, readFileSync(resolve(DIR, FILE), 'utf8'));
    const col = await one(
      `SELECT column_default FROM information_schema.columns WHERE table_name = 'billing_settings' AND column_name = 'card_transfer'`,
    );
    expect(String(col.column_default)).toContain("'{}'::jsonb");
  });
});
