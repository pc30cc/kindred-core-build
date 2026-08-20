/**
 * 031 — atomic self-service password change + other-session revocation.
 *
 * POST /api/account/change-password used to update user_credentials and
 * stop — a session stolen before the change stayed valid indefinitely
 * after the owner "secured" their account. This proves
 * change_password_and_revoke_sessions (server-role-only SQL function)
 * against a real PostgreSQL instance: the password write and the
 * other-session revocation happen together, the caller's own current
 * session survives, other users are untouched, and a failure (nonexistent
 * user) revokes nothing.
 *
 * Driven by TEST_DATABASE_URL (or the legacy CLEAN_INSTALL_DATABASE_URL) —
 * skipped entirely when no live Postgres is configured.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { PgQueryable } from './pgMigrationChain';
import { ensureAuthChainInstalled } from './authStubSchema';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type PgTestClient = PgQueryable & { connect(): Promise<void>; end(): Promise<void> };

let db: PgTestClient;

suite('031 — change_password_and_revoke_sessions (real PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    db = new Client({ connectionString: DSN }) as unknown as PgTestClient;
    await db.connect();
    await ensureAuthChainInstalled(db);
  }, 60_000);

  afterAll(async () => { if (db) await db.end(); });

  afterEach(async () => {
    await db.query(`
      DELETE FROM public.auth_sessions;
      DELETE FROM public.user_credentials;
      DELETE FROM public.profiles;
      DELETE FROM auth.users;
    `);
  });

  async function makeUser(email: string): Promise<string> {
    const { rows } = await db.query(`INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [email]);
    const userId = rows[0].id as string;
    await db.query(`INSERT INTO public.user_credentials (user_id, password_hash) VALUES ($1, 'OLD_HASH')`, [userId]);
    return userId;
  }

  it('is locked to service_role only', async () => {
    const { rows } = await db.query(`
      SELECT
        has_function_privilege('anon', 'public.change_password_and_revoke_sessions(uuid,text,uuid)', 'EXECUTE') AS anon_can,
        has_function_privilege('authenticated', 'public.change_password_and_revoke_sessions(uuid,text,uuid)', 'EXECUTE') AS auth_can,
        has_function_privilege('service_role', 'public.change_password_and_revoke_sessions(uuid,text,uuid)', 'EXECUTE') AS svc_can
    `);
    expect(rows[0]).toMatchObject({ anon_can: false, auth_can: false, svc_can: true });
  });

  it('updates the password and revokes every OTHER session, keeping the caller\'s current session valid', async () => {
    const userId = await makeUser('changepw@example.com');
    const current = (await db.query(
      `INSERT INTO public.auth_sessions (user_id, email, token_hash, expires_at) VALUES ($1, $2, 'current-tok', now() + interval '1 day') RETURNING id`,
      [userId, 'changepw@example.com'],
    )).rows[0].id;
    const other = (await db.query(
      `INSERT INTO public.auth_sessions (user_id, email, token_hash, expires_at) VALUES ($1, $2, 'other-tok', now() + interval '1 day') RETURNING id`,
      [userId, 'changepw@example.com'],
    )).rows[0].id;

    const result = await db.query(
      `SELECT public.change_password_and_revoke_sessions($1, $2, $3) AS revoked`,
      [userId, 'NEW_HASH', current],
    );
    expect(result.rows[0].revoked).toBe(1);

    const cred = await db.query(`SELECT password_hash FROM public.user_credentials WHERE user_id = $1`, [userId]);
    expect(cred.rows[0].password_hash).toBe('NEW_HASH');

    const sessions = await db.query(`SELECT id, revoked_at, revoke_reason FROM public.auth_sessions WHERE user_id = $1`, [userId]);
    const currentRow = sessions.rows.find((r: any) => r.id === current);
    const otherRow = sessions.rows.find((r: any) => r.id === other);
    expect(currentRow.revoked_at).toBeNull();
    expect(otherRow.revoked_at).not.toBeNull();
    expect(otherRow.revoke_reason).toBe('password_changed');
  });

  it('a second, simultaneous session that was valid before the change is rejected (revoked) after it', async () => {
    const userId = await makeUser('changepw-2@example.com');
    const current = (await db.query(
      `INSERT INTO public.auth_sessions (user_id, email, token_hash, expires_at) VALUES ($1, $2, 'cur', now() + interval '1 day') RETURNING id`,
      [userId, 'changepw-2@example.com'],
    )).rows[0].id;
    await db.query(
      `INSERT INTO public.auth_sessions (user_id, email, token_hash, expires_at) VALUES ($1, $2, 'secondary', now() + interval '1 day')`,
      [userId, 'changepw-2@example.com'],
    );

    // Before the change: the secondary session is a valid, unrevoked row.
    const before = await db.query(`SELECT revoked_at FROM public.auth_sessions WHERE token_hash = 'secondary'`);
    expect(before.rows[0].revoked_at).toBeNull();

    await db.query(`SELECT public.change_password_and_revoke_sessions($1, $2, $3)`, [userId, 'NEW', current]);

    const after = await db.query(`SELECT revoked_at, revoke_reason FROM public.auth_sessions WHERE token_hash = 'secondary'`);
    expect(after.rows[0].revoked_at).not.toBeNull();
    expect(after.rows[0].revoke_reason).toBe('password_changed');
  });

  it('another user\'s sessions are completely untouched', async () => {
    const userA = await makeUser('a@example.com');
    const userB = await makeUser('b@example.com');
    await db.query(`INSERT INTO public.auth_sessions (user_id, email, token_hash, expires_at) VALUES ($1, $2, 'b-sess', now() + interval '1 day')`, [userB, 'b@example.com']);

    await db.query(`SELECT public.change_password_and_revoke_sessions($1, 'NEW', NULL)`, [userA]);

    const bSession = await db.query(`SELECT revoked_at FROM public.auth_sessions WHERE user_id = $1`, [userB]);
    expect(bSession.rows[0].revoked_at).toBeNull();
    const bCred = await db.query(`SELECT password_hash FROM public.user_credentials WHERE user_id = $1`, [userB]);
    expect(bCred.rows[0].password_hash).toBe('OLD_HASH');
  });

  it('a failed update (no user_credentials row for that id) revokes nothing and raises instead of silently no-opping', async () => {
    const ghostId = '00000000-0000-0000-0000-000000000000';
    await expect(
      db.query(`SELECT public.change_password_and_revoke_sessions($1, 'X', NULL)`, [ghostId]),
    ).rejects.toThrow(/no user_credentials row/);
  });

  it('with no _except_session_id, ALL sessions for the user are revoked', async () => {
    const userId = await makeUser('logout-all-on-change@example.com');
    await db.query(
      `INSERT INTO public.auth_sessions (user_id, email, token_hash, expires_at) VALUES ($1, $2, 's1', now() + interval '1 day'), ($1, $2, 's2', now() + interval '1 day')`,
      [userId, 'logout-all-on-change@example.com'],
    );
    const result = await db.query(`SELECT public.change_password_and_revoke_sessions($1, 'NEW', NULL) AS n`, [userId]);
    expect(result.rows[0].n).toBe(2);
  });
});
