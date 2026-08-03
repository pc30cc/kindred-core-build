/**
 * Phase 6-S5-R7.5 §3 — AI-KB TAIL migration compatibility.
 *
 * Scope, stated honestly: this suite applies the role bootstrap (000) and the
 * AI-KB / fan-out TAIL (007 → 012) onto a fresh database, with no function
 * reset and no handcrafted schema. It proves the tail is self-consistent and
 * role-portable on stock PostgreSQL.
 *
 * It is NOT full-chain evidence and must never be cited as such: migrations
 * 001–003 need Supabase's `auth` schema, so the complete chains are proven by
 * the dedicated CI jobs — "Hosted Supabase full migration chain"
 * (supabase CLI + supabase/migrations) and "Self-host full migration chain"
 * (supabase/postgres + database/migrations 000→012).
 *
 * Driven by TAIL_MIGRATION_DATABASE_URL (or the legacy
 * CLEAN_INSTALL_DATABASE_URL / TEST_DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CLEAN_INSTALL_CHAIN, applyChainClean, type PgQueryable } from './pgMigrationChain';

const DSN =
  process.env.TAIL_MIGRATION_DATABASE_URL ||
  process.env.CLEAN_INSTALL_DATABASE_URL ||
  process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type PgTestClient = PgQueryable & { connect(): Promise<void>; end(): Promise<void> };

let db: PgTestClient;

suite('AI-KB tail migration compatibility (000 + 007→012, plain PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    db = new Client({ connectionString: DSN }) as unknown as PgTestClient;
    await db.connect();
  });

  afterAll(async () => { if (db) await db.end(); });

  it('applies the tail in filename order without a function reset', async () => {
    await expect(applyChainClean(db, CLEAN_INSTALL_CHAIN)).resolves.toBeUndefined();
  });

  it('creates the three no-login Supabase-compatible roles', async () => {
    const { rows } = await db.query(
      `SELECT rolname, rolcanlogin, rolsuper FROM pg_roles
       WHERE rolname IN ('anon','authenticated','service_role') ORDER BY rolname`,
    );
    expect(rows.map((r) => r.rolname)).toEqual(['anon', 'authenticated', 'service_role']);
    for (const r of rows) {
      expect(r.rolcanlogin).toBe(false);
      expect(r.rolsuper).toBe(false);
    }
  });

  it('leaves no SECURITY DEFINER function in public executable by PUBLIC', async () => {
    const { rows } = await db.query(`
      SELECT proname FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND prosecdef
        AND (proacl IS NULL OR proacl::text ~ '(^|,)=X')
    `);
    expect(rows.map((r) => r.proname)).toEqual([]);
  });

  it('lets service_role — and only service_role — execute the internal AI-KB RPCs', async () => {
    const fns = [
      'public._ai_kb_apply_generated(uuid, uuid, uuid, text, text, text, text)',
      'public.accept_ai_kb_generated_article(uuid, uuid, uuid)',
      'public.publish_ai_kb_generated_article(uuid, uuid, uuid)',
      'public.reject_ai_kb_generated_article(uuid, uuid, uuid)',
    ];
    for (const fn of fns) {
      const { rows } = await db.query(
        `SELECT to_regprocedure($1) IS NOT NULL AS present,
                has_function_privilege('service_role', $1, 'EXECUTE') AS svc,
                has_function_privilege('authenticated', $1, 'EXECUTE') AS auth,
                has_function_privilege('anon', $1, 'EXECUTE') AS anon`,
        [fn],
      );
      if (!rows[0].present) continue;
      expect(rows[0].svc).toBe(true);
      expect(rows[0].auth).toBe(false);
      expect(rows[0].anon).toBe(false);
    }
  });
});
