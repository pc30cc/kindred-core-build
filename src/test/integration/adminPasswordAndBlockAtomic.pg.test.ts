/**
 * 033/034 — atomic admin password reset and admin block/unblock, each
 * combined with full session revocation in one service_role-only call.
 *
 * POST /api/admin/change-password and POST /api/admin/block-user used to
 * upsert user_credentials THEN separately call revokeAllSessions() — if
 * the second call failed after the first succeeded, the account would
 * show as "password changed"/"disabled" while an old session kept
 * working. This proves both RPCs against a real PostgreSQL instance,
 * including a genuine forced-failure rollback test (a trigger that raises
 * on the auth_sessions UPDATE) proving the whole call — not just the
 * session sweep — rolls back together.
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

suite('033/034 — admin_set_password_and_revoke_sessions / admin_set_user_block_status (real PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    db = new Client({ connectionString: DSN }) as unknown as PgTestClient;
    await db.connect();
    await ensureAuthChainInstalled(db);
  }, 60_000);

  afterAll(async () => { if (db) await db.end(); });

  afterEach(async () => {
    await db.query(`DROP TRIGGER IF EXISTS force_auth_sessions_failure ON public.auth_sessions;`);
    await db.query(`DROP FUNCTION IF EXISTS public.__raise_forced_failure() CASCADE;`);
    await db.query(`
      DELETE FROM public.auth_sessions;
      DELETE FROM public.user_credentials;
      DELETE FROM public.profiles;
      DELETE FROM auth.users;
    `);
  });

  async function makeUser(email: string, withCred = true): Promise<string> {
    const { rows } = await db.query(`INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [email]);
    const userId = rows[0].id as string;
    if (withCred) {
      await db.query(`INSERT INTO public.user_credentials (user_id, password_hash) VALUES ($1, 'OLD_HASH')`, [userId]);
    }
    return userId;
  }

  async function makeSession(userId: string, email: string, tokenHash: string): Promise<string> {
    const { rows } = await db.query(
      `INSERT INTO public.auth_sessions (user_id, email, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 day') RETURNING id`,
      [userId, email, tokenHash],
    );
    return rows[0].id as string;
  }

  describe('admin_set_password_and_revoke_sessions', () => {
    it('is locked to service_role only', async () => {
      const { rows } = await db.query(`
        SELECT
          has_function_privilege('anon', 'public.admin_set_password_and_revoke_sessions(uuid,text)', 'EXECUTE') AS anon_can,
          has_function_privilege('authenticated', 'public.admin_set_password_and_revoke_sessions(uuid,text)', 'EXECUTE') AS auth_can,
          has_function_privilege('service_role', 'public.admin_set_password_and_revoke_sessions(uuid,text)', 'EXECUTE') AS svc_can
      `);
      expect(rows[0]).toMatchObject({ anon_can: false, auth_can: false, svc_can: true });
    });

    it('updates the password AND revokes every active session for an existing user, in one call', async () => {
      const userId = await makeUser('admin-pw@example.com');
      await makeSession(userId, 'admin-pw@example.com', 'tok-1');
      await makeSession(userId, 'admin-pw@example.com', 'tok-2');

      const result = await db.query(`SELECT public.admin_set_password_and_revoke_sessions($1, 'NEW_HASH') AS revoked`, [userId]);
      expect(result.rows[0].revoked).toBe(2);

      const cred = await db.query(`SELECT password_hash, failed_login_count FROM public.user_credentials WHERE user_id = $1`, [userId]);
      expect(cred.rows[0].password_hash).toBe('NEW_HASH');
      expect(cred.rows[0].failed_login_count).toBe(0);

      const sessions = await db.query(`SELECT revoked_at, revoke_reason FROM public.auth_sessions WHERE user_id = $1`, [userId]);
      for (const s of sessions.rows) {
        expect(s.revoked_at).not.toBeNull();
        expect(s.revoke_reason).toBe('admin_action');
      }
    });

    it('works for a MIGRATED user with no user_credentials row yet', async () => {
      const userId = await makeUser('migrated-admin-pw@example.com', /* withCred */ false);
      const before = await db.query(`SELECT 1 FROM public.user_credentials WHERE user_id = $1`, [userId]);
      expect(before.rowCount).toBe(0);

      await db.query(`SELECT public.admin_set_password_and_revoke_sessions($1, 'FIRST_HASH')`, [userId]);

      const cred = await db.query(`SELECT password_hash FROM public.user_credentials WHERE user_id = $1`, [userId]);
      expect(cred.rows[0].password_hash).toBe('FIRST_HASH');
    });

    it("another user's sessions are completely untouched", async () => {
      const userA = await makeUser('admin-pw-a@example.com');
      const userB = await makeUser('admin-pw-b@example.com');
      await makeSession(userB, 'admin-pw-b@example.com', 'b-tok');

      await db.query(`SELECT public.admin_set_password_and_revoke_sessions($1, 'NEW')`, [userA]);

      const bSession = await db.query(`SELECT revoked_at FROM public.auth_sessions WHERE user_id = $1`, [userB]);
      expect(bSession.rows[0].revoked_at).toBeNull();
    });

    it('a forced failure on the session-revocation step rolls back BOTH the password write and the revocation', async () => {
      const userId = await makeUser('admin-pw-rollback@example.com');
      const sessionId = await makeSession(userId, 'admin-pw-rollback@example.com', 'rollback-tok');

      // A real Postgres-level forced failure: a trigger that raises when
      // auth_sessions is updated. Proves rollback via genuine transactional
      // behavior, not a mock.
      await db.query(`
        CREATE OR REPLACE FUNCTION public.__raise_forced_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'forced test failure';
        END;
        $$;
        CREATE TRIGGER force_auth_sessions_failure
          BEFORE UPDATE ON public.auth_sessions
          FOR EACH ROW EXECUTE FUNCTION public.__raise_forced_failure();
      `);

      await expect(
        db.query(`SELECT public.admin_set_password_and_revoke_sessions($1, 'SHOULD_NOT_STICK')`, [userId]),
      ).rejects.toThrow(/forced test failure/);

      const cred = await db.query(`SELECT password_hash FROM public.user_credentials WHERE user_id = $1`, [userId]);
      expect(cred.rows[0].password_hash).toBe('OLD_HASH');

      const session = await db.query(`SELECT revoked_at FROM public.auth_sessions WHERE id = $1`, [sessionId]);
      expect(session.rows[0].revoked_at).toBeNull();
    });
  });

  describe('admin_set_user_block_status', () => {
    it('is locked to service_role only', async () => {
      const { rows } = await db.query(`
        SELECT
          has_function_privilege('anon', 'public.admin_set_user_block_status(uuid,boolean)', 'EXECUTE') AS anon_can,
          has_function_privilege('authenticated', 'public.admin_set_user_block_status(uuid,boolean)', 'EXECUTE') AS auth_can,
          has_function_privilege('service_role', 'public.admin_set_user_block_status(uuid,boolean)', 'EXECUTE') AS svc_can
      `);
      expect(rows[0]).toMatchObject({ anon_can: false, auth_can: false, svc_can: true });
    });

    it('blocking disables the account AND revokes every active session', async () => {
      const userId = await makeUser('admin-block@example.com');
      const s1 = await makeSession(userId, 'admin-block@example.com', 'block-tok-1');
      const s2 = await makeSession(userId, 'admin-block@example.com', 'block-tok-2');

      const result = await db.query(`SELECT public.admin_set_user_block_status($1, true) AS revoked`, [userId]);
      expect(result.rows[0].revoked).toBe(2);

      const cred = await db.query(`SELECT status FROM public.user_credentials WHERE user_id = $1`, [userId]);
      expect(cred.rows[0].status).toBe('disabled');

      const sessions = await db.query(`SELECT id, revoked_at, revoke_reason FROM public.auth_sessions WHERE user_id = $1`, [userId]);
      for (const s of sessions.rows) {
        expect([s1, s2]).toContain(s.id);
        expect(s.revoked_at).not.toBeNull();
        expect(s.revoke_reason).toBe('admin_action');
      }
    });

    it('unblocking flips status back to active WITHOUT touching sessions', async () => {
      const userId = await makeUser('admin-unblock@example.com');
      await db.query(`SELECT public.admin_set_user_block_status($1, true)`, [userId]);
      await makeSession(userId, 'admin-unblock@example.com', 'post-block-tok'); // a fresh session created after unblocking below

      const result = await db.query(`SELECT public.admin_set_user_block_status($1, false) AS revoked`, [userId]);
      expect(result.rows[0].revoked).toBe(0);

      const cred = await db.query(`SELECT status FROM public.user_credentials WHERE user_id = $1`, [userId]);
      expect(cred.rows[0].status).toBe('active');

      const session = await db.query(`SELECT revoked_at FROM public.auth_sessions WHERE token_hash = 'post-block-tok'`);
      expect(session.rows[0].revoked_at).toBeNull();
    });

    it('works for a MIGRATED user with no user_credentials row yet', async () => {
      const userId = await makeUser('migrated-block@example.com', /* withCred */ false);
      await db.query(`SELECT public.admin_set_user_block_status($1, true)`, [userId]);
      const cred = await db.query(`SELECT status FROM public.user_credentials WHERE user_id = $1`, [userId]);
      expect(cred.rows[0].status).toBe('disabled');
    });

    it("another user's sessions are completely untouched by a block", async () => {
      const userA = await makeUser('admin-block-a@example.com');
      const userB = await makeUser('admin-block-b@example.com');
      await makeSession(userB, 'admin-block-b@example.com', 'block-b-tok');

      await db.query(`SELECT public.admin_set_user_block_status($1, true)`, [userA]);

      const bSession = await db.query(`SELECT revoked_at FROM public.auth_sessions WHERE user_id = $1`, [userB]);
      expect(bSession.rows[0].revoked_at).toBeNull();
    });

    it('proves the practical "every existing session is rejected after a block" claim end-to-end via the real revoked_at IS NULL predicate validateSessionToken uses', async () => {
      const userId = await makeUser('admin-block-e2e@example.com');
      const s1 = await makeSession(userId, 'admin-block-e2e@example.com', 'e2e-tok-1');

      // Simulates what validateSessionToken (services/auth/sessions.ts)
      // actually checks: token_hash match AND revoked_at IS NULL.
      const beforeBlock = await db.query(
        `SELECT 1 FROM public.auth_sessions WHERE token_hash = 'e2e-tok-1' AND revoked_at IS NULL`,
      );
      expect(beforeBlock.rowCount).toBe(1);

      await db.query(`SELECT public.admin_set_user_block_status($1, true)`, [userId]);

      const afterBlock = await db.query(
        `SELECT 1 FROM public.auth_sessions WHERE token_hash = 'e2e-tok-1' AND revoked_at IS NULL`,
      );
      expect(afterBlock.rowCount).toBe(0);
      void s1;
    });

    it('a forced failure on the session-revocation step rolls back BOTH the status flip and the revocation', async () => {
      const userId = await makeUser('admin-block-rollback@example.com');
      const sessionId = await makeSession(userId, 'admin-block-rollback@example.com', 'block-rollback-tok');

      await db.query(`
        CREATE OR REPLACE FUNCTION public.__raise_forced_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'forced test failure';
        END;
        $$;
        CREATE TRIGGER force_auth_sessions_failure
          BEFORE UPDATE ON public.auth_sessions
          FOR EACH ROW EXECUTE FUNCTION public.__raise_forced_failure();
      `);

      await expect(
        db.query(`SELECT public.admin_set_user_block_status($1, true)`, [userId]),
      ).rejects.toThrow(/forced test failure/);

      const cred = await db.query(`SELECT status FROM public.user_credentials WHERE user_id = $1`, [userId]);
      expect(cred.rows[0].status).toBe('active');

      const session = await db.query(`SELECT revoked_at FROM public.auth_sessions WHERE id = $1`, [sessionId]);
      expect(session.rows[0].revoked_at).toBeNull();
    });
  });
});
