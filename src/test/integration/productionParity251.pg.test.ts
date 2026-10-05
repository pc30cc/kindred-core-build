// @vitest-environment node
/**
 * 251_production_parity.sql on a database of its own: the whole chain applied
 * once, in order, as scripts/migrate-database.sh applies it — then what 251
 * brings, exercised rather than listed.
 *
 *   - the plan-and-access functions the hosted chain had and the self-host
 *     chain lacked (check_workspace_entitlement, check_module_access,
 *     check_channel_access, deduct_ai_credits): plan values, workspace
 *     overrides first, a plan's limit enforced, service_role only;
 *   - seat capacity: the plan's max_agents, unless a fixed limit is set;
 *   - the new-workspace trigger: nothing under the 'legacy' default, its
 *     wallet and audit rows under any other;
 *   - running 251 again changes nothing.
 *
 * It needs its own database: the shared integration database re-applies
 * 024+ for every suite (authStubSchema.ts), and an older file cannot run
 * again after 251 has dropped what it names — so 251 is left out there, as
 * 223 is. Driven by TEST_DATABASE_URL (a role that may CREATE DATABASE);
 * skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;
const DB = `parity251_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const OWNER = '00000000-0000-0000-0000-00000000a251';
const WS = '00000000-0000-0000-0000-00000000b251';

suite('251 — production parity, exercised on a database built by the whole chain', () => {
  let admin: pg.Client;
  let db: pg.Client;

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> =>
    (await db.query(sql, params)).rows[0] as T;
  const entitlement = (feature: string) =>
    one<{ r: Record<string, unknown> }>('SELECT public.check_workspace_entitlement($1, $2) AS r', [WS, feature]).then((x) => x.r);
  const fingerprint = async () =>
    (await db.query(readFileSync(resolve(process.cwd(), 'scripts/db/schema-fingerprint.sql'), 'utf8'))).rows
      .map((r) => Object.values(r)[0])
      .join('\n');

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
    await db.query("SET client_min_messages = warning");
    // Byte order, as LC_ALL=C sort orders them for migrate-database.sh.
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
    await db.query(`
      INSERT INTO public.billing_plans (slug, name, is_active, entitlements, limits)
      VALUES ('p251', 'P251', true, '{"live_chat": true, "voice_calls": false}', '{"max_agents": 3, "ai_credits": 5}');
      INSERT INTO public.profiles (id, email) VALUES ('${OWNER}', 'owner251@example.test');
      INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ('${WS}', 'W251', 'w251', '${OWNER}');
      INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status)
      SELECT '${WS}', id, 'active' FROM public.billing_plans WHERE slug = 'p251'
      ON CONFLICT (workspace_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active';
    `);
  }, 600_000);

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  it('the four plan-and-access functions exist and only service_role may call them', async () => {
    for (const fn of [
      'public.check_workspace_entitlement(uuid, text)',
      'public.check_module_access(uuid, text)',
      'public.check_channel_access(uuid, text)',
      'public.deduct_ai_credits(uuid, integer, text)',
    ]) {
      const r = await one<{ anon: boolean; auth: boolean; pub: boolean; svc: boolean; definer: boolean }>(
        `SELECT has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS auth,
                has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS pub,
                has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS svc,
                (SELECT prosecdef FROM pg_proc WHERE oid = $1::regprocedure) AS definer`,
        [fn],
      );
      expect({ fn, ...r }).toEqual({ fn, anon: false, auth: false, pub: false, svc: true, definer: true });
    }
  });

  it('check_workspace_entitlement answers from the active plan, an override first', async () => {
    expect(await entitlement('live_chat')).toEqual({ allowed: true, plan: 'p251' });
    expect(await entitlement('voice_calls')).toEqual({ allowed: false, plan: 'p251' });
    expect(await entitlement('max_agents')).toEqual({ allowed: true, limit: 3, plan: 'p251', source: 'plan' });
    expect(await entitlement('no_such_feature')).toEqual({ allowed: false, plan: 'p251', reason: 'feature_not_in_plan' });
    await db.query(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value) VALUES ($1, 'max_agents', 7)`, [WS]);
    expect(await entitlement('max_agents')).toEqual({ allowed: true, limit: 7, plan: 'p251', source: 'override' });
    await db.query(`DELETE FROM public.workspace_limit_overrides WHERE workspace_id = $1`, [WS]);
  });

  it('a lapsed subscription falls back to the free plan', async () => {
    await db.query(`UPDATE public.workspace_subscriptions SET status = 'expired' WHERE workspace_id = $1`, [WS]);
    expect((await entitlement('max_agents')).plan).toBe('free');
    await db.query(`UPDATE public.workspace_subscriptions SET status = 'active' WHERE workspace_id = $1`, [WS]);
  });

  it('check_module_access and check_channel_access: a workspace override wins over the plan', async () => {
    const mod = async () => (await one<{ r: Record<string, unknown> }>('SELECT public.check_module_access($1, $2) AS r', [WS, 'live_chat'])).r;
    const chan = async () => (await one<{ r: Record<string, unknown> }>('SELECT public.check_channel_access($1, $2) AS r', [WS, 'live_chat'])).r;
    expect(await mod()).toEqual({ allowed: true, source: 'plan', plan: 'p251' });
    expect(await chan()).toEqual({ allowed: true, source: 'plan', plan: 'p251' });
    await db.query(`INSERT INTO public.workspace_module_overrides (workspace_id, module_key, enabled) VALUES ($1, 'live_chat', false)`, [WS]);
    await db.query(`INSERT INTO public.workspace_channel_overrides (workspace_id, channel_key, enabled) VALUES ($1, 'live_chat', false)`, [WS]);
    expect(await mod()).toEqual({ allowed: false, source: 'override' });
    expect(await chan()).toEqual({ allowed: false, source: 'override' });
  });

  it('deduct_ai_credits enforces the plan limit and counts only what it deducted', async () => {
    const deduct = async (n: number) =>
      (await one<{ r: Record<string, unknown> }>(`SELECT public.deduct_ai_credits($1, $2, '2026-10') AS r`, [WS, n])).r;
    expect(await deduct(3)).toMatchObject({ success: true, credits_used: 3, credits_limit: 5 });
    expect(await deduct(3)).toMatchObject({ success: false, reason: 'credits_exhausted', credits_used: 3, credits_limit: 5 });
    expect(await deduct(2)).toMatchObject({ success: true, credits_used: 5 });
    const used = await one<{ n: number }>(
      `SELECT ai_credits_used AS n FROM public.workspace_usage_counters WHERE workspace_id = $1 AND period = '2026-10'`, [WS]);
    expect(used.n).toBe(5);
  });

  it('seat capacity is the plan\'s max_agents, unless the install sets a fixed limit', async () => {
    const seats = () => one<{ limit_value: number; source: string }>('SELECT * FROM public.wi_resolve_seat_capacity($1)', [WS]);
    expect(await seats()).toMatchObject({ limit_value: 3, source: 'plan_authoritative' });
    await db.query('UPDATE public.workspace_seat_entitlement_mode SET seat_limit = 9 WHERE id');
    expect(await seats()).toMatchObject({ limit_value: 9, source: 'self_host_fixed_limit' });
    await db.query('UPDATE public.workspace_seat_entitlement_mode SET seat_limit = NULL WHERE id');
  });

  it('the new-workspace trigger adds its wallet and audit rows only when the policy default is not legacy', async () => {
    // (billing_v2_rollout is written for every new workspace by the older
    // trg_billing_enroll_workspace, so it is not this trigger's evidence.)
    const rows = async (ws: string) =>
      one<{ wallet: number; audit: number }>(
        `SELECT (SELECT count(*)::int FROM public.billing_wallet_accounts WHERE workspace_id = $1) AS wallet,
                (SELECT count(*)::int FROM public.billing_v2_audit
                  WHERE workspace_id = $1 AND event = 'billing_v2_new_workspace_default') AS audit`, [ws]);
    expect(await one('SELECT new_workspace_default_state AS s FROM public.billing_v2_policy WHERE id')).toEqual({ s: 'legacy' });
    await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ('00000000-0000-0000-0000-00000000c251', 'L', 'l251', '${OWNER}')`);
    expect(await rows('00000000-0000-0000-0000-00000000c251')).toEqual({ wallet: 0, audit: 0 });
    await db.query(`UPDATE public.billing_v2_policy SET new_workspace_default_state = 'shadow' WHERE id`);
    await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ('00000000-0000-0000-0000-00000000d251', 'S', 's251', '${OWNER}')`);
    expect(await rows('00000000-0000-0000-0000-00000000d251')).toEqual({ wallet: 1, audit: 1 });
    await db.query(`UPDATE public.billing_v2_policy SET new_workspace_default_state = 'legacy' WHERE id`);
  });

  it('running 251 again changes nothing', async () => {
    const before = await fingerprint();
    await applyMigrationSql(db, readFileSync(resolve(DIR, '251_production_parity.sql'), 'utf8'));
    expect(await fingerprint()).toBe(before);
  }, 120_000);
});
