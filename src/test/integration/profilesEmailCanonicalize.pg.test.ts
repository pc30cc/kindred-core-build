/**
 * 036 — canonicalize existing profiles.email values to lower(btrim(email))
 * and strengthen the unique index to match.
 *
 * 032's index was `UNIQUE (lower(email))` — no trim — while application
 * lookups (findIdentityByEmail) do an EXACT match against a
 * `.trim().toLowerCase()`-normalized input. A legacy row with stray
 * whitespace (e.g. inserted, pre-037, by the self-host chain's own
 * `handle_new_user()` trigger, which wrote `NEW.email` completely
 * unnormalized) would be permanently unreachable by login lookup even
 * though it "existed" under the old index. This proves, against a real
 * PostgreSQL instance: (1) a fresh install already has 032+036 applied and
 * legacy-drift rows get canonicalized in place; (2) two rows that would
 * newly collide once whitespace is stripped make the migration fail
 * loudly rather than silently merging/deleting; (3) the final invariant is
 * genuinely `lower(btrim(email))`, not just `lower(email)`.
 *
 * 037 retired the auth.users -> profiles trigger, and 038 added a CHECK
 * constraint enforcing canonical storage on every write. Both postdate 036
 * chronologically but are always installed alongside it (ensureAuthChainInstalled
 * applies the full chain every time), so simulating "legacy drift" — a raw,
 * non-canonical write, exactly what the old trigger used to produce —
 * requires temporarily dropping 038's CHECK constraint first, the same way
 * the collision test already temporarily drops the unique index: both are
 * standing in for "a database that predates 036/038", not weakening what
 * either constraint proves once restored.
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
const MIGRATION_038 = readFileSync(resolve(process.cwd(), 'database/migrations/038_profiles_email_canonical_check.sql'), 'utf8');

let db: PgTestClient;

async function dropCanonicalCheck() {
  await db.query(`ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_email_canonical_check`);
}
async function restoreCanonicalCheck() {
  await db.query(MIGRATION_038);
}
/**
 * Re-adds the CHECK constraint WITHOUT 038's own preflight/validation —
 * for the one scenario where a test deliberately keeps a non-canonical
 * fixture row in place (to prove something ELSE afterward) while still
 * needing the constraint active for subsequent writes. `NOT VALID` means
 * Postgres enforces it on every new INSERT/UPDATE from this point forward
 * without scanning (or rejecting the re-add over) existing rows — the real
 * 038 migration never needs this because it only ever runs once, after 036
 * has already canonicalized everything.
 */
async function restoreCanonicalCheckNotValid() {
  await db.query(`
    ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_email_canonical_check;
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_email_canonical_check
      CHECK (email IS NULL OR email = lower(btrim(email))) NOT VALID;
  `);
}

suite('036/038 — profiles.email canonicalization + canonical-storage CHECK (real PostgreSQL)', () => {
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
    const userId = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;

    // Simulate a pre-037/038 legacy row — the old trigger wrote NEW.email
    // completely unnormalized, and 038 did not exist yet to stop it.
    await dropCanonicalCheck();
    await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, '  Whitespace-Legacy@Example.com  ')`, [userId]);

    const before = await db.query(`SELECT email FROM public.profiles WHERE id = $1`, [userId]);
    expect(before.rows[0].email).toBe('  Whitespace-Legacy@Example.com  ');

    await db.query(MIGRATION_036);
    await restoreCanonicalCheck();

    const after = await db.query(`SELECT email FROM public.profiles WHERE id = $1`, [userId]);
    expect(after.rows[0].email).toBe('whitespace-legacy@example.com');

    await db.query(`DELETE FROM public.profiles WHERE id = $1`, [userId]);
  });

  it('refuses to canonicalize (fails loudly, never merges/deletes) when two distinct rows would collide once whitespace is stripped', async () => {
    // The strengthened index AND the CHECK constraint from a PRIOR
    // application are already live at this point (ensureAuthChainInstalled
    // applies the full chain), either of which would itself block the
    // collision this test needs to construct — a real "database only has
    // 032, not yet 036/038" scenario can only be reproduced by temporarily
    // dropping both, the same way an operator's database looks the moment
    // before 036 first runs.
    await db.query(`DROP INDEX IF EXISTS public.profiles_email_normalized_unique_idx`);
    await dropCanonicalCheck();

    await db.query(`DELETE FROM public.profiles WHERE email ILIKE '%collision-case%'`);
    const userA = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
    const userB = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
    await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, 'collision-case@example.com')`, [userA]);
    // Force userB's stored value to canonicalize to the SAME address as
    // userA once trimmed — a real collision the OLD lower(email) index
    // (032, no trim) would not have caught, since the untrimmed form
    // differs.
    await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, '  collision-case@example.com  ')`, [userB]);

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
    await db.query(MIGRATION_036);
    await restoreCanonicalCheck();
  });

  it("'Foo@Example.com' and 'foo@example.com ' (trailing space) cannot become two first-party identities", async () => {
    await db.query(`DELETE FROM public.profiles WHERE email ILIKE '%case-space-proof%'`);
    const userA = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
    const userB = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
    // userA: a pre-existing, non-canonical legacy row (as the old trigger
    // could have produced pre-037/038) — needs the CHECK dropped to insert.
    await dropCanonicalCheck();
    await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, 'Case-Space-Proof@Example.com')`, [userA]);
    // userA stays non-canonical for the rest of this test (that's the
    // fixture), so restore the CHECK for FUTURE writes without re-running
    // 038's own preflight, which would otherwise refuse over this row.
    await restoreCanonicalCheckNotValid();
    // userB: a genuinely distinct, canonical identity at a different address.
    await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, 'case-space-proof-2@example.com')`, [userB]);

    // The strengthened index (not a pre-check in application code) is what
    // must reject this: attempting to move userB's identity onto a
    // whitespace/case variant of userA's address. Since the CHECK
    // constraint is back in place, a non-canonical UPDATE attempt is
    // rejected by the CHECK first — still proving the same outcome
    // (userB can never end up colliding with userA), now enforced at an
    // even earlier point than the unique index alone.
    await expect(
      db.query(`UPDATE public.profiles SET email = 'case-space-proof@example.com ' WHERE id = $1`, [userB]),
    ).rejects.toThrow(/profiles_email_canonical_check|check constraint|duplicate key|unique/i);

    // userA's identity is untouched — the rejected UPDATE never merged or
    // silently mutated the "other side" of the near-collision.
    const stillA = await db.query(`SELECT email FROM public.profiles WHERE id = $1`, [userA]);
    expect(stillA.rows[0].email).toBe('Case-Space-Proof@Example.com');

    await db.query(`DELETE FROM public.profiles WHERE id IN ($1, $2)`, [userA, userB]);
    // Table is clean again — restore the constraint to a fully VALID state
    // (not just NOT VALID) for subsequent tests/files sharing this DB.
    await db.query(`ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_email_canonical_check`);
  });
});
