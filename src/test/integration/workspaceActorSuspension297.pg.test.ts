// @vitest-environment node
/**
 * 297 — a suspended or seat-locked member no longer manages invitations.
 * Against real PostgreSQL built by the chain up to 296:
 *
 *   - before 297, a suspended admin creates an invitation (the defect);
 *   - wi_active_actor_role() answers the role of an active member only: NULL
 *     for a suspended one, for one past the plan's seat limit while the
 *     edition's lock switch is on, and for a stranger; the owner never locks;
 *   - after 297, create, edit, resend, rotate, revoke, archive, delete and
 *     offboarding a member refuse a suspended or seat-locked admin
 *     (FORBIDDEN_ROLE_ESCALATION, FORBIDDEN for the delete), and still serve
 *     an active admin;
 *   - a dry run (BEGIN … ROLLBACK) leaves the functions as they were, a second
 *     run changes nothing, and only service_role reaches them.
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
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the 297 tests are mandatory.');
}
const suite = DSN ? describe : describe.skip;

const DB = `actor_suspension_297_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '297_workspace_actor_suspension.sql';
const SQL = () => readFileSync(resolve(DIR, FILE), 'utf8');

const FUNCTIONS = [
  'public.create_workspace_invitation_v2(uuid,uuid,text,text,text,text,text,public.workspace_role,timestamptz,uuid[],text,text,timestamptz,text,text,text,text,text,text)',
  'public.edit_workspace_invitation_v2(uuid,uuid,text,text,text,text,text,public.workspace_role,timestamptz,uuid[],text,text,text,text,text,text)',
  'public.resend_invitation_email_v2(uuid,uuid,text,text)',
  'public.rotate_manual_link_v2(uuid,uuid,text,text,timestamptz)',
  'public.revoke_invitation_v2(uuid,uuid,text)',
  'public.archive_invitation_v2(uuid,uuid)',
  'public.wi_delete_invitation(uuid,uuid)',
  'public.offboard_workspace_member(uuid,uuid,uuid,text)',
];

type Row = Record<string, unknown>;

let admin: pg.Client;
let db: pg.Client;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
const definitions = async () =>
  q(`SELECT p.oid::regprocedure::text AS fn, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl, p.prosecdef
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('create_workspace_invitation_v2', 'edit_workspace_invitation_v2',
        'resend_invitation_email_v2', 'rotate_manual_link_v2', 'revoke_invitation_v2', 'archive_invitation_v2',
        'wi_delete_invitation', 'offboard_workspace_member', 'wi_active_actor_role')
      ORDER BY 1`);

let ws = '';
let owner = '';
let activeAdmin = '';
let suspendedAdmin = '';
let lockedAdmin = '';
let plan = '';

async function profile(name: string): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `${name}-${id.slice(0, 6)}@test.local`, name]);
  return id;
}

async function addMember(user: string, role: string, daysAgo: number, suspended = false) {
  await q(
    `INSERT INTO public.workspace_members (workspace_id, user_id, role, created_at, suspended_at)
     VALUES ($1, $2, $3::public.workspace_role, now() - make_interval(days => $4::int), $5)`,
    [ws, user, role, daysAgo, suspended ? new Date().toISOString() : null],
  );
}

const setLocks = (on: boolean) =>
  q(`INSERT INTO public.billing_settings (edition, locks_enabled) VALUES (public.platform_edition(), $1)
     ON CONFLICT (edition) DO UPDATE SET locks_enabled = EXCLUDED.locks_enabled`, [on]);

/** Creates an invitation as `actor`; the error message on refusal, else the new id. */
async function create(actor: string): Promise<{ id?: string; error?: string }> {
  const email = `invitee-${randomUUID().slice(0, 8)}@test.local`;
  const k = randomUUID();
  try {
    await db.query('SAVEPOINT c');
    const r = await one(
      `SELECT public.create_workspace_invitation_v2(
         $1, $2, 'New', 'Person', $3, NULL, 'staff', 'viewer', now() + interval '7 days', ARRAY[]::uuid[],
         $4, 'pfx', now() + interval '7 days', $5, $6, 'dh', 'sh') AS r`,
      [ws, actor, email, `hash-${k}`, `email-${k}`, `sms-${k}`],
    );
    await db.query('RELEASE SAVEPOINT c');
    const res = r.r as Row;
    return { id: String(res.invitation_id ?? res.id) };
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT c');
    return { error: (err as Error).message };
  }
}

async function attempt(sql: string, params: unknown[]): Promise<string | null> {
  try {
    await db.query('SAVEPOINT a');
    await db.query(sql, params);
    await db.query('RELEASE SAVEPOINT a');
    return null;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT a');
    return (err as Error).message;
  }
}

const seatMode = (mode: 'self_host_unlimited' | 'plan_authoritative') =>
  q(`UPDATE public.workspace_seat_entitlement_mode SET mode = $1 WHERE id`, [mode]);

type Targets = { edit: string; resend: string; rotate: string; revoke: string; archive: string; delete: string };

/** One invitation per primitive, made by the active admin (pending; revoked for archive). */
async function targets(): Promise<Targets> {
  const pending = async () => (await create(activeAdmin)).id!;
  const t = {
    edit: await pending(), resend: await pending(), rotate: await pending(),
    revoke: await pending(), archive: await pending(), delete: await pending(),
  };
  await q(`SELECT public.revoke_invitation_v2($1, $2, 'setup')`, [t.archive, activeAdmin]);
  return t;
}

/** Every management primitive but create, as `actor`. */
async function everyOperation(actor: string, t: Targets): Promise<Record<string, string | null>> {
  const k = () => randomUUID();
  return {
    edit: await attempt(
      `SELECT public.edit_workspace_invitation_v2($1, $2, 'E', 'D', $3, NULL, 'staff', 'viewer', now() + interval '7 days', ARRAY[]::uuid[], $4, $5, 'dh', 'sh')`,
      [t.edit, actor, `edited-${k().slice(0, 8)}@test.local`, `e-${k()}`, `s-${k()}`],
    ),
    resend: await attempt(`SELECT public.resend_invitation_email_v2($1, $2, $3, 'dh')`, [t.resend, actor, `r-${k()}`]),
    rotate: await attempt(`SELECT public.rotate_manual_link_v2($1, $2, $3, 'pfx', now() + interval '1 day')`, [t.rotate, actor, `t-${k()}`]),
    revoke: await attempt(`SELECT public.revoke_invitation_v2($1, $2, 'reason')`, [t.revoke, actor]),
    archive: await attempt(`SELECT public.archive_invitation_v2($1, $2)`, [t.archive, actor]),
    delete: await attempt(`SELECT public.wi_delete_invitation($1, $2)`, [t.delete, actor]),
  };
}

const REFUSED = {
  edit: 'FORBIDDEN_ROLE_ESCALATION',
  resend: 'FORBIDDEN_ROLE_ESCALATION',
  rotate: 'FORBIDDEN_ROLE_ESCALATION',
  revoke: 'FORBIDDEN_ROLE_ESCALATION',
  archive: 'FORBIDDEN_ROLE_ESCALATION',
  delete: 'FORBIDDEN',
};
const SERVED = { edit: null, resend: null, rotate: null, revoke: null, archive: null, delete: null };

suite('297 — invitations refuse a suspended or seat-locked actor (real PostgreSQL, whole chain)', () => {
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
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql') && f < FILE).sort()) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
    await q(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    await q(`SELECT public.set_workspace_seat_entitlement_mode(_mode := 'self_host_unlimited', _source := 'test_bootstrap')`);

    // Two seats: the owner's and one more. The active admin joined first
    // and holds it; the locked admin joined after and is past the limit.
    plan = String((await one(
      `INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free)
       VALUES ('t297', 't297', '{}', '{"max_agents": 2}', true, false) RETURNING id`)).id);
    owner = await profile('owner');
    ws = randomUUID();
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', now() - interval '1 year')
             ON CONFLICT (workspace_id, user_id) DO NOTHING`, [ws, owner]);
    activeAdmin = await profile('admin');
    suspendedAdmin = await profile('mallory');
    lockedAdmin = await profile('late');
    await addMember(activeAdmin, 'admin', 30);
    await addMember(suspendedAdmin, 'admin', 20, true);
    await addMember(lockedAdmin, 'admin', 10);
    await q(`INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status, current_period_start, current_period_end)
             VALUES ($1, $2, 'active', now() - interval '1 day', now() + interval '29 days')
             ON CONFLICT (workspace_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active'`, [ws, plan]);
    await setLocks(true);
    await db.query('BEGIN');
  }, 600_000);

  afterAll(async () => {
    await db?.query('ROLLBACK').catch(() => undefined);
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('before 297: a suspended admin still creates and revokes invitations, and offboards (the defect)', async () => {
    const made = await create(suspendedAdmin);
    expect(made.error).toBeUndefined();
    expect(made.id).toBeTruthy();
    const t = await targets();
    expect(await attempt(`SELECT public.revoke_invitation_v2($1, $2, 'mine now')`, [t.revoke, suspendedAdmin])).toBeNull();
    const victim = await profile('victim');
    await addMember(victim, 'viewer', 6);
    expect(await attempt(`SELECT public.offboard_workspace_member($1, $2, $3, 'gone')`, [ws, victim, suspendedAdmin])).toBeNull();
  });

  it('a dry run (BEGIN … ROLLBACK) leaves nothing behind', async () => {
    await db.query('COMMIT');
    const before = await definitions();
    await db.query('BEGIN');
    try {
      await db.query(SQL());
      expect((await definitions()).length).toBe(before.length + 1);
    } finally {
      await db.query('ROLLBACK');
    }
    expect(await definitions()).toEqual(before);
    await db.query('BEGIN');
  });

  it('applies, keeps every function SECURITY DEFINER and service_role-only, and a second run changes nothing', async () => {
    await db.query('COMMIT');
    await applyMigrationSql(db, SQL());
    const first = await definitions();
    await applyMigrationSql(db, SQL());
    expect(await definitions()).toEqual(first);
    expect(first).toHaveLength(FUNCTIONS.length + 1);
    for (const f of first) {
      expect(f.prosecdef, String(f.fn)).toBe(true);
      expect(String(f.def), String(f.fn)).toMatch(/SET search_path TO 'public', 'pg_temp'/);
      expect(String(f.acl), String(f.fn)).toContain('service_role=X');
      expect(String(f.acl), String(f.fn)).not.toMatch(/(^|[{,])=X|anon=X|authenticated=X/);
    }
    for (const fn of FUNCTIONS) {
      const def = String((await one(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [fn])).d);
      expect(def, fn).toContain('wi_active_actor_role(_workspace_id, _actor_id)');
    }
    await db.query('BEGIN');
  });

  it('wi_active_actor_role: the role of an active member only', async () => {
    const role = async (user: string) => (await one(`SELECT public.wi_active_actor_role($1, $2)::text AS r`, [ws, user])).r;
    // An unlimited install locks nobody.
    expect(await role(lockedAdmin)).toBe('admin');
    await seatMode('plan_authoritative');
    try {
      expect((await one(`SELECT public.billing_is_locked($1, 'member', $2) AS r`, [ws, lockedAdmin])).r).toBe(true);
      expect(await role(owner)).toBe('owner');
      expect(await role(activeAdmin)).toBe('admin');
      expect(await role(suspendedAdmin)).toBeNull();
      expect(await role(lockedAdmin)).toBeNull();
      expect(await role(randomUUID())).toBeNull();
      // The edition's switch off: nobody is past the limit, a suspension still counts.
      await setLocks(false);
      expect(await role(lockedAdmin)).toBe('admin');
      expect(await role(suspendedAdmin)).toBeNull();
    } finally {
      await setLocks(true);
      await seatMode('self_host_unlimited');
    }
  });

  it('a suspended admin is refused every management primitive', async () => {
    expect((await create(suspendedAdmin)).error).toBe('FORBIDDEN_ROLE_ESCALATION');
    expect(await everyOperation(suspendedAdmin, await targets())).toEqual(REFUSED);
  });

  it('a seat-locked admin is refused too', async () => {
    const t = await targets();
    await seatMode('plan_authoritative');
    try {
      expect(await everyOperation(lockedAdmin, t)).toEqual(REFUSED);
    } finally {
      await seatMode('self_host_unlimited');
    }
  });

  it('offboarding: a suspended admin cannot remove a member, an active one can', async () => {
    const viewer = await profile('viewer');
    await addMember(viewer, 'viewer', 5);
    const off = (actor: string) => attempt(`SELECT public.offboard_workspace_member($1, $2, $3, 'test')`, [ws, viewer, actor]);
    expect(await off(suspendedAdmin)).toBe('FORBIDDEN_ROLE_ESCALATION');
    expect((await one(`SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [ws, viewer])).n).toBe(1);
    expect(await off(activeAdmin)).toBeNull();
    expect((await one(`SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [ws, viewer])).n).toBe(0);
  });

  it('an active admin and the owner still manage invitations', async () => {
    expect((await create(activeAdmin)).error).toBeUndefined();
    expect((await create(owner)).error).toBeUndefined();
    expect(await everyOperation(activeAdmin, await targets())).toEqual(SERVED);
    expect(await everyOperation(owner, await targets())).toEqual(SERVED);
  });
});
