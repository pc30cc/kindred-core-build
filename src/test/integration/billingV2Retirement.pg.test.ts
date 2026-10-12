// @vitest-environment node
/**
 * 267 — billing v2 is retired: every workspace moves into simple billing
 * (docs/billing/SIMPLE_BILLING.md, phase 7, PR 7A), against real PostgreSQL
 * built by the whole migration chain up to 266.
 *
 *   R1  dry run equals apply: billing_v2_migrate_to_simple(false) lists
 *       exactly what (true) performs, and what the migration's own move did;
 *   R2  wallet: a balance that matches its ledger is one admin_credit
 *       (category migration, key admin:v2:billing_wallet_accounts:<id>); a
 *       balance that does not is needs_review, nothing written;
 *   R3  scheduled periods: a contiguous future period is prepaid (credit and
 *       renewal of equal size, next_period_prepaid_minor); at the due moment
 *       process_due renews from it and returns no money; a due period is
 *       activated with its AI month granted once; a replaced one is credited;
 *       an admin-granted one with no money is needs_review;
 *   R4  payments and intents: an unapplied payment is credited at its
 *       invoice's net share (or amount - refunds); a processing intent and a
 *       paid invoice never applied are needs_review, nothing written;
 *   R5  subscriptions: past_due past its end and free_fallback become expired,
 *       canceled at period end becomes active with auto-renew off, a pending
 *       downgrade becomes the account's scheduled change, past_due running
 *       becomes active, unpaid is needs_review; plan_change_log rows, the v2
 *       columns cleared;
 *   R6  edition international: every money item is needs_review, no ledger
 *       row is written; subscriptions are still normalised;
 *   R7  idempotency: 267 runs twice, the move runs twice; waive clears one
 *       item, waive(NULL, NULL, reason) clears them all;
 *   R8  only the migration owner reaches the three functions and the log;
 *   R9  the rest of 267: new workspaces get no v2 rows, the App Review seed
 *       grants through simple billing, a calendar AI lot is not refused,
 *       billing_account_v2_next_period is NULL, process_due names no v2 table;
 *   R10 the code from before 7A still works: the old admin grant activates a
 *       v2 period, which the move then ignores; renew's callers still run;
 *   R11 preconditions: 267 raises without 266 (and without 265).
 *
 * Its own databases (CREATE DATABASE on the TEST_DATABASE_URL server).
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
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the billing v2 retirement SQL tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const STAMP = Date.now();
const BASE = `v2retire_base_${STAMP}`;
const IRAN = `v2retire_iran_${STAMP}`;
const INTL = `v2retire_intl_${STAMP}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '267_billing_v2_retire.sql';
const SQL_267 = readFileSync(resolve(DIR, FILE), 'utf8');
/** 267 without its own BEGIN/COMMIT, to run inside a test's transaction. */
const BODY_267 = SQL_267.replace(/^BEGIN;[ \t]*$/m, '').replace(/^COMMIT;[ \t]*$/m, '');
/** ...and without the move at its end (the functions only). */
const FUNCTIONS_267 = BODY_267.replace(/DO \$move\$[\s\S]*?\$move\$;/, '');

type Row = Record<string, unknown>;
type Item = { source_table: string; source_id: string; workspace_id: string; action?: string; amount_minor: number | null; currency: string | null; reason?: string };
type Report = {
  edition: string; apply: boolean; applied: number; already_done: number; waived: number;
  ignored: Record<string, number>; actions: Item[]; needs_review: Item[];
  totals: { credited_minor: number; prepaid_minor: number };
};

const CAP_IRR = 10_000_000_000;

let admin: pg.Client;

function urlFor(db: string): string {
  const url = new URL(DSN!);
  url.pathname = `/${db}`;
  return url.toString();
}

async function connect(db: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlFor(db) });
  await c.connect();
  await c.query('SET client_min_messages = notice');
  return c;
}

/** Query helpers bound to one database. */
function helpers(c: pg.Client) {
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await c.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
  const num = async (sql: string, params: unknown[] = []): Promise<number> => Number((await one(sql, params)).n);

  const planId = async (slug: string) => String((await one(`SELECT id FROM public.billing_plans WHERE slug = $1`, [slug])).id);

  async function workspace(): Promise<string> {
    const owner = randomUUID();
    await c.query(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
    const id = randomUUID();
    await c.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'V2 Co', $2, $3)`, [id, `v2-${id.slice(0, 8)}`, owner]);
    return id;
  }

  /** A v2 subscription row; times are seconds from now. */
  async function sub(ws: string, o: {
    plan: string; status?: string; startIn?: number; endIn?: number | null; interval?: string; engine?: string;
    cancelAtEnd?: boolean; pending?: string | null; nextPlan?: string | null; fallbackAt?: boolean; currentPeriod?: string | null;
  }): Promise<string> {
    const row = await one(
      `INSERT INTO public.workspace_subscriptions
         (workspace_id, plan_id, status, billing_interval, current_period_start, current_period_end, billing_engine_version,
          cancel_at_period_end, pending_change_type, next_plan_id, free_fallback_at, past_due_since, current_period_id)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5),
               CASE WHEN $6::float8 IS NULL THEN NULL ELSE now() + make_interval(secs => $6::float8) END,
               $7, $8, $9, $10, CASE WHEN $11 THEN now() END, CASE WHEN $3 = 'past_due' THEN now() END, $12)
       RETURNING id`,
      [ws, o.plan, o.status ?? 'active', o.interval ?? 'monthly', o.startIn ?? -20 * 86400,
        o.endIn === undefined ? 10 * 86400 : o.endIn, o.engine ?? 'v2', o.cancelAtEnd ?? false, o.pending ?? null,
        o.nextPlan ?? null, o.fallbackAt ?? false, o.currentPeriod ?? null],
    );
    return String(row.id);
  }

  let invoiceSeq = 0;
  async function invoice(ws: string, o: { status?: string; type?: string; subtotal: number; discount?: number; tax?: number }): Promise<string> {
    const discount = o.discount ?? 0;
    const tax = o.tax ?? 0;
    const total = o.subtotal - discount + tax;
    const paid = (o.status ?? 'paid') === 'paid';
    const row = await one(
      `INSERT INTO public.billing_invoices
         (workspace_id, invoice_number, invoice_type, status, currency, subtotal_irr, discount_irr, tax_irr, total_irr,
          amount_paid_irr, amount_due_irr, paid_at)
       VALUES ($1, $2, $3, $4, 'IRR', $5, $6, $7, $8, $9, $10, CASE WHEN $11 THEN now() END) RETURNING id`,
      [ws, `T${STAMP % 100000}${String(++invoiceSeq).padStart(6, '0')}`, o.type ?? 'subscription_renewal', o.status ?? 'paid',
        o.subtotal, discount, tax, total, paid ? total : 0, paid ? 0 : total, paid],
    );
    return String(row.id);
  }

  /** A v2 period; times are seconds from now. */
  async function period(ws: string, o: {
    plan: string; status?: string; startIn: number; endIn: number; invoice?: string | null; source?: string; interval?: string;
    aiAllowance?: number;
  }): Promise<string> {
    const row = await one(
      `INSERT INTO public.billing_subscription_periods
         (workspace_id, subscription_id, plan_id, invoice_id, billing_interval, period_start, period_end, status, source, ai_allowance_irr)
       VALUES ($1, (SELECT id FROM public.workspace_subscriptions WHERE workspace_id = $1), $2, $3, $4,
               now() + make_interval(secs => $5::float8), now() + make_interval(secs => $6::float8), $7, $8, $9)
       RETURNING id`,
      [ws, o.plan, o.invoice ?? null, o.interval ?? 'monthly', o.startIn, o.endIn, o.status ?? 'scheduled',
        o.source ?? (o.invoice ? 'invoice' : 'admin'), o.aiAllowance ?? 0],
    );
    return String(row.id);
  }

  /** A v2 scheduled period that starts exactly at the subscription's end. */
  async function periodAfterSub(ws: string, o: { plan: string; invoice?: string | null; days?: number }): Promise<string> {
    const row = await one(
      `INSERT INTO public.billing_subscription_periods
         (workspace_id, subscription_id, plan_id, invoice_id, billing_interval, period_start, period_end, status, source)
       SELECT s.workspace_id, s.id, $2, $3, 'monthly', s.current_period_end,
              s.current_period_end + make_interval(days => $4), 'scheduled', CASE WHEN $3::uuid IS NULL THEN 'admin' ELSE 'invoice' END
         FROM public.workspace_subscriptions s WHERE s.workspace_id = $1
       RETURNING id`,
      [ws, o.plan, o.invoice ?? null, o.days ?? 30],
    );
    return String(row.id);
  }

  async function walletDeposit(ws: string, amount: number): Promise<string> {
    await c.query(`SELECT public.billing_wallet_append($1, 'deposit', $2, $3)`, [ws, amount, `test:${randomUUID()}`]);
    return String((await one(`SELECT id FROM public.billing_wallet_accounts WHERE workspace_id = $1`, [ws])).id);
  }

  async function payment(ws: string, o: { amount: number; refund?: number; status?: string; recon?: string; invoice?: string | null; currency?: string; intent?: string | null }): Promise<string> {
    const row = await one(
      `INSERT INTO public.billing_payments
         (workspace_id, amount, refund_amount, currency, status, provider_name, invoice_id, reconciliation_state, paid_at, payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, 'zarinpal', $6, $7, now(), $8) RETURNING id`,
      [ws, o.amount, o.refund ?? 0, o.currency ?? 'IRR', o.status ?? 'succeeded', o.invoice ?? null, o.recon ?? 'unapplied', o.intent ?? null],
    );
    return String(row.id);
  }

  async function intent(ws: string, o: {
    status: string; amount?: number; ageHours?: number; plan?: string; invoice?: string | null; deposit?: string | null;
  }): Promise<string> {
    const row = await one(
      `INSERT INTO public.billing_payment_intents
         (workspace_id, purchase_type, plan_id, billing_interval, provider_name, amount_irr, status, created_at,
          billing_engine_version, invoice_id, wallet_deposit_id)
       VALUES ($1, CASE WHEN $5::uuid IS NULL THEN 'wallet_deposit' ELSE 'subscription' END, $5,
               CASE WHEN $5::uuid IS NULL THEN NULL ELSE 'monthly' END, 'zarinpal', $2, $3,
               now() - make_interval(hours => $4), 'v2', $6, $7) RETURNING id`,
      [ws, o.amount ?? 5_000_000, o.status, o.ageHours ?? 0, o.plan ?? null, o.invoice ?? null, o.deposit ?? null],
    );
    return String(row.id);
  }

  /** A v2 wallet deposit document (pending), for an intent to name. */
  async function depositDoc(ws: string, amount: number): Promise<string> {
    const row = await one(
      `INSERT INTO public.billing_wallet_deposits (workspace_id, document_number, amount_irr)
       VALUES ($1, $2, $3) RETURNING id`, [ws, `WD${randomUUID().slice(0, 8)}`, amount]);
    return String(row.id);
  }

  const move = async (apply: boolean): Promise<Report> =>
    (await one(`SELECT public.billing_v2_migrate_to_simple($1) AS r`, [apply])).r as Report;
  const account = (ws: string) => one(`SELECT * FROM public.billing_accounts WHERE workspace_id = $1`, [ws]);
  const ledger = (ws: string) =>
    q(`SELECT kind, amount_minor::bigint::float8 AS amount, balance_after::bigint::float8 AS balance_after, currency,
              idempotency_key, description, period_start, period_end, plan_id
         FROM public.billing_account_ledger WHERE workspace_id = $1 ORDER BY created_at, id`, [ws]);
  const subOf = (ws: string) => one(`SELECT * FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws]);
  const changes = (ws: string) =>
    q(`SELECT change_type, old_plan_id, new_plan_id, metadata FROM public.plan_change_log WHERE workspace_id = $1 ORDER BY created_at`, [ws]);
  const logOf = (table: string, id: string) =>
    one(`SELECT * FROM billing_v2_archive.migration_log WHERE source_table = $1 AND source_id = $2`, [table, id]);

  return { q, one, num, planId, workspace, sub, invoice, period, periodAfterSub, walletDeposit, payment, intent, depositDoc, move, account, ledger, subOf, changes, logOf };
}

/** Runs 267 as one query (as the chain does) and returns the move's NOTICE report. */
async function apply267(c: pg.Client): Promise<Report> {
  const notices: string[] = [];
  const onNotice = (m: { message?: string }) => { if (m.message) notices.push(m.message); };
  c.on('notice', onNotice);
  try {
    await applyMigrationSql(c, SQL_267);
  } finally {
    c.removeListener('notice', onNotice);
  }
  const line = notices.find((n) => n.startsWith('billing v2 move: '));
  if (!line) throw new Error(`267 printed no move report: ${JSON.stringify(notices)}`);
  return JSON.parse(line.slice('billing v2 move: '.length)) as Report;
}

/** A timestamp column as epoch milliseconds (pg returns a Date). */
const at = (v: unknown): number => (v instanceof Date ? v : new Date(String(v))).getTime();

const key = (i: Item) => `${i.source_table}:${i.source_id}:${i.action ?? ''}:${i.amount_minor ?? ''}`;
const keys = (items: Item[]) => items.map(key).sort();
const reviewKeys = (items: Item[]) => items.map((i) => `${i.source_table}:${i.source_id}:${i.reason}`).sort();
const reviewOf = (r: Report, id: string) => r.needs_review.find((i) => i.source_id === id);

suite('267 — billing v2 retired, every workspace moved into simple billing (real PostgreSQL)', () => {
  beforeAll(async () => {
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    for (const db of [BASE, IRAN, INTL]) await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    await admin.query(`CREATE DATABASE ${BASE}`);
    const base = await connect(BASE);
    await base.query('SET client_min_messages = warning');
    const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files.filter((f) => f < FILE)) {
      await applyMigrationSql(base, readFileSync(resolve(DIR, file), 'utf8'));
    }
    await base.end();
    // Both editions start from the same database at 266.
    await admin.query(`CREATE DATABASE ${IRAN} TEMPLATE ${BASE}`);
    await admin.query(`CREATE DATABASE ${INTL} TEMPLATE ${BASE}`);
  }, 900_000);

  afterAll(async () => {
    if (admin) {
      for (const db of [IRAN, INTL, BASE]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  // ───────────────────────────── Iran (WebYar) ─────────────────────────────
  describe('edition iran', () => {
    let c: pg.Client;
    let h: ReturnType<typeof helpers>;
    let pro = '';
    let enterprise = '';
    let free = '';
    const AI_MONTH = 2_000_000;

    // Fixtures, all written at 266.
    const f = {
      wOk: '', walletOk: '',
      wBad: '', walletBad: '',
      wPrepay: '', pPrepay: '', subPrepayEnd: '',
      wDue: '', pDue: '',
      wReplaced: '', pReplaced: '',
      wAdminNext: '', pAdminNext: '',
      wPay: '', payInvoice: '', payLoose: '', paySettled: '',
      wReview: '', intentProcessing: '', intentOld: '', invoiceUnapplied: '',
      wPastDueEnded: '', sPastDueEnded: '',
      wFallback: '', sFallback: '',
      wCancelAtEnd: '', sCancelAtEnd: '',
      wCanceledEnded: '', sCanceledEnded: '',
      wDowngrade: '', sDowngrade: '',
      wPendingCancel: '', sPendingCancel: '',
      wPastDueRunning: '', sPastDueRunning: '',
      wUnpaid: '', sUnpaid: '',
      wPlainV2: '', sPlainV2: '',
      // Review fixes.
      wIntentPaid: '', intentPaid: '', payOfIntent: '', intentFailedPay: '', failedPay: '',
      wIntentDeposit: '', intentDeposit: '', walletOfDeposit: '',
      wElapsed: '', pElapsed: '', sElapsed: '',
      wCanceledDue: '', pCanceledDue: '', sCanceledDue: '',
      wHeld: '', pHeld: '',
    };
    let dry: Report;
    let inTx: Report;
    let report: Report;

    beforeAll(async () => {
      c = await connect(IRAN);
      h = helpers(c);
      await c.query(`UPDATE public.platform_settings SET region_mode = 'iran'`);
      pro = await h.planId('pro');
      enterprise = await h.planId('enterprise');
      free = await h.planId('free');
      await c.query(`UPDATE public.billing_plans SET ai_allowance = jsonb_build_object('IRR', $1::bigint) WHERE id = $2`, [AI_MONTH, pro]);

      // R2 wallet: matches its ledger / does not.
      f.wOk = await h.workspace();
      await h.walletDeposit(f.wOk, 3_000_000);
      f.walletOk = await h.walletDeposit(f.wOk, 2_000_000);
      f.wBad = await h.workspace();
      f.walletBad = await h.walletDeposit(f.wBad, 4_000_000);
      await c.query(`UPDATE public.billing_wallet_accounts SET available_balance_irr = 4500000 WHERE id = $1`, [f.walletBad]);

      // R3 prepay: active pro period ends in 10 days; the next one is paid.
      f.wPrepay = await h.workspace();
      await h.sub(f.wPrepay, { plan: pro, endIn: 10 * 86400 });
      f.subPrepayEnd = String((await h.one(`SELECT current_period_end::text AS t FROM public.workspace_subscriptions WHERE workspace_id = $1`, [f.wPrepay])).t);
      f.pPrepay = await h.periodAfterSub(f.wPrepay, {
        plan: pro, invoice: await h.invoice(f.wPrepay, { subtotal: 15_000_000, discount: 1_000_000, tax: 1_400_000 }),
      });

      // R3 activate: the subscription ended 2 hours ago; its paid next period is due.
      f.wDue = await h.workspace();
      await h.sub(f.wDue, { plan: pro, startIn: -30 * 86400 - 7200, endIn: -7200 });
      f.pDue = await h.periodAfterSub(f.wDue, { plan: pro, invoice: await h.invoice(f.wDue, { subtotal: 15_000_000, tax: 1_500_000 }) });

      // R3 replaced: Super Admin put the workspace on Enterprise for a year
      // after its next Pro period was paid.
      f.wReplaced = await h.workspace();
      const subR = await h.sub(f.wReplaced, { plan: enterprise, startIn: -86400, endIn: 300 * 86400 });
      const q = await h.period(f.wReplaced, { plan: enterprise, status: 'active', startIn: -86400, endIn: 300 * 86400, source: 'admin' });
      await c.query(`UPDATE public.workspace_subscriptions SET current_period_id = $2 WHERE id = $1`, [subR, q]);
      f.pReplaced = await h.period(f.wReplaced, {
        plan: pro, startIn: 5 * 86400, endIn: 35 * 86400, invoice: await h.invoice(f.wReplaced, { subtotal: 15_000_000 }),
      });

      // R3 admin-granted next period, no money.
      f.wAdminNext = await h.workspace();
      await h.sub(f.wAdminNext, { plan: pro, endIn: 10 * 86400 });
      f.pAdminNext = await h.periodAfterSub(f.wAdminNext, { plan: pro, invoice: null });

      // R4 payments: one for an invoice that expired (10% VAT), one without
      // an invoice and partly refunded, one settled.
      f.wPay = await h.workspace();
      const expired = await h.invoice(f.wPay, { status: 'expired', subtotal: 10_000_000, tax: 1_000_000 });
      f.payInvoice = await h.payment(f.wPay, { amount: 11_000_000, invoice: expired });
      f.payLoose = await h.payment(f.wPay, { amount: 3_000_000, refund: 1_000_000, status: 'partially_refunded' });
      f.paySettled = await h.payment(f.wPay, { amount: 9_000_000, recon: 'settled' });

      // R4 review only: a processing intent, an old pending one, a paid
      // invoice never applied.
      f.wReview = await h.workspace();
      f.intentProcessing = await h.intent(f.wReview, { status: 'processing' });
      f.intentOld = await h.intent(f.wReview, { status: 'pending', ageHours: 72 });
      f.invoiceUnapplied = await h.invoice(f.wReview, { type: 'ai_credit_purchase', subtotal: 5_000_000, tax: 500_000 });

      // Review fix: an intent whose money v2 recorded is not reviewed again.
      // The callback parked its payment unapplied (the invoice had expired)
      // and left the intent `processing`; the payment is the money item.
      f.wIntentPaid = await h.workspace();
      const lapsed = await h.invoice(f.wIntentPaid, { status: 'expired', subtotal: 5_000_000 });
      f.intentPaid = await h.intent(f.wIntentPaid, { status: 'processing', plan: pro, invoice: lapsed });
      f.payOfIntent = await h.payment(f.wIntentPaid, { amount: 5_000_000, invoice: lapsed, intent: f.intentPaid });
      // A processing intent whose only payment failed: still for a person, with the link shown.
      f.intentFailedPay = await h.intent(f.wIntentPaid, { status: 'processing', amount: 700_000 });
      f.failedPay = await h.payment(f.wIntentPaid, { amount: 700_000, status: 'failed', recon: 'settled', intent: f.intentFailedPay });
      // A processing intent whose deposit reached the v2 wallet: the wallet is the money item.
      f.wIntentDeposit = await h.workspace();
      const doc = await h.depositDoc(f.wIntentDeposit, 3_000_000);
      f.intentDeposit = await h.intent(f.wIntentDeposit, { status: 'processing', amount: 3_000_000, deposit: doc });
      await c.query(`SELECT public.billing_wallet_apply_deposit($1, 3000000)`, [doc]);
      f.walletOfDeposit = String((await h.one(`SELECT id FROM public.billing_wallet_accounts WHERE workspace_id = $1`, [f.wIntentDeposit])).id);

      // Review fix: a paid next period that already ended, behind a canceled
      // subscription (v2 never started it): the money returns, nothing is activated.
      f.wElapsed = await h.workspace();
      f.sElapsed = await h.sub(f.wElapsed, { plan: pro, status: 'canceled', startIn: -70 * 86400, endIn: -40 * 86400 });
      f.pElapsed = await h.period(f.wElapsed, {
        plan: pro, startIn: -40 * 86400, endIn: -10 * 86400, invoice: await h.invoice(f.wElapsed, { subtotal: 1_000_000 }),
      });
      // ...and one still running, behind a subscription the customer canceled.
      f.wCanceledDue = await h.workspace();
      f.sCanceledDue = await h.sub(f.wCanceledDue, { plan: pro, status: 'canceled', startIn: -30 * 86400 - 7200, endIn: -7200 });
      f.pCanceledDue = await h.periodAfterSub(f.wCanceledDue, { plan: pro, invoice: await h.invoice(f.wCanceledDue, { subtotal: 2_000_000 }) });

      // Review fix: a paid next period the move leaves to a person (the
      // customer also scheduled a change in simple billing) keeps blocking a
      // second charge. The account has money and renews automatically.
      f.wHeld = await h.workspace();
      await h.sub(f.wHeld, { plan: enterprise, endIn: 10 * 86400 });
      f.pHeld = await h.periodAfterSub(f.wHeld, { plan: enterprise, invoice: await h.invoice(f.wHeld, { subtotal: 50_000_000 }) });
      await c.query(`SELECT public.billing_account_admin_adjust($1, 20000000, 'IRR', 'test money', NULL, $2, 'other')`, [f.wHeld, `held:${f.wHeld}`]);
      await c.query(`UPDATE public.billing_accounts SET auto_renew = true, scheduled_plan_id = $2, scheduled_interval = 'monthly' WHERE workspace_id = $1`, [f.wHeld, pro]);

      // R5 subscriptions.
      f.wPastDueEnded = await h.workspace();
      f.sPastDueEnded = await h.sub(f.wPastDueEnded, { plan: pro, status: 'past_due', endIn: -3 * 86400 });
      f.wFallback = await h.workspace();
      f.sFallback = await h.sub(f.wFallback, { plan: pro, status: 'free_fallback', endIn: -10 * 86400, fallbackAt: true });
      f.wCancelAtEnd = await h.workspace();
      f.sCancelAtEnd = await h.sub(f.wCancelAtEnd, { plan: pro, status: 'canceled', cancelAtEnd: true, endIn: 12 * 86400 });
      f.wCanceledEnded = await h.workspace();
      f.sCanceledEnded = await h.sub(f.wCanceledEnded, { plan: pro, status: 'canceled', endIn: 12 * 86400 });
      f.wDowngrade = await h.workspace();
      f.sDowngrade = await h.sub(f.wDowngrade, { plan: enterprise, interval: 'yearly', pending: 'downgrade', nextPlan: pro, endIn: 40 * 86400 });
      f.wPendingCancel = await h.workspace();
      f.sPendingCancel = await h.sub(f.wPendingCancel, { plan: pro, pending: 'cancel', endIn: 8 * 86400 });
      // Both already have an account that renews (so auto-renew off is seen).
      for (const ws of [f.wCancelAtEnd, f.wPendingCancel]) {
        await c.query(`INSERT INTO public.billing_accounts (workspace_id, currency, auto_renew) VALUES ($1, 'IRR', true)`, [ws]);
      }
      f.wPastDueRunning = await h.workspace();
      f.sPastDueRunning = await h.sub(f.wPastDueRunning, { plan: pro, status: 'past_due', endIn: 2 * 86400 });
      f.wUnpaid = await h.workspace();
      f.sUnpaid = await h.sub(f.wUnpaid, { plan: pro, status: 'unpaid', endIn: 2 * 86400 });
      f.wPlainV2 = await h.workspace();
      f.sPlainV2 = await h.sub(f.wPlainV2, { plan: pro, endIn: 20 * 86400 });

      // R1: the functions of 267 without its move, in a transaction that is
      // rolled back: the dry run, then the apply.
      await c.query('BEGIN');
      try {
        await applyMigrationSql(c, FUNCTIONS_267);
        dry = await h.move(false);
        inTx = await h.move(true);
      } finally {
        await c.query('ROLLBACK');
      }
      expect(await h.num(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'billing_v2_archive'`)).toBe(0);

      report = await apply267(c);
    }, 300_000);

    afterAll(async () => {
      await c?.end();
    });

    it('R1 the dry run lists exactly what the apply and the migration performed', () => {
      expect(dry.apply).toBe(false);
      expect(dry.applied).toBe(0);
      expect(dry.edition).toBe('iran');
      expect(keys(dry.actions)).toEqual(keys(inTx.actions));
      expect(keys(dry.actions)).toEqual(keys(report.actions));
      expect(reviewKeys(dry.needs_review)).toEqual(reviewKeys(report.needs_review));
      expect(dry.totals).toEqual(report.totals);
      expect(report.applied).toBe(report.actions.length);
      expect(report.already_done).toBe(0);

      const expected = [
        ['billing_wallet_accounts', f.walletOk, 'credit', 5_000_000],
        ['billing_subscription_periods', f.pPrepay, 'prepay', 14_000_000],
        ['billing_subscription_periods', f.pDue, 'activate', 15_000_000],
        ['billing_subscription_periods', f.pReplaced, 'credit_replaced', 15_000_000],
        ['billing_payments', f.payInvoice, 'credit', 10_000_000],
        ['billing_payments', f.payLoose, 'credit', 2_000_000],
        ['workspace_subscriptions', f.sPastDueEnded, 'normalize', ''],
        ['workspace_subscriptions', f.sFallback, 'normalize', ''],
        ['workspace_subscriptions', f.sCancelAtEnd, 'normalize', ''],
        ['workspace_subscriptions', f.sCanceledEnded, 'normalize', ''],
        ['workspace_subscriptions', f.sDowngrade, 'schedule_change', ''],
        ['workspace_subscriptions', f.sPendingCancel, 'auto_renew_off', ''],
        ['workspace_subscriptions', f.sPastDueRunning, 'normalize', ''],
        // Review fixes.
        ['billing_payments', f.payOfIntent, 'credit', 5_000_000],
        ['billing_wallet_accounts', f.walletOfDeposit, 'credit', 3_000_000],
        ['billing_subscription_periods', f.pElapsed, 'credit_replaced', 1_000_000],
        ['workspace_subscriptions', f.sElapsed, 'normalize', ''],
        ['billing_subscription_periods', f.pCanceledDue, 'credit_replaced', 2_000_000],
        ['workspace_subscriptions', f.sCanceledDue, 'normalize', ''],
      ].map((e) => e.join(':')).sort();
      expect(keys(report.actions)).toEqual(expected);
      expect(report.totals).toEqual({ credited_minor: 72_000_000, prepaid_minor: 29_000_000 });

      expect(reviewKeys(report.needs_review)).toEqual([
        `billing_invoices:${f.invoiceUnapplied}:invoice_paid_not_applied`,
        `billing_payment_intents:${f.intentProcessing}:intent_processing`,
        `billing_subscription_periods:${f.pAdminNext}:period_without_payment`,
        `billing_wallet_accounts:${f.walletBad}:wallet_ledger_mismatch`,
        `workspace_subscriptions:${f.sUnpaid}:subscription_status_unpaid`,
        `billing_payment_intents:${f.intentFailedPay}:intent_processing`,
        `billing_subscription_periods:${f.pHeld}:account_has_scheduled_change`,
      ].sort());
      expect(report.ignored).toEqual({
        payment_settled: 1, payment_failed: 1, intent_pending: 1, invoice_expired: 2, invoice_paid: 6,
        intent_paid_via_payment: 1, intent_paid_via_wallet_deposit: 1,
        // prepay, due, replaced, admin-next, held and the plain one: active v2 rows with nothing pending.
        subscription_unchanged: 6,
      });
    });

    it('R2 a wallet that matches its ledger is credited once, as a migration admin credit', async () => {
      expect(await h.ledger(f.wOk)).toEqual([expect.objectContaining({
        kind: 'admin_credit', amount: 5_000_000, balance_after: 5_000_000, currency: 'IRR',
        idempotency_key: `admin:v2:billing_wallet_accounts:${f.walletOk}`,
        description: { reason: 'Billing v2 wallet balance', category: 'migration' },
      })]);
      expect(Number((await h.account(f.wOk)).balance_minor)).toBe(5_000_000);
      const log = await h.logOf('billing_wallet_accounts', f.walletOk);
      expect(log).toMatchObject({ action: 'credit', workspace_id: f.wOk, currency: 'IRR' });
      expect(Number(log.amount_minor)).toBe(5_000_000);
      expect((log.ledger_ids as string[]).length).toBe(1);
      // The v2 wallet itself is untouched.
      expect(Number((await h.one(`SELECT available_balance_irr AS b FROM public.billing_wallet_accounts WHERE id = $1`, [f.walletOk])).b)).toBe(5_000_000);
    });

    it('R2 a wallet whose ledger does not match is needs_review, nothing written', async () => {
      expect(reviewOf(report, f.walletBad)).toMatchObject({ amount_minor: 4_500_000, currency: 'IRR', reason: 'wallet_ledger_mismatch' });
      expect(await h.account(f.wBad)).toBeUndefined();
      expect(await h.ledger(f.wBad)).toEqual([]);
      expect(await h.logOf('billing_wallet_accounts', f.walletBad)).toBeUndefined();
    });

    it('R3 a contiguous future period is prepaid: a credit and a renewal of equal size', async () => {
      const rows = await h.ledger(f.wPrepay);
      expect(rows.map((r) => [r.kind, r.amount, r.balance_after, r.idempotency_key])).toEqual([
        ['admin_credit', 14_000_000, 14_000_000, `admin:v2:billing_subscription_periods:${f.pPrepay}`],
        ['renewal', -14_000_000, 0, `v2:prepay:${f.pPrepay}`],
      ]);
      expect(rows[1].plan_id).toBe(pro);
      const acc = await h.account(f.wPrepay);
      expect(Number(acc.balance_minor)).toBe(0);
      expect(Number(acc.next_period_prepaid_minor)).toBe(14_000_000);
      // Exactly the subscription's end, to the microsecond (release_stale_prepaid compares them).
      expect((await h.one(`SELECT next_period_start = $2::timestamptz AS eq FROM public.billing_accounts WHERE workspace_id = $1`,
        [f.wPrepay, f.subPrepayEnd])).eq).toBe(true);
      expect(acc.scheduled_plan_id).toBeNull();
      expect(acc.scheduled_interval).toBeNull();
      // The v2 period stays as it was.
      expect((await h.one(`SELECT status FROM public.billing_subscription_periods WHERE id = $1`, [f.pPrepay])).status).toBe('scheduled');
    });

    it('R3 at the due moment process_due renews from the prepayment and returns no money', async () => {
      // The period's end passes: move the subscription and the prepayment's
      // start back together.
      await c.query(`
        UPDATE public.workspace_subscriptions
           SET current_period_start = current_period_start - interval '11 days',
               current_period_end = current_period_end - interval '11 days'
         WHERE workspace_id = $1`, [f.wPrepay]);
      await c.query(`
        UPDATE public.billing_accounts a SET next_period_start = s.current_period_end
          FROM public.workspace_subscriptions s WHERE s.workspace_id = a.workspace_id AND a.workspace_id = $1`, [f.wPrepay]);
      const res = (await h.one(`SELECT public.billing_account_process_due($1) AS r`, [f.wPrepay])).r as Row;
      expect(res).toMatchObject({ action: 'renewed', prepaid: true, plan_id: pro, amount_minor: 14_000_000 });
      expect(res.source).toBeUndefined();
      const rows = await h.ledger(f.wPrepay);
      expect(rows.map((r) => r.kind)).toEqual(['admin_credit', 'renewal']);
      const acc = await h.account(f.wPrepay);
      expect(Number(acc.balance_minor)).toBe(0);
      expect(acc.next_period_prepaid_minor).toBeNull();
      const sub = await h.subOf(f.wPrepay);
      expect(sub.status).toBe('active');
      expect(at(sub.current_period_end)).toBeGreaterThan(Date.now() + 20 * 86400_000);
      // v2 did not start its period.
      expect((await h.one(`SELECT status FROM public.billing_subscription_periods WHERE id = $1`, [f.pPrepay])).status).toBe('scheduled');
    });

    it('R3 a due period is activated, its AI month granted once', async () => {
      const rows = await h.ledger(f.wDue);
      expect(rows.map((r) => [r.kind, r.amount, r.balance_after])).toEqual([
        ['admin_credit', 15_000_000, 15_000_000],
        ['renewal', -15_000_000, 0],
      ]);
      const sub = await h.subOf(f.wDue);
      const p = await h.one(`SELECT period_start, period_end FROM public.billing_subscription_periods WHERE id = $1`, [f.pDue]);
      expect(sub).toMatchObject({ status: 'active', plan_id: pro, billing_interval: 'monthly', provider_name: 'account' });
      expect((await h.one(`
        SELECT s.current_period_start = p.period_start AND s.current_period_end = p.period_end AS eq
          FROM public.workspace_subscriptions s, public.billing_subscription_periods p
         WHERE s.workspace_id = $1 AND p.id = $2`, [f.wDue, f.pDue])).eq).toBe(true);
      expect((await h.changes(f.wDue)).map((x) => [x.change_type, (x.metadata as Row).period_id])).toEqual([['renewal', f.pDue]]);
      const lots = async () => h.q(
        `SELECT original_amount::float8 AS amount, billing_cycle_id FROM public.workspace_ai_balance_lots
          WHERE workspace_id = $1 AND source_type = 'PLAN_ALLOWANCE'`, [f.wDue]);
      expect(await lots()).toEqual([expect.objectContaining({ amount: AI_MONTH, billing_cycle_id: expect.stringMatching(/^cycle:account:/) })]);
      // The hourly grant finds the month funded.
      await c.query(`SELECT public.billing_account_grant_month($1, $2, $3, $4)`, [f.wDue, pro, p.period_start, p.period_end]);
      expect(await lots()).toHaveLength(1);
      expect(Number((await h.account(f.wDue)).balance_minor)).toBe(0);
    });

    it('R3 a period whose subscription was replaced is credited to the balance', async () => {
      expect((await h.ledger(f.wReplaced)).map((r) => [r.kind, r.amount, (r.description as Row).reason])).toEqual([
        ['admin_credit', 15_000_000, 'Billing v2 next period, replaced'],
      ]);
      const acc = await h.account(f.wReplaced);
      expect(Number(acc.balance_minor)).toBe(15_000_000);
      expect(acc.next_period_prepaid_minor).toBeNull();
      expect((await h.subOf(f.wReplaced)).plan_id).toBe(enterprise);
    });

    it('R3 an admin-granted next period with no money is needs_review, nothing written', async () => {
      expect(reviewOf(report, f.pAdminNext)).toMatchObject({ reason: 'period_without_payment', amount_minor: null });
      expect(await h.account(f.wAdminNext)).toBeUndefined();
      expect(await h.changes(f.wAdminNext)).toEqual([]);
    });

    it('R4 an unapplied payment is credited at its invoice net share, or at amount less refunds', async () => {
      const rows = await h.ledger(f.wPay);
      const byKey = Object.fromEntries(rows.map((r) => [String(r.idempotency_key), r.amount]));
      expect(byKey).toEqual({
        [`admin:v2:billing_payments:${f.payInvoice}`]: 10_000_000,
        [`admin:v2:billing_payments:${f.payLoose}`]: 2_000_000,
      });
      expect(Number((await h.account(f.wPay)).balance_minor)).toBe(12_000_000);
      expect((await h.logOf('billing_payments', f.payInvoice)).details).toMatchObject({ vat_basis: 'invoice_net_share' });
      expect(await h.logOf('billing_payments', f.paySettled)).toBeUndefined();
    });

    it('R4 a processing intent and a paid invoice never applied are needs_review, nothing written', async () => {
      expect(reviewOf(report, f.intentProcessing)).toMatchObject({ reason: 'intent_processing', amount_minor: 5_000_000 });
      expect(reviewOf(report, f.invoiceUnapplied)).toMatchObject({ reason: 'invoice_paid_not_applied', amount_minor: 5_000_000 });
      expect(reviewOf(report, f.intentOld)).toBeUndefined();
      expect(await h.account(f.wReview)).toBeUndefined();
      expect(await h.num(`SELECT count(*)::int AS n FROM public.billing_account_ledger WHERE workspace_id = $1`, [f.wReview])).toBe(0);
    });

    it('R5 past_due past its end and free_fallback become expired, same plan and dates, logged', async () => {
      for (const [ws, old] of [[f.wPastDueEnded, 'past_due'], [f.wFallback, 'free_fallback']] as const) {
        const sub = await h.subOf(ws);
        expect(sub).toMatchObject({
          status: 'expired', plan_id: pro, provider_name: 'account', current_period_id: null, next_plan_id: null,
          pending_change_type: null, past_due_since: null, free_fallback_at: null, grace_period_ends_at: null,
        });
        expect(at(sub.current_period_end)).toBeLessThan(Date.now());
        const log = await h.changes(ws);
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({ change_type: 'v2_migration', old_plan_id: pro, new_plan_id: pro });
        expect(log[0].metadata).toMatchObject({ source: 'billing_v2_migration', old_status: old, new_status: 'expired' });
      }
      expect((await h.subOf(f.wCanceledEnded)).status).toBe('expired');
      expect((await h.subOf(f.wPastDueRunning)).status).toBe('active');
    });

    it('R5 canceled at period end becomes active with auto-renew off; a pending cancel turns it off', async () => {
      for (const ws of [f.wCancelAtEnd, f.wPendingCancel]) {
        const sub = await h.subOf(ws);
        expect(sub).toMatchObject({ status: 'active', cancel_at_period_end: false, pending_change_type: null, canceled_at: null });
        expect(at(sub.current_period_end)).toBeGreaterThan(Date.now());
        expect((await h.account(ws)).auto_renew).toBe(false);
        expect((await h.changes(ws))[0].change_type).toBe('v2_migration');
      }
      expect((await h.logOf('workspace_subscriptions', f.sCancelAtEnd)).details).toMatchObject({ auto_renew_off: true });
    });

    it('R5 a pending downgrade becomes the account scheduled change', async () => {
      const acc = await h.account(f.wDowngrade);
      expect(acc).toMatchObject({ scheduled_plan_id: pro, scheduled_interval: 'yearly', next_period_prepaid_minor: null });
      expect(await h.subOf(f.wDowngrade)).toMatchObject({ status: 'active', plan_id: enterprise, next_plan_id: null, pending_change_type: null });
    });

    it('R5 unpaid is needs_review; an active v2 row with nothing pending is left alone', async () => {
      expect(reviewOf(report, f.sUnpaid)).toMatchObject({ reason: 'subscription_status_unpaid' });
      expect((await h.subOf(f.wUnpaid)).status).toBe('unpaid');
      expect(await h.changes(f.wUnpaid)).toEqual([]);
      expect(await h.changes(f.wPlainV2)).toEqual([]);
      expect(await h.logOf('workspace_subscriptions', f.sPlainV2)).toBeUndefined();
    });

    it('R5 no v2 row was changed or deleted by the move', async () => {
      expect(await h.num(`SELECT count(*)::int AS n FROM public.billing_subscription_periods WHERE status = 'scheduled'`)).toBe(7);
      expect(await h.num(`SELECT count(*)::int AS n FROM public.billing_payments WHERE reconciliation_state = 'unapplied'`)).toBe(3);
      expect(await h.num(`SELECT count(*)::int AS n FROM public.billing_payment_intents WHERE status = 'processing'`)).toBe(4);
    });

    it('review fix: an intent whose payment the move credits is not reviewed again (money counted once)', async () => {
      // The payment is credited once, at its invoice's net.
      expect((await h.ledger(f.wIntentPaid)).map((r) => [r.kind, r.amount, r.idempotency_key])).toEqual([
        ['admin_credit', 5_000_000, `admin:v2:billing_payments:${f.payOfIntent}`],
      ]);
      // The intent is no review item: following the runbook for it would credit the same money again.
      expect(reviewOf(report, f.intentPaid)).toBeUndefined();
      const plan = await h.q(`SELECT action, details FROM public.billing_v2_migration_plan($1) WHERE source_id = $2`, [f.wIntentPaid, f.intentPaid]);
      expect(plan).toEqual([{ action: 'ignored', details: expect.objectContaining({
        category: 'intent_paid_via_payment', linked_payment_id: f.payOfIntent, linked_payment_status: 'succeeded',
        linked_payment_reconciliation_state: 'unapplied', linked_payment_migration_action: 'credit',
      }) }]);
      // An intent whose only payment failed stays for a person, and the report shows the link.
      expect(reviewOf(report, f.intentFailedPay)).toMatchObject({
        reason: 'intent_processing', amount_minor: 700_000,
        details: expect.objectContaining({ linked_payment_id: f.failedPay, linked_payment_status: 'failed' }),
      });
    });

    it('review fix: an intent whose deposit reached the v2 wallet is not reviewed; the wallet is credited once', async () => {
      expect(reviewOf(report, f.intentDeposit)).toBeUndefined();
      expect((await h.ledger(f.wIntentDeposit)).map((r) => [r.kind, r.amount, r.idempotency_key])).toEqual([
        ['admin_credit', 3_000_000, `admin:v2:billing_wallet_accounts:${f.walletOfDeposit}`],
      ]);
      const plan = await h.q(`SELECT action, details->>'category' AS category FROM public.billing_v2_migration_plan($1) WHERE source_id = $2`,
        [f.wIntentDeposit, f.intentDeposit]);
      expect(plan).toEqual([{ action: 'ignored', category: 'intent_paid_via_wallet_deposit' }]);
    });

    it('review fix: a paid next period that already ended returns its money; the canceled subscription stays ended', async () => {
      const rows = await h.ledger(f.wElapsed);
      expect(rows.map((r) => [r.kind, r.amount, r.balance_after, (r.description as Row).reason])).toEqual([
        ['admin_credit', 1_000_000, 1_000_000, 'Billing v2 next period, never started'],
      ]);
      expect(Number((await h.account(f.wElapsed)).balance_minor)).toBe(1_000_000);
      const sub = await h.subOf(f.wElapsed);
      expect(sub.status).toBe('expired');
      expect(at(sub.current_period_end)).toBeLessThan(Date.now() - 39 * 86400_000);
      expect((await h.changes(f.wElapsed)).map((x) => x.change_type)).toEqual(['v2_migration']);
      expect(await h.num(`SELECT count(*)::int AS n FROM public.workspace_ai_balance_lots WHERE workspace_id = $1`, [f.wElapsed])).toBe(0);
      expect((await h.logOf('billing_subscription_periods', f.pElapsed)).details).toMatchObject({ credit_cause: 'period_elapsed' });
    });

    it('review fix: a running paid period behind a canceled subscription is credited, not activated', async () => {
      expect((await h.ledger(f.wCanceledDue)).map((r) => [r.kind, r.amount, (r.description as Row).reason])).toEqual([
        ['admin_credit', 2_000_000, 'Billing v2 next period, subscription canceled'],
      ]);
      expect((await h.subOf(f.wCanceledDue)).status).toBe('expired');
      expect((await h.changes(f.wCanceledDue)).map((x) => x.change_type)).toEqual(['v2_migration']);
    });

    it('review fix: a paid next period left to a person still blocks a second charge and holds the due moment', async () => {
      expect(reviewOf(report, f.pHeld)).toMatchObject({ reason: 'account_has_scheduled_change', amount_minor: 50_000_000 });
      expect((await h.one(`SELECT public.billing_account_v2_next_period($1) AS id`, [f.wHeld])).id).toBe(f.pHeld);
      await expect(c.query(`SELECT public.billing_account_renew($1)`, [f.wHeld])).rejects.toThrow(/billing_already_renewed/);
      // No reminder for a period that is paid.
      expect(await h.num(`SELECT count(*)::int AS n FROM public.billing_account_reminder_candidates(30) WHERE workspace_id = $1`, [f.wHeld])).toBe(0);

      await c.query('BEGIN');
      try {
        // The due moment passes: neither a renewal from the balance nor a drop to Free.
        await c.query(`
          UPDATE public.workspace_subscriptions
             SET current_period_start = current_period_start - interval '11 days',
                 current_period_end = current_period_end - interval '11 days'
           WHERE workspace_id = $1`, [f.wHeld]);
        const res = (await h.one(`SELECT public.billing_account_process_due($1) AS r`, [f.wHeld])).r as Row;
        expect(res).toEqual({ action: 'none', reason: 'v2_period_needs_review', period_id: f.pHeld });
        expect((await h.ledger(f.wHeld)).map((r) => r.kind)).toEqual(['admin_credit']);
        expect(await h.subOf(f.wHeld)).toMatchObject({ status: 'active', plan_id: enterprise });

        // Once a person decides (here: waived), simple billing takes over.
        await c.query(`SELECT public.billing_v2_migration_waive('billing_subscription_periods', $1, 'credited by hand')`, [f.pHeld]);
        expect((await h.one(`SELECT public.billing_account_v2_next_period($1) AS id`, [f.wHeld])).id).toBeNull();
        const after = (await h.one(`SELECT public.billing_account_process_due($1) AS r`, [f.wHeld])).r as Row;
        expect(after.action).not.toBe('none');
      } finally {
        await c.query('ROLLBACK');
      }
    });

    it('R7 a second move finds everything done; 267 runs again with nothing to do', async () => {
      const again = await h.move(true);
      expect(again.applied).toBe(0);
      expect(again.actions).toEqual([]);
      expect(again.already_done).toBe(report.applied);
      expect(reviewKeys(again.needs_review)).toEqual(reviewKeys(report.needs_review));

      const ledgerBefore = await h.num(`SELECT count(*)::int AS n FROM public.billing_account_ledger`);
      const rerun = await apply267(c);
      expect(rerun.applied).toBe(0);
      expect(rerun.already_done).toBe(report.applied);
      expect(await h.num(`SELECT count(*)::int AS n FROM public.billing_account_ledger`)).toBe(ledgerBefore);
    });

    it('R7 waive clears one item; waive(NULL, NULL) clears the rest; both check their reason', async () => {
      await expect(c.query(`SELECT public.billing_v2_migration_waive('billing_subscription_periods', $1, 'ok')`, [f.pAdminNext]))
        .rejects.toThrow(/billing_v2_waive_reason_required/);
      await expect(c.query(`SELECT public.billing_v2_migration_waive('billing_wallet_accounts', $1, 'already moved')`, [f.walletOk]))
        .resolves.toBeDefined(); // in the log already: a no-op
      await expect(c.query(`SELECT public.billing_v2_migration_waive('billing_payments', $1, 'not open')`, [f.paySettled]))
        .rejects.toThrow(/billing_v2_waive_not_open/);
      await expect(c.query(`SELECT public.billing_v2_migration_waive('billing_payments', NULL, 'half')`))
        .rejects.toThrow(/billing_v2_waive_bad_item/);

      await c.query(`SELECT public.billing_v2_migration_waive('billing_subscription_periods', $1, 'reassign from Super Admin after the period', $2)`,
        [f.pAdminNext, f.wAdminNext]);
      const after = await h.move(false);
      expect(reviewOf(after, f.pAdminNext)).toBeUndefined();
      expect(after.needs_review).toHaveLength(report.needs_review.length - 1);
      expect(await h.logOf('billing_subscription_periods', f.pAdminNext)).toMatchObject({
        action: 'waived', actor_id: f.wAdminNext,
        details: expect.objectContaining({ reason: 'reassign from Super Admin after the period', review_reason: 'period_without_payment' }),
      });

      await c.query(`SELECT public.billing_v2_migration_waive(NULL, NULL, 'checked by hand')`);
      const empty = await h.move(false);
      expect(empty.needs_review).toEqual([]);
      expect(empty.waived).toBe(report.needs_review.length);
      // Waiving wrote nothing to simple billing.
      expect(await h.account(f.wReview)).toBeUndefined();
    });

    it('R8 only the migration owner reaches the three functions and the log', async () => {
      for (const role of ['service_role', 'authenticated', 'anon']) {
        for (const sql of [
          `SELECT public.billing_v2_migrate_to_simple(false)`,
          `SELECT * FROM public.billing_v2_migration_plan()`,
          `SELECT public.billing_v2_migration_waive(NULL, NULL, 'nope')`,
          `SELECT count(*) FROM billing_v2_archive.migration_log`,
        ]) {
          await c.query('BEGIN');
          try {
            await c.query(`SET LOCAL ROLE ${role}`);
            await expect(c.query(sql)).rejects.toThrow(/permission denied/);
          } finally {
            await c.query('ROLLBACK');
          }
        }
      }
      const defs = await h.q(`
        SELECT p.proname, p.prosecdef, array_to_string(p.proconfig, ',') AS cfg
          FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('billing_v2_migration_plan', 'billing_v2_migrate_to_simple', 'billing_v2_migration_waive')
         ORDER BY 1`);
      expect(defs).toEqual(['billing_v2_migrate_to_simple', 'billing_v2_migration_plan', 'billing_v2_migration_waive']
        .map((proname) => ({ proname, prosecdef: true, cfg: 'search_path=public, pg_temp' })));
    });

    it('R9 a new workspace gets no v2 rows; a calendar AI lot is not refused', async () => {
      await c.query(`UPDATE public.billing_v2_policy SET new_workspace_default_state = 'v2_active'`);
      const ws = await h.workspace();
      expect(await h.num(`SELECT count(*)::int AS n FROM public.billing_v2_rollout WHERE workspace_id = $1`, [ws])).toBe(0);
      expect(await h.num(`SELECT count(*)::int AS n FROM public.billing_wallet_accounts WHERE workspace_id = $1`, [ws])).toBe(0);

      // A subscription v2 still marks as owning its allowances.
      await c.query(`UPDATE public.workspace_subscriptions SET v2_allowance_effective_period_id = $2 WHERE workspace_id = $1`,
        [f.wReplaced, (await h.one(`SELECT current_period_id AS id FROM public.workspace_subscriptions WHERE workspace_id = $1`, [f.wReplaced])).id]);
      await c.query(`
        INSERT INTO public.workspace_ai_balance_lots (workspace_id, source_type, billing_cycle_id, original_amount, remaining_amount)
        VALUES ($1, 'PLAN_ALLOWANCE', '2026-10', 1000, 1000)`, [f.wReplaced]);
    });

    it('R9 only the plan reads v2: the move, the waive and the redefined functions name no v2 table or v2 column', async () => {
      const v2Tables = (await h.q(`
        SELECT c.relname FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
           AND (c.relname LIKE 'billing\\_v2\\_%' OR c.relname IN (
                'billing_wallet_accounts', 'billing_wallet_ledger', 'billing_wallet_deposits', 'billing_payments',
                'billing_payment_intents', 'billing_payment_allocations', 'billing_invoices', 'billing_invoice_lines',
                'billing_invoice_applications', 'billing_invoice_collections', 'billing_subscription_periods',
                'billing_entitlement_cycles', 'billing_period_allowance_grants'))`)).map((r) => String(r.relname));
      expect(v2Tables.length).toBeGreaterThan(10);
      const v2Columns = ['current_period_id', 'v2_allowance_effective_period_id', 'billing_engine_version', 'billing_v2_effective_at',
        'billing_anchor_at', 'next_invoice_at', 'next_plan_id', 'pending_change_type', 'pending_change_currency'];
      const re = new RegExp(`\\b(${[...v2Tables, ...v2Columns].join('|')})\\b`);
      for (const fn of ['billing_v2_migrate_to_simple', 'billing_v2_migration_waive', 'billing_account_process_due',
        'billing_account_v2_next_period', 'app_review_seed_workspace']) {
        const src = String((await h.one(`SELECT prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = $1`, [fn])).prosrc);
        expect(src.match(re)?.[0] ?? null, fn).toBeNull();
      }
    });

    it('R9 billing_account_v2_next_period is NULL and process_due names no v2 table', async () => {
      expect((await h.one(`SELECT public.billing_account_v2_next_period($1) AS id`, [f.wAdminNext])).id).toBeNull();
      const def = String((await h.one(`SELECT pg_get_functiondef('public.billing_account_process_due(uuid)'::regprocedure) AS d`)).d);
      expect(def).not.toMatch(/billing_subscription_periods|billing_activate_period|v_v2/);
      const triggers = await h.q(`
        SELECT tgname FROM pg_trigger
         WHERE NOT tgisinternal AND tgname IN ('trg_billing_enroll_workspace', 'trg_billing_v2_seed_new_workspace',
                                               'trg_billing_v2_block_legacy_allowance')`);
      expect(triggers).toEqual([]);
    });

    it('R9 the App Review seed grants its plan through simple billing, to 2099, with no v2 period', async () => {
      const hash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';
      await c.query(`SELECT public.app_review_seed($1)`, [hash]);
      const row = await h.one(`
        SELECT s.status, s.provider_name, s.current_period_end, s.billing_interval, s.plan_id, w.id AS ws,
               (SELECT count(*)::int FROM public.billing_subscription_periods p WHERE p.workspace_id = w.id) AS periods,
               (SELECT count(*)::int FROM public.billing_v2_rollout r WHERE r.workspace_id = w.id) AS rollout,
               (SELECT count(*)::int FROM public.plan_change_log l WHERE l.workspace_id = w.id AND l.change_type = 'admin_grant') AS grants
          FROM public.workspaces w JOIN public.workspace_subscriptions s ON s.workspace_id = w.id
         WHERE w.slug = 'ws_appreview'`);
      expect(row).toMatchObject({ status: 'active', provider_name: 'account', billing_interval: 'yearly', periods: 0, rollout: 0, grants: 1 });
      expect(new Date(at(row.current_period_end)).toISOString()).toBe('2099-12-31T00:00:00.000Z');
      // A second run grants nothing more (the plan runs to 2099).
      await c.query(`SELECT public.app_review_seed()`);
      expect(await h.num(`SELECT count(*)::int AS n FROM public.plan_change_log WHERE workspace_id = $1`, [row.ws])).toBe(1);
      const def = String((await h.one(`SELECT pg_get_functiondef('public.app_review_seed_workspace(jsonb,uuid)'::regprocedure) AS d`)).d);
      expect(def).not.toMatch(/billing_engine_version|billing_subscription_periods|billing_activate_period/);
    });

    it('R1 an item that fails is rolled back and reported; the workspace\'s later items wait', async () => {
      await c.query('BEGIN');
      try {
        const ws = await h.workspace();
        const wallet = await h.walletDeposit(ws, 6_000_000);
        const pay = await h.payment(ws, { amount: 1_000_000 });
        await c.query(`
          CREATE FUNCTION pg_temp.refuse_wallet_credit() RETURNS trigger LANGUAGE plpgsql AS $f$
          BEGIN
            IF NEW.idempotency_key LIKE 'admin:v2:billing_wallet_accounts:%' THEN RAISE EXCEPTION 'test_refused'; END IF;
            RETURN NEW;
          END $f$;
          CREATE TRIGGER test_refuse BEFORE INSERT ON public.billing_account_ledger
            FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_wallet_credit();`);
        const r = await h.move(true);
        expect(r.applied).toBe(0);
        expect(reviewOf(r, wallet)).toMatchObject({ reason: 'apply_failed', error: 'test_refused' });
        expect(reviewOf(r, pay)).toMatchObject({ reason: 'earlier_item_failed' });
        expect(await h.ledger(ws)).toEqual([]);
        expect(await h.logOf('billing_wallet_accounts', wallet)).toBeUndefined();
        expect(await h.logOf('billing_payments', pay)).toBeUndefined();
      } finally {
        await c.query('ROLLBACK');
      }
    });

    it('R10 the old admin grant still activates a v2 period, and the move ignores it', async () => {
      const ws = await h.workspace();
      await c.query(`INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status) VALUES ($1, $2, 'active')`, [ws, free]);
      // adminGrantPlanV2 (server/services/billing/adminGrant.ts) as it runs before 7A.
      const period = await h.period(ws, { plan: pro, startIn: 0, endIn: 30 * 86400, source: 'admin' });
      await c.query(`SELECT public.billing_activate_period($1)`, [period]);
      const sub = await h.subOf(ws);
      expect(sub).toMatchObject({ plan_id: pro, current_period_id: period, status: 'active' });

      const r = await h.move(true);
      expect(r.applied).toBe(0);
      expect(r.needs_review.filter((i) => i.workspace_id === ws)).toEqual([]);
      expect(await h.logOf('workspace_subscriptions', String(sub.id))).toBeUndefined();

      // The simple-billing callers of the stub still run.
      await c.query(`SELECT * FROM public.billing_account_reminder_candidates(30)`);
      await c.query(`SELECT public.billing_account_process_due($1)`, [ws]);
    });

    it('review fix: a Super Admin assignment over a running v2 month grants the new month at once', async () => {
      await c.query(`UPDATE public.billing_plans SET ai_allowance = jsonb_build_object('IRR', 5000000::bigint) WHERE id = $1`, [enterprise]);
      const ws = await h.workspace();
      await c.query(`INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status) VALUES ($1, $2, 'active')`, [ws, free]);
      // Ten days into a v2 Pro month (its cycle lot runs 20 more days).
      const v2 = await h.period(ws, { plan: pro, startIn: -10 * 86400, endIn: 20 * 86400, source: 'admin', aiAllowance: 1_000_000 });
      await c.query(`SELECT public.billing_activate_period($1)`, [v2]);
      const v2Lots = await h.q(`
        SELECT billing_cycle_id FROM public.workspace_ai_balance_lots
         WHERE workspace_id = $1 AND source_type = 'PLAN_ALLOWANCE' AND billing_cycle_id NOT LIKE 'cycle:account:%'`, [ws]);
      expect(v2Lots.length).toBeGreaterThan(0);
      // The v2 month itself, running on, is still not funded twice.
      const p = await h.one(`SELECT period_start, period_end FROM public.billing_subscription_periods WHERE id = $1`, [v2]);
      expect(Number((await h.one(`SELECT public.billing_account_grant_month($1, $2, $3, $4) AS n`, [ws, pro, p.period_start, p.period_end])).n)).toBe(0);

      // POST /api/plans/admin/assign, as server/routes/plans.ts runs it.
      const span = await h.one(`SELECT now() AS s, now() + interval '30 days' AS e`);
      await c.query(`SELECT public.billing_account_write_subscription($1, $2, 'monthly', $3, $4, 'active', 'admin_assign', NULL, '{"source":"admin_assign"}')`,
        [ws, enterprise, span.s, span.e]);
      await c.query(`SELECT public.billing_account_admin_replaced($1)`, [ws]);
      const granted = await h.one(`SELECT public.billing_account_grant_month($1, $2, $3, $4, 'plan', NULL, $3) AS n`, [ws, enterprise, span.s, span.e]);
      expect(Number(granted.n)).toBe(5_000_000);
      // Granted once: the hourly job finds the month funded.
      expect(Number((await h.one(`SELECT public.billing_account_grant_month($1, $2, $3, $4) AS n`, [ws, enterprise, span.s, span.e])).n)).toBe(0);
      // The v2 lot stays the customer's.
      expect(await h.num(`
        SELECT count(*)::int AS n FROM public.workspace_ai_balance_lots
         WHERE workspace_id = $1 AND source_type = 'PLAN_ALLOWANCE' AND billing_cycle_id NOT LIKE 'cycle:account:%'`, [ws])).toBe(v2Lots.length);
    });
  });

  // ──────────────────────── International (RESPOK) ─────────────────────────
  describe('edition international', () => {
    let c: pg.Client;
    let h: ReturnType<typeof helpers>;
    let pro = '';
    const f = { wWallet: '', wallet: '', wPrepay: '', pPrepay: '', wPay: '', pay: '', wPastDue: '', sPastDue: '' };
    let report: Report;

    beforeAll(async () => {
      c = await connect(INTL);
      h = helpers(c);
      expect((await h.one(`SELECT public.platform_edition() AS e`)).e).toBe('international');
      pro = await h.planId('pro');

      f.wWallet = await h.workspace();
      f.wallet = await h.walletDeposit(f.wWallet, 7_000_000);
      f.wPrepay = await h.workspace();
      await h.sub(f.wPrepay, { plan: pro, endIn: 10 * 86400 });
      f.pPrepay = await h.periodAfterSub(f.wPrepay, { plan: pro, invoice: await h.invoice(f.wPrepay, { subtotal: 15_000_000 }) });
      f.wPay = await h.workspace();
      f.pay = await h.payment(f.wPay, { amount: 3_000_000 });
      f.wPastDue = await h.workspace();
      f.sPastDue = await h.sub(f.wPastDue, { plan: pro, status: 'past_due', endIn: -86400 });
    }, 120_000);

    afterAll(async () => {
      await c?.end();
    });

    it('R11 267 raises without 266 and without 265, and changes nothing', async () => {
      for (const drop of [
        'DROP FUNCTION public.billing_account_admin_adjust(uuid, bigint, text, text, uuid, text, text, bigint)',
        'DROP FUNCTION public.billing_lock_cutoff(uuid, text, uuid) CASCADE',
      ]) {
        await c.query('BEGIN');
        try {
          await c.query(drop);
          await expect(c.query(BODY_267)).rejects.toThrow(/267 needs 26[56]/);
        } finally {
          await c.query('ROLLBACK');
        }
      }
      expect(await h.num(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'billing_v2_archive'`)).toBe(0);
    });

    it('R9 before 267 the v2 triggers enrol a new workspace and refuse a calendar lot (the baseline)', async () => {
      await c.query('BEGIN');
      try {
        await c.query(`UPDATE public.billing_v2_policy SET new_workspace_default_state = 'v2_active'`);
        const ws = await h.workspace();
        expect(await h.num(`SELECT count(*)::int AS n FROM public.billing_wallet_accounts WHERE workspace_id = $1`, [ws])).toBe(1);
        expect(await h.num(`SELECT count(*)::int AS n FROM public.billing_v2_rollout WHERE workspace_id = $1`, [ws])).toBe(1);
        const period = await h.period(f.wPrepay, { plan: pro, status: 'active', startIn: -86400, endIn: 86400, source: 'admin' });
        await c.query(`UPDATE public.workspace_subscriptions SET v2_allowance_effective_period_id = $2 WHERE workspace_id = $1`, [f.wPrepay, period]);
        await expect(c.query(`
          INSERT INTO public.workspace_ai_balance_lots (workspace_id, source_type, billing_cycle_id, original_amount, remaining_amount)
          VALUES ($1, 'PLAN_ALLOWANCE', '2026-10', 1000, 1000)`, [f.wPrepay])).rejects.toThrow(/billing_v2_legacy_allowance_grant_forbidden/);
      } finally {
        await c.query('ROLLBACK');
      }
    });

    it('R6 every money item is needs_review, no ledger row is written; subscriptions are still normalised', async () => {
      report = await apply267(c);
      expect(report.edition).toBe('international');
      expect(reviewKeys(report.needs_review)).toEqual([
        `billing_payments:${f.pay}:edition_international`,
        `billing_subscription_periods:${f.pPrepay}:edition_international`,
        `billing_wallet_accounts:${f.wallet}:edition_international`,
      ].sort());
      expect(keys(report.actions)).toEqual([`workspace_subscriptions:${f.sPastDue}:normalize:`]);
      expect(report.totals).toEqual({ credited_minor: 0, prepaid_minor: 0 });
      expect(await h.num(`SELECT count(*)::int AS n FROM public.billing_account_ledger`)).toBe(0);
      for (const ws of [f.wWallet, f.wPrepay, f.wPay]) expect(await h.account(ws)).toBeUndefined();
      expect((await h.subOf(f.wPastDue)).status).toBe('expired');
      expect((await h.changes(f.wPastDue))[0].change_type).toBe('v2_migration');
    });

    it('R7 a second 267 and a second move do nothing; the clone residue waives in one call', async () => {
      const rerun = await apply267(c);
      expect(rerun.applied).toBe(0);
      expect(rerun.already_done).toBe(1);
      expect(reviewKeys(rerun.needs_review)).toEqual(reviewKeys(report.needs_review));
      await c.query(`SELECT public.billing_v2_migration_waive(NULL, NULL, 'clone_residue: RESPOK was cloned from WebYar; same ids in WebYar')`);
      const after = await h.move(true);
      expect(after.needs_review).toEqual([]);
      expect(after.waived).toBe(3);
      expect(await h.num(`SELECT count(*)::int AS n FROM public.billing_account_ledger`)).toBe(0);
    });

    it('R6 the amount of a money item over the cap stays needs_review in iran too (cap check is per item)', async () => {
      // Plan-level check, without moving money: switch the edition inside a
      // rolled-back transaction and read the plan.
      await c.query('BEGIN');
      try {
        await c.query(`UPDATE public.platform_settings SET region_mode = 'iran'`);
        const ws = await h.workspace();
        const wallet = await h.walletDeposit(ws, CAP_IRR + 1);
        const plan = await h.q(`SELECT action, details->>'reason' AS reason FROM public.billing_v2_migration_plan($1) WHERE source_id = $2`, [ws, wallet]);
        expect(plan).toEqual([{ action: 'needs_review', reason: 'amount_over_cap' }]);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });
});
