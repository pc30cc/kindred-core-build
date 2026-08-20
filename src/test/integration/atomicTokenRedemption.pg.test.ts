/**
 * 030 — atomic single-use redemption for password-reset and email-verify
 * tokens.
 *
 * The gap this closes: server/routes/auth-email.ts used to SELECT the
 * unused token, then UPDATE user_credentials, then mark the token used, in
 * three separate round-trips. Two simultaneous requests carrying the SAME
 * raw token could both pass the "is it unused" SELECT before either UPDATE
 * landed. This suite proves the fix with REAL concurrent requests against a
 * real PostgreSQL instance — not a mocked client that can't reproduce a
 * race at the database level.
 *
 * Driven by TEST_DATABASE_URL (or the legacy CLEAN_INSTALL_DATABASE_URL) —
 * skipped entirely when no live Postgres is configured, exactly like the
 * other .pg.test.ts suites in this directory. Verified locally against a
 * real PostgreSQL 16 instance with the auth-schema stub
 * (authStubSchema.ts) standing in for the Supabase `auth` schema the
 * dedicated CI jobs already exercise for real.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { PgQueryable } from './pgMigrationChain';
import { ensureAuthChainInstalled } from './authStubSchema';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type PgTestClient = PgQueryable & { connect(): Promise<void>; end(): Promise<void> };

let admin: PgTestClient;

async function freshClient(): Promise<PgTestClient> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: DSN }) as unknown as PgTestClient;
  await c.connect();
  return c;
}

suite('030 — atomic auth token redemption (real PostgreSQL, real concurrency)', () => {
  beforeAll(async () => {
    admin = await freshClient();
    await ensureAuthChainInstalled(admin);
  }, 60_000);

  afterAll(async () => { if (admin) await admin.end(); });

  afterEach(async () => {
    await admin.query(`
      DELETE FROM public.auth_reset_tokens;
      DELETE FROM public.auth_verify_tokens;
      DELETE FROM public.auth_sessions;
      DELETE FROM public.user_credentials;
      DELETE FROM public.profiles;
      DELETE FROM auth.users;
    `);
  });

  async function makeUser(email: string): Promise<string> {
    const { rows } = await admin.query(`INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [email]);
    const userId = rows[0].id as string;
    await admin.query(`INSERT INTO public.user_credentials (user_id, password_hash) VALUES ($1, 'OLD_HASH')`, [userId]);
    return userId;
  }

  describe('grants', () => {
    it('anon and authenticated cannot execute either redeem function', async () => {
      const { rows } = await admin.query(`
        SELECT
          has_function_privilege('anon', 'public.redeem_password_reset_token(text,text)', 'EXECUTE') AS reset_anon,
          has_function_privilege('authenticated', 'public.redeem_password_reset_token(text,text)', 'EXECUTE') AS reset_auth,
          has_function_privilege('service_role', 'public.redeem_password_reset_token(text,text)', 'EXECUTE') AS reset_svc,
          has_function_privilege('anon', 'public.redeem_email_verify_token(text)', 'EXECUTE') AS verify_anon,
          has_function_privilege('authenticated', 'public.redeem_email_verify_token(text)', 'EXECUTE') AS verify_auth,
          has_function_privilege('service_role', 'public.redeem_email_verify_token(text)', 'EXECUTE') AS verify_svc
      `);
      const r = rows[0];
      expect(r).toMatchObject({
        reset_anon: false, reset_auth: false, reset_svc: true,
        verify_anon: false, verify_auth: false, verify_svc: true,
      });
    });
  });

  describe('redeem_password_reset_token — concurrent redemption', () => {
    it('two simultaneous requests for the SAME token: exactly one succeeds, password changes once, sessions revoked, replay fails', async () => {
      const userId = await makeUser('reset-race@example.com');
      const tokenHash = 'reset-race-token-hash';
      await admin.query(
        `INSERT INTO public.auth_reset_tokens (user_id, email, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [userId, 'reset-race@example.com', tokenHash],
      );
      await admin.query(
        `INSERT INTO public.auth_sessions (user_id, email, token_hash, expires_at) VALUES ($1, $2, 'sess-a', now() + interval '1 day'), ($1, $2, 'sess-b', now() + interval '1 day')`,
        [userId, 'reset-race@example.com'],
      );

      const c1 = await freshClient();
      const c2 = await freshClient();
      try {
        const [r1, r2] = await Promise.all([
          c1.query(`SELECT * FROM public.redeem_password_reset_token($1, $2)`, [tokenHash, 'NEW_HASH_1']),
          c2.query(`SELECT * FROM public.redeem_password_reset_token($1, $2)`, [tokenHash, 'NEW_HASH_2']),
        ]);

        const succeeded = [r1, r2].filter((r) => r.rows.length === 1 && r.rows[0].redeemed_user_id);
        const failed = [r1, r2].filter((r) => r.rows.length === 0);
        expect(succeeded).toHaveLength(1);
        expect(failed).toHaveLength(1);

        const winner = succeeded[0].rows[0];
        expect(winner.redeemed_user_id).toBe(userId);
        expect(winner.redeemed_sessions_revoked).toBe(2);

        const cred = await admin.query(`SELECT password_hash FROM public.user_credentials WHERE user_id = $1`, [userId]);
        expect(['NEW_HASH_1', 'NEW_HASH_2']).toContain(cred.rows[0].password_hash);

        const sessions = await admin.query(
          `SELECT revoked_at, revoke_reason FROM public.auth_sessions WHERE user_id = $1`,
          [userId],
        );
        expect(sessions.rows).toHaveLength(2);
        for (const row of sessions.rows) {
          expect(row.revoked_at).not.toBeNull();
          expect(row.revoke_reason).toBe('password_reset');
        }

        const replay = await admin.query(`SELECT * FROM public.redeem_password_reset_token($1, $2)`, [tokenHash, 'REPLAY_HASH']);
        expect(replay.rows).toHaveLength(0);
        const credAfterReplay = await admin.query(`SELECT password_hash FROM public.user_credentials WHERE user_id = $1`, [userId]);
        expect(credAfterReplay.rows[0].password_hash).toBe(cred.rows[0].password_hash);
      } finally {
        await c1.end();
        await c2.end();
      }
    });

    it('an expired token is never redeemable, even once', async () => {
      const userId = await makeUser('reset-expired@example.com');
      await admin.query(
        `INSERT INTO public.auth_reset_tokens (user_id, email, token_hash, expires_at) VALUES ($1, $2, 'expired-hash', now() - interval '1 minute')`,
        [userId, 'reset-expired@example.com'],
      );
      const result = await admin.query(`SELECT * FROM public.redeem_password_reset_token($1, $2)`, ['expired-hash', 'X']);
      expect(result.rows).toHaveLength(0);
      const cred = await admin.query(`SELECT password_hash FROM public.user_credentials WHERE user_id = $1`, [userId]);
      expect(cred.rows[0].password_hash).toBe('OLD_HASH');
    });

    it('a revoked token is never redeemable', async () => {
      const userId = await makeUser('reset-revoked@example.com');
      await admin.query(
        `INSERT INTO public.auth_reset_tokens (user_id, email, token_hash, expires_at, revoked_at) VALUES ($1, $2, 'revoked-hash', now() + interval '1 hour', now())`,
        [userId, 'reset-revoked@example.com'],
      );
      const result = await admin.query(`SELECT * FROM public.redeem_password_reset_token($1, $2)`, ['revoked-hash', 'X']);
      expect(result.rows).toHaveLength(0);
    });

    it('identity comes only from the claimed token row — the caller cannot pass a target user id', async () => {
      // The function signature itself proves this: it takes only
      // (_token_hash, _new_password_hash), with no user-id parameter at
      // all, so there is no argument through which a caller could name a
      // different identity than the one the token was issued to.
      const { rows } = await admin.query(`
        SELECT pg_get_function_arguments(oid) AS args
        FROM pg_proc WHERE proname = 'redeem_password_reset_token' AND pronamespace = 'public'::regnamespace
      `);
      expect(rows[0].args).not.toMatch(/user_id/);
    });
  });

  describe('redeem_email_verify_token — concurrent redemption', () => {
    it('two simultaneous requests for the SAME token: exactly one succeeds, email_verified_at set exactly once', async () => {
      const userId = await makeUser('verify-race@example.com');
      const tokenHash = 'verify-race-token-hash';
      await admin.query(
        `INSERT INTO public.auth_verify_tokens (user_id, email, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`,
        [userId, 'verify-race@example.com', tokenHash],
      );

      const c1 = await freshClient();
      const c2 = await freshClient();
      try {
        const [r1, r2] = await Promise.all([
          c1.query(`SELECT * FROM public.redeem_email_verify_token($1)`, [tokenHash]),
          c2.query(`SELECT * FROM public.redeem_email_verify_token($1)`, [tokenHash]),
        ]);
        const succeeded = [r1, r2].filter((r) => r.rows.length === 1 && r.rows[0].redeemed_user_id);
        expect(succeeded).toHaveLength(1);

        const cred = await admin.query(`SELECT email_verified_at FROM public.user_credentials WHERE user_id = $1`, [userId]);
        expect(cred.rows[0].email_verified_at).not.toBeNull();

        const replay = await admin.query(`SELECT * FROM public.redeem_email_verify_token($1)`, [tokenHash]);
        expect(replay.rows).toHaveLength(0);
      } finally {
        await c1.end();
        await c2.end();
      }
    });
  });
});
