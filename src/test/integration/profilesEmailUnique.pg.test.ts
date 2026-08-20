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

suite('032 — profiles.email unique (case-insensitive), real PostgreSQL', () => {
  // ensureAuthChainInstalled installs (or confirms already-installed) the
  // FULL chain including 032 — this suite shares one database with other
  // .pg.test.ts files in CI (--no-file-parallelism), so 032 may already be
  // present before this file's beforeAll even runs. The "before the
  // constraint exists" block below does NOT rely on install ordering for
  // that: it explicitly drops and restores the index around itself.
  beforeAll(async () => {
    db = await freshClient();
    await ensureAuthChainInstalled(db);
  }, 60_000);

  afterAll(async () => { if (db) await db.end(); });

  describe('before the constraint exists', () => {
    // Self-bracketing: drop the index before each test in this block (it
    // may already exist, installed by ensureAuthChainInstalled or by an
    // earlier file sharing this database) and restore it afterward, so
    // this suite never leaves 032 uninstalled for whatever runs next.
    beforeEach(async () => {
      await db.query(`DROP INDEX IF EXISTS profiles_email_normalized_unique_idx;`);
    });

    afterEach(async () => {
      await db.query(`DELETE FROM auth.users; DELETE FROM public.profiles;`);
      await db.query(migration032());
    });

    it('applies cleanly on a database with no duplicate emails', async () => {
      await db.query(`DELETE FROM auth.users; DELETE FROM public.profiles;`);
      await expect(db.query(migration032())).resolves.toBeDefined();
      const idx = await db.query(`SELECT 1 FROM pg_indexes WHERE tablename = 'profiles' AND indexname = 'profiles_email_normalized_unique_idx'`);
      expect(idx.rows).toHaveLength(1);
    });

    it('is idempotent — applying it twice is a no-op the second time', async () => {
      await db.query(migration032());
      await expect(db.query(migration032())).resolves.toBeDefined();
    });

    it('the preflight refuses to run — loudly, without deleting or merging anything — when a duplicate normalized email already exists', async () => {
      await db.query(`DELETE FROM auth.users; DELETE FROM public.profiles;`);
      // Two profiles rows for the same normalized email, inserted while
      // no unique index exists — nothing stops this yet, which is the
      // whole gap this migration closes.
      const idA = (await db.query(`INSERT INTO auth.users (email) VALUES ('Dupe@Example.com') RETURNING id`)).rows[0].id;
      const idB = (await db.query(`INSERT INTO auth.users (email) VALUES ('dupe@example.com') RETURNING id`)).rows[0].id;
      // The 001 trigger already created matching profiles rows; force one
      // to the differently-cased form to simulate a real pre-existing
      // duplicate.
      await db.query(`UPDATE public.profiles SET email = 'Dupe@Example.com' WHERE id = $1`, [idA]);
      await db.query(`UPDATE public.profiles SET email = 'dupe@example.com' WHERE id = $1`, [idB]);

      await expect(db.query(migration032())).rejects.toThrow(/duplicate normalized-email group/);

      // Neither row was touched — no silent delete/merge.
      const rows = await db.query(`SELECT id, email FROM public.profiles WHERE id IN ($1, $2) ORDER BY id`, [idA, idB]);
      expect(rows.rows).toHaveLength(2);
      const idx = await db.query(`SELECT 1 FROM pg_indexes WHERE tablename = 'profiles' AND indexname = 'profiles_email_normalized_unique_idx'`);
      expect(idx.rows).toHaveLength(0);

      // Clean up the duplicate before this test's afterEach reinstalls 032
      // (which would otherwise hit the very preflight this test just
      // proved works).
      await db.query(`DELETE FROM auth.users WHERE id IN ($1, $2)`, [idA, idB]);
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
      await db.query(`DELETE FROM auth.users; DELETE FROM public.profiles;`);
    });

    it('Foo@Example.com and foo@example.com cannot both become first-party profiles', async () => {
      await db.query(`INSERT INTO auth.users (email) VALUES ('Foo@Example.com')`);
      await expect(
        db.query(`INSERT INTO auth.users (email) VALUES ('foo@example.com')`),
      ).rejects.toThrow(/profiles_email_normalized_unique_idx/);

      const count = await db.query(`SELECT count(*) FROM public.profiles WHERE lower(email) = 'foo@example.com'`);
      expect(Number(count.rows[0].count)).toBe(1);
    });

    it('a REAL concurrent signup race (two simultaneous inserts, same normalized email) — exactly one succeeds', async () => {
      // Deliberately does NOT fake the constraint the way a mocked
      // service-client test would: this fires two genuinely concurrent
      // INSERTs against the same live database and lets Postgres itself
      // arbitrate, proving the index — not application-level luck —
      // is what makes this safe.
      const c1 = await freshClient();
      const c2 = await freshClient();
      try {
        const insert = (c: PgTestClient) => c.query(`INSERT INTO auth.users (email) VALUES ('race-signup@example.com') RETURNING id`);
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
      await expect(db.query(`INSERT INTO auth.users (email) VALUES ('unique-user@example.com')`)).resolves.toBeDefined();
      const count = await db.query(`SELECT count(*) FROM public.profiles WHERE lower(email) = 'unique-user@example.com'`);
      expect(Number(count.rows[0].count)).toBe(1);
    });
  });
});
