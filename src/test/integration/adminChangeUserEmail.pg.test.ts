/**
 * 035 — atomic admin email-change lifecycle.
 *
 * PATCH /api/admin/users/:userId/profile previously wrote profiles.email
 * with a bare column update — no invalidation of anything issued against
 * the OLD address. This proves admin_change_user_email against a real
 * PostgreSQL instance: unused reset/verify tokens for the OLD identity
 * are revoked, the verified state resets (does not silently carry to the
 * new address), every session is revoked, a duplicate normalized email is
 * rejected via the real unique index (032/036), and a no-op call (same
 * normalized address) disturbs nothing.
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

suite('035 — admin_change_user_email (real PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    db = new Client({ connectionString: DSN }) as unknown as PgTestClient;
    await db.connect();
    await ensureAuthChainInstalled(db);
  }, 60_000);

  afterAll(async () => { if (db) await db.end(); });

  afterEach(async () => {
    await db.query(`
      DELETE FROM public.auth_reset_tokens;
      DELETE FROM public.auth_verify_tokens;
      DELETE FROM public.auth_sessions;
      DELETE FROM public.user_credentials;
      DELETE FROM public.profiles;
      DELETE FROM auth.users;
    `);
  });

  async function makeUser(email: string, verified = true): Promise<string> {
    const { rows } = await db.query(`INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [email]);
    const userId = rows[0].id as string;
    await db.query(
      `INSERT INTO public.user_credentials (user_id, password_hash, email_verified_at) VALUES ($1, 'HASH', $2)`,
      [userId, verified ? new Date().toISOString() : null],
    );
    return userId;
  }

  it('is locked to service_role only', async () => {
    const { rows } = await db.query(`
      SELECT
        has_function_privilege('anon', 'public.admin_change_user_email(uuid,text)', 'EXECUTE') AS anon_can,
        has_function_privilege('authenticated', 'public.admin_change_user_email(uuid,text)', 'EXECUTE') AS auth_can,
        has_function_privilege('service_role', 'public.admin_change_user_email(uuid,text)', 'EXECUTE') AS svc_can
    `);
    expect(rows[0]).toMatchObject({ anon_can: false, auth_can: false, svc_can: true });
  });

  it('changes the email, resets verification, revokes outstanding tokens, and revokes sessions — all together', async () => {
    const userId = await makeUser('old@example.com', /* verified */ true);
    await db.query(`INSERT INTO public.auth_reset_tokens (user_id, email, token_hash, expires_at) VALUES ($1, 'old@example.com', 'reset-hash', now() + interval '1 hour')`, [userId]);
    await db.query(`INSERT INTO public.auth_verify_tokens (user_id, email, token_hash, expires_at) VALUES ($1, 'old@example.com', 'verify-hash', now() + interval '1 day')`, [userId]);
    await db.query(`INSERT INTO public.auth_sessions (user_id, email, token_hash, expires_at) VALUES ($1, 'old@example.com', 'sess-hash', now() + interval '1 day')`, [userId]);

    const result = await db.query(`SELECT * FROM public.admin_change_user_email($1, 'New@Example.com')`, [userId]);
    expect(result.rows[0]).toMatchObject({ changed: true, old_email: 'old@example.com', new_email: 'new@example.com', sessions_revoked: 1 });

    const profile = await db.query(`SELECT email FROM public.profiles WHERE id = $1`, [userId]);
    expect(profile.rows[0].email).toBe('new@example.com');

    const cred = await db.query(`SELECT email_verified_at FROM public.user_credentials WHERE user_id = $1`, [userId]);
    expect(cred.rows[0].email_verified_at).toBeNull();

    const resetToken = await db.query(`SELECT revoked_at FROM public.auth_reset_tokens WHERE user_id = $1`, [userId]);
    expect(resetToken.rows[0].revoked_at).not.toBeNull();

    const verifyToken = await db.query(`SELECT revoked_at FROM public.auth_verify_tokens WHERE user_id = $1`, [userId]);
    expect(verifyToken.rows[0].revoked_at).not.toBeNull();

    const session = await db.query(`SELECT revoked_at, revoke_reason FROM public.auth_sessions WHERE user_id = $1`, [userId]);
    expect(session.rows[0].revoked_at).not.toBeNull();
    expect(session.rows[0].revoke_reason).toBe('admin_action');
  });

  it('an OLD reset token can no longer be redeemed after the email change (real redeem_password_reset_token call)', async () => {
    const userId = await makeUser('reset-old@example.com');
    await db.query(`INSERT INTO public.auth_reset_tokens (user_id, email, token_hash, expires_at) VALUES ($1, 'reset-old@example.com', 'reset-tok-hash', now() + interval '1 hour')`, [userId]);

    await db.query(`SELECT public.admin_change_user_email($1, 'reset-new@example.com')`, [userId]);

    const redeemed = await db.query(`SELECT * FROM public.redeem_password_reset_token('reset-tok-hash', 'ATTACKER_HASH')`);
    expect(redeemed.rowCount).toBe(0); // empty result set == rejected

    const cred = await db.query(`SELECT password_hash FROM public.user_credentials WHERE user_id = $1`, [userId]);
    expect(cred.rows[0].password_hash).toBe('HASH'); // unchanged — the stale token never redeemed
  });

  it('an OLD verify token can no longer verify the NEW email (real redeem_email_verify_token call)', async () => {
    const userId = await makeUser('verify-old@example.com', /* verified */ false);
    await db.query(`INSERT INTO public.auth_verify_tokens (user_id, email, token_hash, expires_at) VALUES ($1, 'verify-old@example.com', 'verify-tok-hash', now() + interval '1 day')`, [userId]);

    await db.query(`SELECT public.admin_change_user_email($1, 'verify-new@example.com')`, [userId]);

    const redeemed = await db.query(`SELECT * FROM public.redeem_email_verify_token('verify-tok-hash')`);
    expect(redeemed.rowCount).toBe(0);

    const cred = await db.query(`SELECT email_verified_at FROM public.user_credentials WHERE user_id = $1`, [userId]);
    expect(cred.rows[0].email_verified_at).toBeNull();
  });

  it('a verified OLD email becomes an unverified NEW email — verified state does not silently carry over', async () => {
    const userId = await makeUser('carry-old@example.com', /* verified */ true);
    const before = await db.query(`SELECT email_verified_at FROM public.user_credentials WHERE user_id = $1`, [userId]);
    expect(before.rows[0].email_verified_at).not.toBeNull();

    await db.query(`SELECT public.admin_change_user_email($1, 'carry-new@example.com')`, [userId]);

    const after = await db.query(`SELECT email_verified_at FROM public.user_credentials WHERE user_id = $1`, [userId]);
    expect(after.rows[0].email_verified_at).toBeNull();
  });

  it('a duplicate normalized new email is rejected (real unique-index violation)', async () => {
    const userA = await makeUser('taken@example.com');
    const userB = await makeUser('changeling@example.com');

    await expect(
      db.query(`SELECT public.admin_change_user_email($1, 'TAKEN@Example.com')`, [userB]),
    ).rejects.toThrow(/duplicate key|unique/i);

    // Nothing about userB's identity/tokens/sessions moved.
    const profile = await db.query(`SELECT email FROM public.profiles WHERE id = $1`, [userB]);
    expect(profile.rows[0].email).toBe('changeling@example.com');
    void userA;
  });

  it('a no-op call (same normalized email, different case/whitespace) disturbs nothing', async () => {
    const userId = await makeUser('stable@example.com', /* verified */ true);
    await db.query(`INSERT INTO public.auth_sessions (user_id, email, token_hash, expires_at) VALUES ($1, 'stable@example.com', 'stable-sess', now() + interval '1 day')`, [userId]);

    const result = await db.query(`SELECT * FROM public.admin_change_user_email($1, '  Stable@Example.com  ')`, [userId]);
    expect(result.rows[0].changed).toBe(false);

    const cred = await db.query(`SELECT email_verified_at FROM public.user_credentials WHERE user_id = $1`, [userId]);
    expect(cred.rows[0].email_verified_at).not.toBeNull(); // still verified — untouched

    const session = await db.query(`SELECT revoked_at FROM public.auth_sessions WHERE token_hash = 'stable-sess'`);
    expect(session.rows[0].revoked_at).toBeNull(); // still valid — untouched
  });

  it("other users' tokens and sessions are completely untouched by someone else's email change", async () => {
    const userA = await makeUser('other-a@example.com');
    const userB = await makeUser('other-b@example.com');
    await db.query(`INSERT INTO public.auth_reset_tokens (user_id, email, token_hash, expires_at) VALUES ($1, 'other-b@example.com', 'b-reset-hash', now() + interval '1 hour')`, [userB]);
    await db.query(`INSERT INTO public.auth_sessions (user_id, email, token_hash, expires_at) VALUES ($1, 'other-b@example.com', 'b-sess-hash', now() + interval '1 day')`, [userB]);

    await db.query(`SELECT public.admin_change_user_email($1, 'other-a-changed@example.com')`, [userA]);

    const bToken = await db.query(`SELECT revoked_at FROM public.auth_reset_tokens WHERE user_id = $1`, [userB]);
    expect(bToken.rows[0].revoked_at).toBeNull();
    const bSession = await db.query(`SELECT revoked_at FROM public.auth_sessions WHERE user_id = $1`, [userB]);
    expect(bSession.rows[0].revoked_at).toBeNull();
  });
});
