/**
 * 032 — DB-level unique identity: profiles.email is unique
 * case-insensitively.
 *
 * server/routes/auth.ts's signup handler assumed the profiles INSERT
 * itself would reject a duplicate email ("Most likely a unique-email race
 * with a concurrent signup for the same address") but no migration in
 * either chain ever added that constraint — this proves, against a real
 * PostgreSQL instance, that it now does: a concurrent (or sequential)
 * differently-cased duplicate is rejected at the database level, not
 * merely by the application's own pre-check (which has its own race
 * window). Also proves the migration's preflight refuses to add the
 * constraint — loudly, without touching any row — if duplicates already
 * exist.
 *
 * 037 retired the auth.users -> profiles signup trigger and 038 added a
 * CHECK constraint enforcing canonical (lower(btrim())) storage on every
 * write — both postdate 032 but are always installed alongside it
 * (ensureAuthChainInstalled applies the full chain every time). This file
 * therefore writes profiles directly (matching the real first-party
 * signup shape) rather than relying on the retired trigger, and
 * temporarily drops 038's CHECK constraint wherever a test's whole point
 * is to insert a deliberately non-canonical or differently-cased raw
 * value to exercise the UNIQUE INDEX specifically — defense-in-depth: the
 * index alone must still catch a case-duplicate even if the CHECK were
 * ever bypassed, not just rely on the CHECK to normalize first.
 *
 * Driven by TEST_DATABASE_URL (or the legacy CLEAN_INSTALL_DATABASE_URL) —
 * skipped entirely when no live Postgres is configured.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PgQueryable } from './pgMigrationChain';
import { ensureAuthChainInstalled } from './authStubSchema';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type PgTestClient = PgQueryable & { connect(): Promise<void>; end(): Promise<void> };

let db: PgTestClient;

async function freshClient(): Promise<PgTestClient> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: DSN }) as unknown as PgTestClient;
  await c.connect();
  return c;
}

const migration032 = () => readFileSync(resolve(process.cwd(), 'database/migrations/032_profiles_email_unique.sql'), 'utf8');
const migration038 = () => readFileSync(resolve(process.cwd(), 'database/migrations/038_profiles_email_canonical_check.sql'), 'utf8');

async function dropCanonicalCheck() {
  await db.query(`ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_email_canonical_check`);
}

suite('032 — profiles.email unique (case-insensitive), real PostgreSQL', () => {
  // ensureAuthChainInstalled installs (or confirms already-installed) the
  // FULL chain including 032 — this suite shares one database with other
  // .pg.test.ts files in CI (--no-file-parallelism), so 032 may already be
  // present before this file's beforeAll even runs. The "before the
  // constraint exists" block below does NOT rely on install ordering for
  // that: it explicitly drops and restores the index (and the 038 CHECK,
  // which would otherwise block the raw non-canonical writes this block
  // needs to construct) around itself.
  beforeAll(async () => {
    db = await freshClient();
    await ensureAuthChainInstalled(db);
  }, 60_000);

  afterAll(async () => { if (db) await db.end(); });

  describe('before the constraint exists', () => {
    // Self-bracketing: drop the index (and the 038 CHECK, which enforces a
    // stricter invariant than 032 alone) before each test in this block
    // and restore both afterward, so this suite never leaves either
    // uninstalled for whatever runs next.
    beforeEach(async () => {
      await db.query(`DROP INDEX IF EXISTS profiles_email_normalized_unique_idx;`);
      await dropCanonicalCheck();
    });

    afterEach(async () => {
      await db.query(`DELETE FROM public.profiles;`);
      await db.query(migration032());
      await db.query(migration038());
    });

    it('applies cleanly on a database with no duplicate emails', async () => {
      await db.query(`DELETE FROM public.profiles;`);
      await expect(db.query(migration032())).resolves.toBeDefined();
      const idx = await db.query(`SELECT 1 FROM pg_indexes WHERE tablename = 'profiles' AND indexname = 'profiles_email_normalized_unique_idx'`);
      expect(idx.rows).toHaveLength(1);
    });

    it('is idempotent — applying it twice is a no-op the second time', async () => {
      await db.query(migration032());
      await expect(db.query(migration032())).resolves.toBeDefined();
    });

    it('the preflight refuses to run — loudly, without deleting or merging anything — when a duplicate normalized email already exists', async () => {
      await db.query(`DELETE FROM public.profiles;`);
      // Two profiles rows for the same normalized email, inserted while
      // no unique index (and no canonical-storage CHECK) exists yet —
      // nothing stops this, which is the whole gap this migration closes.
      const idA = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
      const idB = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
      await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, 'Dupe@Example.com')`, [idA]);
      await db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, 'dupe@example.com')`, [idB]);

      await expect(db.query(migration032())).rejects.toThrow(/duplicate normalized-email group/);

      // Neither row was touched — no silent delete/merge.
      const rows = await db.query(`SELECT id, email FROM public.profiles WHERE id IN ($1, $2) ORDER BY id`, [idA, idB]);
      expect(rows.rows).toHaveLength(2);
      const idx = await db.query(`SELECT 1 FROM pg_indexes WHERE tablename = 'profiles' AND indexname = 'profiles_email_normalized_unique_idx'`);
      expect(idx.rows).toHaveLength(0);

      // Clean up the duplicate before this test's afterEach reinstalls 032
      // (which would otherwise hit the very preflight this test just
      // proved works).
      await db.query(`DELETE FROM public.profiles WHERE id IN ($1, $2)`, [idA, idB]);
    });
  });

  describe('after the constraint is in place', () => {
    // The index is guaranteed present for this whole block (ensureAuthChainInstalled
    // in the outer beforeAll, or restored by the previous block's own
    // afterEach) and must survive across every test here — only row DATA
    // is cleared between tests, never the index itself.
    beforeAll(async () => {
      await db.query(migration032());
    });

    afterEach(async () => {
      await db.query(`DELETE FROM public.profiles;`);
    });

    it('Foo@Example.com and foo@example.com cannot both become first-party profiles (unique index alone, defense-in-depth)', async () => {
      // Real signups always normalize before writing (038's CHECK enforces
      // that at the table level too), so a raw mixed-case write only ever
      // happens if something bypasses normalization entirely — temporarily
      // dropping 038 here isolates and proves the UNIQUE INDEX itself
      // still independently catches a case-duplicate, not just the CHECK.
      await dropCanonicalCheck();
      try {
        await db.query(`INSERT INTO public.profiles (id, email) VALUES (gen_random_uuid(), 'Foo@Example.com')`);
        await expect(
          db.query(`INSERT INTO public.profiles (id, email) VALUES (gen_random_uuid(), 'foo@example.com')`),
        ).rejects.toThrow(/profiles_email_normalized_unique_idx/);

        const count = await db.query(`SELECT count(*) FROM public.profiles WHERE lower(email) = 'foo@example.com'`);
        expect(Number(count.rows[0].count)).toBe(1);
      } finally {
        // The surviving row is the deliberately non-canonical 'Foo@Example.com'
        // — clean it up before restoring 038, whose own preflight would
        // otherwise refuse to re-add the CHECK over a non-canonical row.
        await db.query(`DELETE FROM public.profiles WHERE email = 'Foo@Example.com'`);
        await db.query(migration038());
      }
    });

    it('a REAL concurrent signup race (two simultaneous inserts, same normalized email) — exactly one succeeds', async () => {
      // Deliberately does NOT fake the constraint the way a mocked
      // service-client test would: this fires two genuinely concurrent
      // INSERTs against the same live database and lets Postgres itself
      // arbitrate, proving the index — not application-level luck —
      // is what makes this safe. Uses the already-normalized form both
      // real concurrent signups would actually submit (server/routes/
      // auth.ts normalizes with .trim().toLowerCase() before this INSERT
      // in production).
      const c1 = await freshClient();
      const c2 = await freshClient();
      try {
        const insert = (c: PgTestClient) =>
          c.query(`INSERT INTO public.profiles (id, email) VALUES (gen_random_uuid(), 'race-signup@example.com') RETURNING id`);
        const results = await Promise.allSettled([insert(c1), insert(c2)]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/profiles_email_normalized_unique_idx/);

        const count = await db.query(`SELECT count(*) FROM public.profiles WHERE lower(email) = 'race-signup@example.com'`);
        expect(Number(count.rows[0].count)).toBe(1);
      } finally {
        await c1.end();
        await c2.end();
      }
    });

    it('a genuinely different email is unaffected', async () => {
      await expect(
        db.query(`INSERT INTO public.profiles (id, email) VALUES (gen_random_uuid(), 'unique-user@example.com')`),
      ).resolves.toBeDefined();
      const count = await db.query(`SELECT count(*) FROM public.profiles WHERE lower(email) = 'unique-user@example.com'`);
      expect(Number(count.rows[0].count)).toBe(1);
    });
  });
});
