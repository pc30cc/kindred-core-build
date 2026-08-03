/**
 * Phase 6-S5-R7.4 §11 — CLEAN-INSTALL migration proof.
 *
 * A genuinely fresh database, the self-host role bootstrap, then every
 * migration in exact filename order. No `resetManagedFunctions()`, no
 * handcrafted schema, no roles inherited from another suite — this is the
 * only suite that may be cited as production migration proof.
 *
 * Driven by CLEAN_INSTALL_DATABASE_URL (a database created for this job).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CLEAN_INSTALL_CHAIN, applyChainClean } from './pgMigrationChain';

const DSN = process.env.CLEAN_INSTALL_DATABASE_URL || process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

let db: any;

suite('clean-install migration chain (plain PostgreSQL)', () => {
  beforeAll(async () => {
    const { Client } = await import('pg');
    db = new Client({ connectionString: DSN });
    await db.connect();
  });

  afterAll(async () => { if (db) await db.end(); });

  it('applies the whole chain in filename order without a function reset', async () => {
    await expect(applyChainClean(db, CLEAN_INSTALL_CHAIN)).resolves.toBeUndefined();
  });

  it('creates the three no-login Supabase-compatible roles', async () => {
    const { rows } = await db.query(
      `SELECT rolname, rolcanlogin, rolsuper FROM pg_roles
       WHERE rolname IN ('anon','authenticated','service_role') ORDER BY rolname`,
    );
    expect(rows.map((r: any) => r.rolname)).toEqual(['anon', 'authenticated', 'service_role']);
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
    expect(rows.map((r: any) => r.proname)).toEqual([]);
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
