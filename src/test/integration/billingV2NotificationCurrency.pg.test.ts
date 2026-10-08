// @vitest-environment node
/**
 * 256 — billing notifications name the currency of their amount, on a
 * database built by the whole chain.
 *
 * The chain is applied up to 255 first, and every scenario below runs there:
 * an invoice issued (email + SMS + reminders), a due invoice paid from the
 * wallet, a due invoice the wallet cannot cover (insufficient + past due), and
 * a gateway payment row. The notification jobs each one queues are recorded.
 * Then 256 is applied (twice) and every scenario runs again on identical
 * fixtures: each job is the same, with `currency: 'IRR'` added to every
 * payload that carries an amount, and nothing else.
 *
 * After that, the same flows in USD queue `currency: 'USD'`, and the message
 * the dispatcher renders from such a job reads "$29.00", not "2,900 IRR".
 *
 * Its own database (CREATE DATABASE on the TEST_DATABASE_URL server), as
 * billingV2RenewalCurrency.pg.test.ts. Skipped without TEST_DATABASE_URL;
 * REQUIRE_BILLING_DB=1 makes that a failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';
import { renderBillingNotification } from '../../../server/services/billing/notifications/messages';

const DSN = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_BILLING_DB === '1' && !DSN) {
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the 256 notification currency tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `notifcur256_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '256_billing_v2_notification_currency.sql';
const DAY = 86_400_000;
const BASE = Math.floor(Date.now() / 1000) * 1000;
const at = (days: number): string => new Date(BASE + days * DAY).toISOString();

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

const FUNCTIONS = [
  'public.billing_v2_schedule_invoice_notifications(uuid)',
  'public.billing_v2_process_due_invoice(uuid)',
  'public.billing_notify_payment_recorded()',
];

const functionAttributes = (): Promise<Row[]> =>
  q(
    `SELECT p.oid::regprocedure::text AS fn, p.prosecdef, p.proconfig, p.provolatile, p.prorettype::regtype::text AS returns,
            pg_get_function_arguments(p.oid) AS args, pg_get_userbyid(p.proowner) AS owner,
            (SELECT array_agg(a ORDER BY a) FROM unnest(p.proacl::text[]) a) AS acl
       FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`,
    [FUNCTIONS],
  );

// ── Fixtures ────────────────────────────────────────────────────────────────

async function makeWorkspace(): Promise<string> {
  const id = randomUUID();
  const owner = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
  await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, $2, $2, $3)`, [
    id, `ws-${id.slice(0, 8)}`, owner,
  ]);
  await db.query(
    `INSERT INTO public.billing_v2_rollout (workspace_id, state, region, activated_at)
     VALUES ($1, 'v2_active', 'IR', now())
     ON CONFLICT (workspace_id) DO UPDATE SET state = 'v2_active'`,
    [id],
  );
  return id;
}

async function makeSubscription(ws: string): Promise<string> {
  const plan = randomUUID();
  await db.query(
    `INSERT INTO public.billing_plans (id, name, slug, prices, limits, default_currency, is_free)
     VALUES ($1, 'Pro', $2, '{"IRR":{"monthly":1500000},"USD":{"monthly":2900}}'::jsonb, '{}'::jsonb, 'IRR', false)`,
    [plan, `pro-${plan.slice(0, 8)}`],
  );
  return (await one(
    `INSERT INTO public.workspace_subscriptions
       (workspace_id, plan_id, status, billing_interval, current_period_start, current_period_end,
        next_invoice_at, billing_engine_version)
     VALUES ($1, $2, 'active', 'monthly', $3, $4, $4, 'v2') RETURNING id`,
    [ws, plan, at(-20), at(10)],
  )).id as string;
}

/** An open renewal invoice in `currency` (draft → open arms the dunning lifecycle). */
async function openInvoice(ws: string, sub: string, currency: string, amount: number, dueInDays: number): Promise<string> {
  const inv = await one(
    `INSERT INTO public.billing_invoices
       (workspace_id, subscription_id, invoice_number, invoice_type, status, currency, subtotal_irr,
        total_irr, amount_due_irr, issued_at, due_at, billing_interval, effect_snapshot)
     VALUES ($1, $2, public.billing_v2_document_number(), 'subscription_renewal', 'draft', $3,
             $4, $4, $4, now(), $5, 'monthly', '{}'::jsonb)
     RETURNING id`,
    [ws, sub, currency, amount, at(dueInDays)],
  );
  await db.query(`UPDATE public.billing_invoices SET status = 'open' WHERE id = $1`, [inv.id]);
  return inv.id as string;
}

async function fundWallet(ws: string, amount: number): Promise<void> {
  await db.query(
    `INSERT INTO public.billing_wallet_accounts (workspace_id) VALUES ($1) ON CONFLICT (workspace_id) DO NOTHING`, [ws],
  );
  await db.query(`SELECT public.billing_wallet_append($1, 'deposit', $2, $3, 'test', NULL, NULL, NULL, NULL)`, [
    ws, amount, `fund:${randomUUID()}`,
  ]);
}

const pastDue = async (invoiceId: string): Promise<void> => {
  await db.query(`UPDATE public.billing_invoices SET due_at = $2 WHERE id = $1`, [invoiceId, at(-1 / 24)]);
  await db.query(`SELECT public.billing_v2_process_due_invoice($1)`, [invoiceId]);
};

// Wall-clock values that differ between two runs of the same scenario.
const VOLATILE = new Set(['invoice_number', 'grace_period_ends_at']);

/** Every notification job of the workspace: type, channel and payload. */
async function jobsOf(ws: string): Promise<Row[]> {
  const rows = await q(
    `SELECT notification_type, channel, payload FROM public.billing_notification_jobs WHERE workspace_id = $1`, [ws],
  );
  return rows
    .map((r) => ({
      type: r.notification_type,
      channel: r.channel,
      payload: Object.fromEntries(
        Object.entries(r.payload as Row).sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, VOLATILE.has(k) ? '<volatile>' : v]),
      ),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

interface Scenario { name: string; run: (currency: string, amount: number) => Promise<Row[]> }

const SCENARIOS: Scenario[] = [
  {
    name: 'invoice issued: email, SMS and two reminders',
    run: async (currency, amount) => {
      const ws = await makeWorkspace();
      await openInvoice(ws, await makeSubscription(ws), currency, amount, 10);
      return jobsOf(ws);
    },
  },
  {
    name: 'due day, the wallet cannot cover it: insufficient (IRR) / not the wallet\'s currency, then past due',
    run: async (currency, amount) => {
      const ws = await makeWorkspace();
      const inv = await openInvoice(ws, await makeSubscription(ws), currency, amount, 10);
      await pastDue(inv);
      return jobsOf(ws);
    },
  },
  {
    name: 'a gateway payment row',
    run: async (currency, amount) => {
      const ws = await makeWorkspace();
      await db.query(
        `INSERT INTO public.billing_payments (workspace_id, amount, currency, status, provider_name, invoice_number, plan_name_snapshot)
         VALUES ($1, $2, $3, 'succeeded', 'test', $4, 'Pro')`,
        [ws, amount, currency, `WY${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`],
      );
      return jobsOf(ws);
    },
  },
];

/** The wallet pays IRR only: run in IRR alone. */
const WALLET_PAID: Scenario = {
  name: 'due day, paid from the wallet',
  run: async (currency, amount) => {
    const ws = await makeWorkspace();
    const inv = await openInvoice(ws, await makeSubscription(ws), currency, amount, 10);
    await fundWallet(ws, amount * 2);
    await pastDue(inv);
    return jobsOf(ws);
  },
};

const ALL_IRR = [...SCENARIOS, WALLET_PAID];

suite('256 — notification payloads carry their currency (whole chain, PostgreSQL)', () => {
  const before = new Map<string, Row[]>();
  let attributesBefore: Row[] = [];

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
    for (const file of files.filter((f) => f < FILE)) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
    await db.query(
      `UPDATE public.billing_v2_policy SET reminder_days_before_due = ARRAY[5,1], send_invoice_issued_email = true,
              send_invoice_issued_sms = true, notify_on_past_due = true WHERE id`,
    );

    for (const s of ALL_IRR) before.set(s.name, await s.run('IRR', 1_500_000));
    attributesBefore = await functionAttributes();

    const migration = readFileSync(resolve(DIR, FILE), 'utf8');
    await applyMigrationSql(db, migration);
    await applyMigrationSql(db, migration);
    for (const file of files.filter((f) => f > FILE)) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
  }, 600_000);

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('the IRR record before 256 is a real one', () => {
    const issued = before.get(SCENARIOS[0].name)!;
    expect(issued.map((j) => `${j.type}:${j.channel}`)).toEqual([
      'invoice_issued:email', 'invoice_issued:sms', 'invoice_reminder:email', 'invoice_reminder:email',
    ]);
    expect(issued[0].payload).toMatchObject({ amount_irr: 1_500_000 });
    expect(issued[0].payload).not.toHaveProperty('currency');
    expect(before.get(SCENARIOS[1].name)!.map((j) => `${j.type}:${j.channel}`)).toEqual(expect.arrayContaining(
      ['invoice_past_due:email', 'invoice_past_due:sms', 'wallet_autopay_insufficient:email'],
    ));
    expect(before.get(WALLET_PAID.name)!.some((j) => j.type === 'payment_received')).toBe(true);
    expect(before.get(SCENARIOS[2].name)!.map((j) => j.type)).toEqual(['payment_received']);
  });

  it.each(ALL_IRR.map((s) => [s.name, s] as const))(
    'IRR, the same jobs as before 256 plus currency IRR where an amount is: %s',
    async (_name, s) => {
      const expected = before.get(s.name)!.map((j) => ({
        ...j,
        payload: Object.fromEntries(
          Object.entries('amount_irr' in (j.payload as Row) ? { ...(j.payload as Row), currency: 'IRR' } : (j.payload as Row))
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      }));
      expect(await s.run('IRR', 1_500_000)).toEqual(expected);
    },
  );

  it.each(SCENARIOS.map((s) => [s.name, s] as const))('USD: every amount is labelled USD: %s', async (_name, s) => {
    const jobs = await s.run('USD', 2900);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      const payload = j.payload as Row;
      if ('amount_irr' in payload) expect(payload).toMatchObject({ amount_irr: 2900, currency: 'USD' });
      else expect(payload).not.toHaveProperty('currency');
    }
  });

  it('the dispatcher renders a USD job as dollars', async () => {
    const jobs = await SCENARIOS[1].run('USD', 2900);
    const pastDueEmail = jobs.find((j) => j.type === 'invoice_past_due' && j.channel === 'email')!;
    const msg = renderBillingNotification('invoice_past_due', 'en', pastDueEmail.payload as Row);
    expect(msg.text).toContain('for $29.00 was not paid');
    expect(msg.text).not.toContain('IRR');
    // The wallet never paid it: no "insufficient" notice for a dollar invoice.
    expect(jobs.some((j) => j.type === 'wallet_autopay_insufficient')).toBe(false);
  });

  it('keeps every signature, SECURITY DEFINER, search_path, owner and grant', async () => {
    expect(await functionAttributes()).toEqual(attributesBefore);
    expect(attributesBefore).toHaveLength(3);
    for (const fn of FUNCTIONS) {
      for (const role of ['anon', 'authenticated']) {
        const row = await one(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
        expect(`${role}:${fn}:${row.ok}`).toBe(`${role}:${fn}:false`);
      }
    }
  });

  it('runs again without changing anything', async () => {
    const defs = async () => q(`SELECT md5(pg_get_functiondef(f::regprocedure)) AS h FROM unnest($1::text[]) f ORDER BY f`, [FUNCTIONS]);
    const first = await defs();
    await applyMigrationSql(db, readFileSync(resolve(DIR, FILE), 'utf8'));
    expect(await defs()).toEqual(first);
  });
});
