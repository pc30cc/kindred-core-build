/**
 * 036 — canonicalize existing profiles.email values to lower(btrim(email))
 * and strengthen the unique index to match.
 *
 * 032's index was `UNIQUE (lower(email))` — no trim — while application
 * lookups (findIdentityByEmail) do an EXACT match against a
 * `.trim().toLowerCase()`-normalized input. A legacy row with stray
 * whitespace (e.g. inserted by the self-host chain's own
 * `handle_new_user()` trigger, which writes `NEW.email` completely
 * unnormalized) would be permanently unreachable by login lookup even
 * though it "existed" under the old index. This proves, against a real
 * PostgreSQL instance: (1) a fresh install already has 032+036 applied and
 * legacy-drift rows get canonicalized in place; (2) two rows that would
 * newly collide once whitespace is stripped make the migration fail
 * loudly rather than silently merging/deleting; (3) the final invariant is
 * genuinely `lower(btrim(email))`, not just `lower(email)`.
 *
 * Driven by TEST_DATABASE_URL (or the legacy CLEAN_INSTALL_DATABASE_URL) —
 * skipped entirely when no live Postgres is configured.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PgQueryable } from './pgMigrationChain';
import { ensureAuthChainInstalled } from './authStubSchema';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type PgTestClient = PgQueryable & { connect(): Promise<void>; end(): Promise<void> };

const MIGRATION_036 = readFileSync(resolve(process.cwd(), 'database/migrations/036_profiles_email_canonicalize.sql'), 'utf8');

let db: PgTestClient;

suite('036 — profiles.email canonicalization (real PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    db = new Client({ connectionString: DSN }) as unknown as PgTestClient;
    await db.connect();
    await ensureAuthChainInstalled(db);
  }, 60_000);

  afterAll(async () => { if (db) await db.end(); });

  it('the final invariant is lower(btrim(email)), not just lower(email)', async () => {
    const { rows } = await db.query(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'profiles' AND indexname = 'profiles_email_normalized_unique_idx'
    `);
    expect(rows[0].indexdef).toMatch(/btrim/i);
  });

  it('a legacy row with stray whitespace gets canonicalized in place by re-applying 036 (idempotent, matches CI re-application convention)', async () => {
    await db.query(`DELETE FROM public.profiles WHERE email ILIKE '%whitespace-legacy%'`);
    // Bypass the normal insert path (which already normalizes) to simulate
    // a pre-existing legacy row the way the self-host trigger would have
    // written it: verbatim, unnormalized.
    const { rows: userRows } = await db.query(`INSERT INTO auth.users (email) VALUES ('  Whitespace-Legacy@Example.com  ') RETURNING id`);
    const userId = userRows[0].id as string;
    await db.query(`UPDATE public.profiles SET email = '  Whitespace-Legacy@Example.com  ' WHERE id = $1`, [userId]);

    const before = await db.query(`SELECT email FROM public.profiles WHERE id = $1`, [userId]);
    expect(before.rows[0].email).toBe('  Whitespace-Legacy@Example.com  ');

    await db.query(MIGRATION_036);

    const after = await db.query(`SELECT email FROM public.profiles WHERE id = $1`, [userId]);
    expect(after.rows[0].email).toBe('whitespace-legacy@example.com');

    await db.query(`DELETE FROM public.profiles WHERE id = $1`, [userId]);
    await db.query(`DELETE FROM auth.users WHERE id = $1`, [userId]);
  });

  it('refuses to canonicalize (fails loudly, never merges/deletes) when two distinct rows would collide once whitespace is stripped', async () => {
    // The strengthened index from a PRIOR application of 036 is already
    // live at this point (ensureAuthChainInstalled applies the full
    // chain), which would itself block the collision this test needs to
    // construct — a real "database only has 032, not yet 036" scenario
    // can only be reproduced by temporarily dropping the index, the same
    // way an operator's database looks the moment before 036 first runs.
    await db.query(`DROP INDEX IF EXISTS public.profiles_email_normalized_unique_idx`);

    await db.query(`DELETE FROM public.profiles WHERE email ILIKE '%collision-case%'`);
    const { rows: r1 } = await db.query(`INSERT INTO auth.users (email) VALUES ('collision-case@example.com') RETURNING id`);
    const { rows: r2 } = await db.query(`INSERT INTO auth.users (email) VALUES ('temp-collision-case-2@example.com') RETURNING id`);
    const userA = r1[0].id as string;
    const userB = r2[0].id as string;
    // Force userB's stored value to canonicalize to the SAME address as
    // userA once trimmed — a real collision the OLD lower(email) index
    // (032, no trim) would not have caught, since the untrimmed form
    // differs.
    await db.query(`UPDATE public.profiles SET email = '  collision-case@example.com  ' WHERE id = $1`, [userB]);

    const before = await db.query(`SELECT id, email FROM public.profiles WHERE id IN ($1, $2) ORDER BY id`, [userA, userB]);
    expect(before.rowCount).toBe(2); // both rows still distinct pre-migration

    await expect(db.query(MIGRATION_036)).rejects.toThrow(/refusing to canonicalize/i);

    // Neither row was touched, merged, or deleted by the failed attempt.
    const after = await db.query(`SELECT id, email FROM public.profiles WHERE id IN ($1, $2) ORDER BY id`, [userA, userB]);
    expect(after.rowCount).toBe(2);
    expect(after.rows.find((r: any) => r.id === userA)?.email).toBe('collision-case@example.com');
    expect(after.rows.find((r: any) => r.id === userB)?.email).toBe('  collision-case@example.com  ');

    // Resolve the collision the way an operator would (rename one) so the
    // invariant can be restored for subsequent tests/files sharing this DB.
    await db.query(`DELETE FROM public.profiles WHERE id IN ($1, $2)`, [userA, userB]);
    await db.query(`DELETE FROM auth.users WHERE id IN ($1, $2)`, [userA, userB]);
    await db.query(MIGRATION_036);
  });

  it("'Foo@Example.com' and 'foo@example.com ' (trailing space) cannot become two first-party identities", async () => {
    await db.query(`DELETE FROM public.profiles WHERE email ILIKE '%case-space-proof%'`);
    // First identity, created normally (via the trigger every real signup
    // goes through) at a non-colliding address.
    const { rows: r1 } = await db.query(`INSERT INTO auth.users (email) VALUES ('Case-Space-Proof@Example.com') RETURNING id`);
    const userA = r1[0].id as string;
    // A second, genuinely distinct identity — different address, so its own
    // trigger-driven profiles insert succeeds normally.
    const { rows: r2 } = await db.query(`INSERT INTO auth.users (email) VALUES ('case-space-proof-2@example.com') RETURNING id`);
    const userB = r2[0].id as string;

    // The strengthened index (not a pre-check in application code) is what
    // must reject this: attempting to move userB's identity onto a
    // whitespace/case variant of userA's already-canonicalized address.
    await expect(
      db.query(`UPDATE public.profiles SET email = 'case-space-proof@example.com ' WHERE id = $1`, [userB]),
    ).rejects.toThrow(/duplicate key|unique/i);

    // userA's identity is untouched — the rejected UPDATE never merged or
    // silently mutated the "other side" of the near-collision. (userA's
    // profiles.email is whatever the self-host trigger wrote verbatim from
    // auth.users.email — unnormalized, by design of this test's setup —
    // the point being it is UNCHANGED by the failed UPDATE, not that it is
    // itself already canonical.)
    const stillA = await db.query(`SELECT email FROM public.profiles WHERE id = $1`, [userA]);
    expect(stillA.rows[0].email).toBe('Case-Space-Proof@Example.com');

    await db.query(`DELETE FROM public.profiles WHERE id IN ($1, $2)`, [userA, userB]);
    await db.query(`DELETE FROM auth.users WHERE email ILIKE '%case-space-proof%'`);
  });
});
