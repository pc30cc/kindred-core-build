/**
 * Hardened admin_impersonation_tokens redemption: the single-use claim AND
 * the expiry check must happen in the SAME conditional UPDATE, not a
 * separate SELECT-then-check-then-UPDATE (server/services/auth/
 * impersonation.ts's redeemImpersonationToken). Before this fix, a token
 * read a moment before its 60s TTL expired could still be claimed by an
 * UPDATE that landed after expiry, because expiry was only checked against
 * a JS `Date` read earlier — not part of the UPDATE's WHERE clause. This
 * proves, against a real PostgreSQL instance, that a single UPDATE with
 * `used_at IS NULL AND expires_at > now()` in its WHERE clause cannot claim
 * an already-expired token, while an unexpired one is still claimed
 * exactly once (single-use semantics unchanged).
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

// Mirrors the exact WHERE clause redeemImpersonationToken() now issues as a
// single PostgREST UPDATE — used_at IS NULL AND expires_at > now(), claim
// and expiry check as one atomic conditional write.
const CLAIM_SQL = `
  UPDATE public.admin_impersonation_tokens
  SET used_at = now()
  WHERE token_hash = $1
    AND used_at IS NULL
    AND expires_at > now()
  RETURNING target_user_id, created_by
`;

suite('admin_impersonation_tokens — atomic expiry+single-use claim (real PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    db = new Client({ connectionString: DSN }) as unknown as PgTestClient;
    await db.connect();
    await ensureAuthChainInstalled(db);
  }, 60_000);

  afterAll(async () => { if (db) await db.end(); });

  afterEach(async () => {
    await db.query(`
      DELETE FROM public.admin_impersonation_tokens;
      DELETE FROM public.profiles;
      DELETE FROM auth.users;
    `);
  });

  // 037 retired the auth.users -> profiles trigger, so this writes profiles
  // directly (the same first-party-signup shape POST /api/auth/signup
  // uses) rather than relying on the now-removed side effect.
  async function makeUser(email: string): Promise<string> {
    const { rows } = await db.query(`INSERT INTO public.profiles (id, email) VALUES (gen_random_uuid(), $1) RETURNING id`, [email]);
    return rows[0].id as string;
  }

  it('an unexpired token is claimed exactly once', async () => {
    const target = await makeUser('impersonation-target@example.com');
    const admin = await makeUser('impersonation-admin@example.com');
    await db.query(
      `INSERT INTO public.admin_impersonation_tokens (target_user_id, created_by, token_hash, expires_at) VALUES ($1, $2, 'live-hash', now() + interval '60 seconds')`,
      [target, admin],
    );

    const first = await db.query(CLAIM_SQL, ['live-hash']);
    expect(first.rowCount).toBe(1);
    expect(first.rows[0].target_user_id).toBe(target);

    const second = await db.query(CLAIM_SQL, ['live-hash']);
    expect(second.rowCount).toBe(0); // already used
  });

  it('a token whose expiry has ALREADY passed cannot be claimed — the WHERE clause itself rejects it, not a separate JS check', async () => {
    const target = await makeUser('impersonation-expired-target@example.com');
    const admin = await makeUser('impersonation-expired-admin@example.com');
    await db.query(
      `INSERT INTO public.admin_impersonation_tokens (target_user_id, created_by, token_hash, expires_at) VALUES ($1, $2, 'expired-hash', now() - interval '1 second')`,
      [target, admin],
    );

    const result = await db.query(CLAIM_SQL, ['expired-hash']);
    expect(result.rowCount).toBe(0);

    // Also prove it was NOT marked used by the failed claim attempt — an
    // expired token stays exactly as it was, not silently consumed.
    const row = await db.query(`SELECT used_at FROM public.admin_impersonation_tokens WHERE token_hash = 'expired-hash'`);
    expect(row.rows[0].used_at).toBeNull();
  });

  it('two simultaneous claims of the same still-valid token: exactly one succeeds', async () => {
    const target = await makeUser('impersonation-race-target@example.com');
    const admin = await makeUser('impersonation-race-admin@example.com');
    await db.query(
      `INSERT INTO public.admin_impersonation_tokens (target_user_id, created_by, token_hash, expires_at) VALUES ($1, $2, 'race-hash', now() + interval '60 seconds')`,
      [target, admin],
    );

    const { Client } = await import('pg');
    const dbB = new Client({ connectionString: DSN }) as unknown as PgTestClient;
    await dbB.connect();
    try {
      const [a, b] = await Promise.all([db.query(CLAIM_SQL, ['race-hash']), dbB.query(CLAIM_SQL, ['race-hash'])]);
      const successes = [a, b].filter((r) => r.rowCount === 1);
      const empties = [a, b].filter((r) => r.rowCount === 0);
      expect(successes.length).toBe(1);
      expect(empties.length).toBe(1);
    } finally {
      await dbB.end();
    }
  });
});
