// @vitest-environment node
/**
 * The Super Admin credit/debit rate limit, counted from the ledger
 * (server/services/billing/account/adjustRateLimit.ts; docs/billing/SIMPLE_BILLING.md,
 * phase 6 "Credit and debit"), against real PostgreSQL built by the whole
 * migration chain and read through the postgres-only engine as the backend does.
 *
 *   R1 only the admin's own admin_credit / admin_debit rows of the last hour
 *      count (not another admin's, not other kinds, not older rows);
 *   R2 at the limit a new key is refused and a booked key (a replay) is not;
 *   R3 the count is the database's: two "processes" (two pools) see the same;
 *   R4 billing_account_admin_adjust itself enforces it (270): the change past
 *      the limit is refused in SQL, a replay and a NULL actor (a migration)
 *      are not limited;
 *   R5 requests sent at the same time, each for another workspace, cannot get
 *      past it: the per-admin lock serializes the count and the booking.
 *
 * Its own database (CREATE DATABASE on the TEST_DATABASE_URL server).
 * Skipped without TEST_DATABASE_URL; REQUIRE_BILLING_DB=1 makes that a failure.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { applyMigrationSql } from './pgMigrationChain';
import { DatabasePool, databaseSettings } from '../../../server/db/pool';
import { PostgrestEngine } from '../../../server/db/postgrest/engine';
import { SchemaCache } from '../../../server/db/postgrest/schemaCache';
import { createPgFetch } from '../../../server/db/pgFetch';
import type { ServerConfig } from '../../../server/config';

const svc = vi.hoisted(() => ({ clients: new Map<string, unknown>() }));

vi.mock('../../../server/supabase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/supabase.js')>()),
  // Each fake config names the pool ("process") it reads through.
  getServiceClient: (config: { name: string }) => svc.clients.get(config.name),
}));

const { adjustAllowed, countRecentAdminAdjusts } = await import('../../../server/services/billing/account/adjustRateLimit');
const { ADJUST_RATE_LIMIT } = await import('../../../shared/simpleBillingAdmin');

const DSN = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_BILLING_DB === '1' && !DSN) {
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the adjust rate limit SQL tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `adjustratelimit_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');

let admin: pg.Client;
let db: pg.Client;
let dbUrl: string;
const pools: DatabasePool[] = [];
const cfgA = { name: 'a' } as unknown as ServerConfig;
const cfgB = { name: 'b' } as unknown as ServerConfig;

function engineClient(url: string): SupabaseClient {
  const settings = databaseSettings({ DATABASE_URL: url })!;
  const pool = new DatabasePool(settings);
  pools.push(pool);
  const engine = new PostgrestEngine(pool, new SchemaCache(pool, settings.schemas), { maxRows: settings.maxRows });
  return createClient('http://direct-database.invalid', 'direct-database', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: createPgFetch(engine) },
  });
}

async function makeWorkspace(): Promise<string> {
  const owner = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
  const id = randomUUID();
  await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
  return id;
}

/** Books `n` changes of `actor` through 266's function; returns their command keys. */
async function book(ws: string, actor: string | null, n: number, amount = 100): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const key = randomUUID();
    await db.query(`SELECT public.billing_account_admin_adjust($1, $2, 'USD', 'rate test', $3, $4, 'test', NULL)`, [ws, amount, actor, key]);
    keys.push(key);
  }
  return keys;
}

suite('adjust rate limit counted from the ledger (real PostgreSQL, whole chain)', () => {
  beforeAll(async () => {
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    const url = new URL(DSN!);
    url.pathname = `/${DB}`;
    dbUrl = url.toString();
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    await db.query('SET client_min_messages = warning');
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
    svc.clients.set('a', engineClient(url.toString()));
    svc.clients.set('b', engineClient(url.toString()));
  }, 600_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('R1 only the admin\'s own admin_credit / admin_debit rows of the last hour count', async () => {
    const ws = await makeWorkspace();
    const actor = randomUUID();
    await book(ws, actor, 3);
    await book(ws, actor, 2, -100);
    await book(ws, randomUUID(), 4);
    await book(ws, null, 2);
    // Another kind on the same workspace, stamped with the admin as actor, does not count either.
    await db.query(
      `INSERT INTO public.billing_account_ledger (workspace_id, kind, amount_minor, balance_after, currency, actor_id, idempotency_key)
       VALUES ($1, 'topup', 100, 100, 'USD', $2, $3)`,
      [ws, actor, `rate-test:${randomUUID()}`],
    );
    expect(await countRecentAdminAdjusts(cfgA, actor)).toBe(5);
    // The ledger is append-only, so "older than an hour" is read an hour and a minute later.
    expect(await countRecentAdminAdjusts(cfgA, actor, Date.now() + 61 * 60_000)).toBe(0);
    expect(await countRecentAdminAdjusts(cfgA, actor, Date.now() + 59 * 60_000)).toBe(5);
  });

  it('R2 at the limit a new key is refused and a replay of a booked key is not', async () => {
    const ws = await makeWorkspace();
    const actor = randomUUID();
    const keys = await book(ws, actor, 29);
    expect(await adjustAllowed(cfgA, actor, randomUUID())).toBe(true);
    keys.push(...(await book(ws, actor, 1)));
    expect(await adjustAllowed(cfgA, actor, randomUUID())).toBe(false);
    expect(await adjustAllowed(cfgA, actor, keys[0])).toBe(true);
    expect(await adjustAllowed(cfgA, randomUUID(), randomUUID())).toBe(true);
  });

  it('R3 two processes see the same count', async () => {
    const ws = await makeWorkspace();
    const actor = randomUUID();
    await book(ws, actor, 30);
    expect(await countRecentAdminAdjusts(cfgA, actor)).toBe(30);
    expect(await countRecentAdminAdjusts(cfgB, actor)).toBe(30);
    expect(await adjustAllowed(cfgB, actor, randomUUID())).toBe(false);
  });

  it('R4 the SQL refuses the change past the limit; a replay and a NULL actor are not limited', async () => {
    const ws = await makeWorkspace();
    const actor = randomUUID();
    const keys = await book(ws, actor, ADJUST_RATE_LIMIT.max);
    await expect(book(ws, actor, 1)).rejects.toThrow(/billing_adjust_rate_limited/);
    const replay = await db.query(
      `SELECT public.billing_account_admin_adjust($1, 100, 'USD', 'rate test', $2, $3, 'test', NULL) AS r`, [ws, actor, keys[0]]);
    expect(replay.rows[0].r.replayed).toBe(true);
    await book(ws, null, ADJUST_RATE_LIMIT.max + 1);
    expect(await countRecentAdminAdjusts(cfgA, actor)).toBe(ADJUST_RATE_LIMIT.max);
  });

  it('R5 requests sent at the same time for different workspaces cannot pass the limit', async () => {
    const actor = randomUUID();
    const n = ADJUST_RATE_LIMIT.max + 20;
    const workspaces: string[] = [];
    for (let i = 0; i < n; i++) workspaces.push(await makeWorkspace());
    const pool = new pg.Pool({ connectionString: dbUrl, max: n });
    try {
      // Every connection open first, so the requests really overlap.
      const clients = await Promise.all(workspaces.map(() => pool.connect()));
      const results = await Promise.allSettled(clients.map((c, i) => c.query(
        `SELECT public.billing_account_admin_adjust($1, 100, 'USD', 'burst', $2, $3, 'test', 0)`,
        [workspaces[i], actor, randomUUID()],
      )));
      for (const c of clients) c.release();
      const booked = results.filter((r) => r.status === 'fulfilled').length;
      const refused = results.filter((r) => r.status === 'rejected' && /billing_adjust_rate_limited/.test(String(r.reason))).length;
      expect(booked).toBe(ADJUST_RATE_LIMIT.max);
      expect(refused).toBe(n - ADJUST_RATE_LIMIT.max);
      expect(await countRecentAdminAdjusts(cfgA, actor)).toBe(ADJUST_RATE_LIMIT.max);
    } finally {
      await pool.end();
    }
  });
});
