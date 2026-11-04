// @vitest-environment node
/**
 * 296 — admin_delete_user keeps the rows the user shares with everyone else,
 * on real PostgreSQL built by the whole migration chain.
 *
 * Before 296 it ran `DELETE … WHERE <user column> = <user>` on every public
 * table, in every tenant: an operator's conversations (with their messages)
 * and notes in someone else's workspace went with them, and so did every
 * platform singleton a former Super Admin last saved.
 *
 *   - a member's conversations, messages and notes in another owner's
 *     workspace survive, the assignee cleared, the note's author kept;
 *   - the smart rule they last edited and the member they invited keep their
 *     rows, the reference cleared;
 *   - platform singletons they saved survive (widget_platform_settings,
 *     billing_settings), updated_by cleared;
 *   - their own rows are gone: profile, roles, credentials, sessions, push
 *     devices, prefs, their membership (and its details), their own
 *     workspace;
 *   - append-only payments keep their created_by;
 *   - their deletion job survives for the worker to mark completed;
 *   - the guards and the service_role-only grant are unchanged.
 *
 * Its own database (CREATE DATABASE on the TEST_DATABASE_URL server).
 * Skipped without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Row = Record<string, unknown>;

suite('296 — admin_delete_user keeps shared rows', () => {
  let chain: FullChainDatabase;
  const q = async (sql: string, p: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, p)).rows as Row[];
  const one = async (sql: string, p: unknown[] = []): Promise<Row> => (await q(sql, p))[0];
  const count = async (sql: string, p: unknown[] = []): Promise<number> => Number((await one(sql, p)).n);

  async function makeUser(admin = false): Promise<string> {
    const id = randomUUID();
    await q(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [id, `u-${id.slice(0, 8)}@test.local`]);
    if (admin) await q(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
    return id;
  }
  async function makeWorkspace(owner: string): Promise<string> {
    const id = randomUUID();
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
    return id;
  }
  async function asService<T>(fn: () => Promise<T>): Promise<T> {
    await q('BEGIN');
    try {
      await q('SET LOCAL ROLE service_role');
      const r = await fn();
      await q('COMMIT');
      return r;
    } catch (err) {
      await q('ROLLBACK');
      throw err;
    }
  }

  let actor = '';
  let otherAdmin = '';

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `admindeleteuser296_${Date.now()}`);
    actor = await makeUser(true);
    otherAdmin = await makeUser(true);
  }, 600_000);

  afterAll(async () => { await chain?.drop(); });

  it('an operator of someone else\'s workspace: shared rows stay, their own rows go', async () => {
    const owner = await makeUser();
    const shared = await makeWorkspace(owner);
    const operator = await makeUser();
    const invitee = await makeUser();
    const own = await makeWorkspace(operator);

    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent')`, [shared, operator, invitee]);
    await q(
      `INSERT INTO public.workspace_member_details (workspace_id, user_id, first_name, last_name, work_email_normalized, member_type, invited_by)
       VALUES ($1, $2, 'Op', 'Er', $4, 'customer_facing', NULL), ($1, $3, 'In', 'Vitee', $5, 'customer_facing', $2)`,
      [shared, operator, invitee, `op-${operator}@test.local`, `in-${invitee}@test.local`]);

    const open = String((await one(
      `INSERT INTO public.conversations (workspace_id, assigned_to, status) VALUES ($1, $2, 'open') RETURNING id`, [shared, operator])).id);
    const closed = String((await one(
      `INSERT INTO public.conversations (workspace_id, assigned_to, status) VALUES ($1, $2, 'resolved') RETURNING id`, [shared, operator])).id);
    await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body) VALUES ($1, 'agent', 'hello'), ($2, 'agent', 'bye')`, [open, closed]);
    const note = String((await one(
      `INSERT INTO public.conversation_notes (workspace_id, conversation_id, author_id, body) VALUES ($1, $2, $3, 'note') RETURNING id`,
      [shared, closed, operator])).id);
    const rule = String((await one(
      `INSERT INTO public.widget_smart_rules (workspace_id, name, created_by, updated_by) VALUES ($1, 'r', $2, $2) RETURNING id`,
      [shared, operator])).id);
    const pay = String((await one(
      `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, purpose, status, created_by)
       VALUES ($1, 'paddle_sandbox', 'USD', 100, 100, 'topup', 'expired', $2) RETURNING id`, [shared, operator])).id);

    // Their own rows.
    await q(`INSERT INTO public.user_credentials (user_id) VALUES ($1)`, [operator]);
    await q(`INSERT INTO public.auth_sessions (token_hash, user_id, email, expires_at) VALUES ($1, $2, 'x@test.local', now() + interval '1 day')`,
      [`h-${operator}`, operator]);
    await q(`INSERT INTO public.mobile_push_devices (user_id, platform, device_id, workspace_id, push_token) VALUES ($1, 'ios', $2, $3, 'tok')`,
      [operator, `dev-${operator}`, shared]);
    const job = String((await one(
      `INSERT INTO public.user_deletion_jobs (user_id, requested_by) VALUES ($1, $2) RETURNING id`, [operator, actor])).id);

    const r = (await asService(() => one(`SELECT public.admin_delete_user($1, $2) AS r`, [actor, operator]))).r as Row;
    expect(r).toMatchObject({ deleted_user_id: operator, workspaces_deleted: 1 });

    // Shared rows survive, the reference cleared.
    expect(await q(`SELECT id, assigned_to, status FROM public.conversations WHERE workspace_id = $1 ORDER BY id`, [shared]))
      .toEqual([{ id: open, assigned_to: null, status: 'open' }, { id: closed, assigned_to: null, status: 'resolved' }].sort((a, b) => a.id.localeCompare(b.id)));
    expect(await count(`SELECT count(*) AS n FROM public.conversation_messages WHERE conversation_id = ANY ($1::uuid[])`, [[open, closed]])).toBe(2);
    // NOT NULL without a foreign key: kept as it was.
    expect(await one(`SELECT author_id, body FROM public.conversation_notes WHERE id = $1`, [note])).toEqual({ author_id: operator, body: 'note' });
    expect(await one(`SELECT created_by, updated_by FROM public.widget_smart_rules WHERE id = $1`, [rule])).toEqual({ created_by: null, updated_by: null });
    expect(await one(`SELECT invited_by FROM public.workspace_member_details WHERE workspace_id = $1 AND user_id = $2`, [shared, invitee]))
      .toEqual({ invited_by: null });
    expect(await count(`SELECT count(*) AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [shared, invitee])).toBe(1);
    // Append-only record keeps the actor.
    expect((await one(`SELECT created_by FROM public.billing_account_payments WHERE id = $1`, [pay])).created_by).toBe(operator);
    // The workspace someone else owns is untouched.
    expect(await count(`SELECT count(*) AS n FROM public.workspaces WHERE id = $1`, [shared])).toBe(1);

    // Their own rows are gone.
    expect(await count(`SELECT count(*) AS n FROM public.profiles WHERE id = $1`, [operator])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM public.workspaces WHERE id = $1`, [own])).toBe(0);
    for (const t of ['user_credentials', 'auth_sessions', 'mobile_push_devices', 'user_roles']) {
      expect(await count(`SELECT count(*) AS n FROM public.${t} WHERE user_id = $1`, [operator]), t).toBe(0);
    }
    expect(await count(`SELECT count(*) AS n FROM public.workspace_members WHERE user_id = $1`, [operator])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM public.workspace_member_details WHERE user_id = $1`, [operator])).toBe(0);
    // The deletion job stays for the worker to mark completed.
    expect(await count(`SELECT count(*) AS n FROM public.user_deletion_jobs WHERE id = $1`, [job])).toBe(1);
  });

  it('a former Super Admin: the platform singletons they saved survive', async () => {
    const former = await makeUser(true);
    await q(`UPDATE public.widget_platform_settings SET updated_by = $1`, [former]);
    const widgetBefore = await count(`SELECT count(*) AS n FROM public.widget_platform_settings`);
    expect(widgetBefore).toBeGreaterThan(0);
    await q(`INSERT INTO public.billing_settings (edition, updated_by) VALUES ('iran', $1)
             ON CONFLICT (edition) DO UPDATE SET updated_by = EXCLUDED.updated_by`, [former]);

    await asService(() => q(`SELECT public.admin_delete_user($1, $2)`, [actor, former]));

    expect(await count(`SELECT count(*) AS n FROM public.widget_platform_settings`)).toBe(widgetBefore);
    expect(await count(`SELECT count(*) AS n FROM public.widget_platform_settings WHERE updated_by IS NOT NULL`)).toBe(0);
    expect(await one(`SELECT updated_by FROM public.billing_settings WHERE edition = 'iran'`)).toEqual({ updated_by: null });
    expect(await count(`SELECT count(*) AS n FROM public.user_roles WHERE user_id = $1`, [former])).toBe(0);
    // The other admins are still there.
    expect(await count(`SELECT count(*) AS n FROM public.user_roles WHERE user_id = ANY ($1::uuid[]) AND role = 'admin'`, [[actor, otherAdmin]])).toBe(2);
  });

  it('keeps the guards', async () => {
    const target = await makeUser();
    const nobody = await makeUser();
    await expect(asService(() => q(`SELECT public.admin_delete_user($1, $2)`, [nobody, target]))).rejects.toThrow(/Not authorized/);
    await expect(asService(() => q(`SELECT public.admin_delete_user($1, $1)`, [actor]))).rejects.toThrow(/your own account/);
    await expect(asService(() => q(`SELECT public.admin_delete_user($1, $2)`, [actor, randomUUID()]))).rejects.toThrow(/User not found/);
    expect(await count(`SELECT count(*) AS n FROM public.profiles WHERE id = $1`, [target])).toBe(1);
  });

  it('is service_role only, and running 296 again changes nothing', async () => {
    const sig = 'public.admin_delete_user(uuid, uuid)';
    const acl = await one(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') AS auth,
              has_function_privilege('service_role', $1, 'EXECUTE') AS service,
              (SELECT prosecdef FROM pg_proc WHERE oid = $1::regprocedure) AS definer,
              (SELECT proconfig FROM pg_proc WHERE oid = $1::regprocedure) AS config`, [sig]);
    expect(acl).toEqual({ anon: false, auth: false, service: true, definer: true, config: ['search_path=public'] });
    const before = (await one(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [sig])).d;
    await applyMigrationSql(chain.db, readFileSync('database/migrations/296_admin_delete_user_keeps_shared_rows.sql', 'utf8'));
    expect((await one(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [sig])).d).toBe(before);
  });
});
