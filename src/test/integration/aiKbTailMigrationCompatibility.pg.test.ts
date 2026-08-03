/**
 * Phase 6-S5-R7.5 §3 — AI-KB TAIL migration compatibility.
 *
 * Scope, stated honestly: this suite applies the role bootstrap (000) and the
 * AI-KB / fan-out TAIL (007 → 013) onto a fresh database, with no function
 * reset and no handcrafted schema. It proves the tail is self-consistent and
 * role-portable on stock PostgreSQL.
 *
 * It is NOT full-chain evidence and must never be cited as such: migrations
 * 001–003 need Supabase's `auth` schema, so the complete chains are proven by
 * the dedicated CI jobs — "Hosted Supabase full migration chain"
 * (supabase CLI + supabase/migrations) and "Self-host full migration chain"
 * (supabase/postgres + database/migrations 000→013).
 *
 * Driven by TAIL_MIGRATION_DATABASE_URL (or the legacy
 * CLEAN_INSTALL_DATABASE_URL / TEST_DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CLEAN_INSTALL_CHAIN, applyChainClean, type PgQueryable } from './pgMigrationChain';
import { internalRpcSignatures } from './internalRpcInventory';

const DSN =
  process.env.TAIL_MIGRATION_DATABASE_URL ||
  process.env.CLEAN_INSTALL_DATABASE_URL ||
  process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type PgTestClient = PgQueryable & { connect(): Promise<void>; end(): Promise<void> };

let db: PgTestClient;

suite('AI-KB tail migration compatibility (000 + 007→013, plain PostgreSQL)', () => {
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
    // Derived from the SINGLE source of truth, never hand-typed here.
    const fns = internalRpcSignatures('ai_kb');
    expect(fns).toHaveLength(4);
    for (const fn of fns) {
      const { rows } = await db.query(
        `SELECT to_regprocedure($1) IS NOT NULL AS present,
                has_function_privilege('service_role', $1, 'EXECUTE') AS svc,
                has_function_privilege('authenticated', $1, 'EXECUTE') AS auth,
                has_function_privilege('anon', $1, 'EXECUTE') AS anon`,
        [fn],
      );
      expect(rows[0].present).toBe(true);
      expect(rows[0].svc).toBe(true);
      expect(rows[0].auth).toBe(false);
      expect(rows[0].anon).toBe(false);
    }
  });

  it('installs migration 013 and every canonical internal RPC signature', async () => {
    const sigs = internalRpcSignatures();
    expect(sigs).toHaveLength(9);
    const { rows } = await db.query(
      `SELECT s AS sig, to_regprocedure(s) IS NOT NULL AS present
         FROM unnest($1::text[]) AS s`,
      [sigs],
    );
    expect(rows.filter((r) => !r.present)).toEqual([]);

    // 013 revokes CREATE on schema public from PUBLIC and the customer roles.
    const { rows: posture } = await db.query(`
      SELECT (SELECT EXISTS (
                SELECT 1 FROM pg_namespace n
                CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
                WHERE n.nspname = 'public' AND acl.grantee = 0
                  AND acl.privilege_type = 'CREATE')) AS public_can_create,
             has_schema_privilege('anon', 'public', 'CREATE') AS anon_create,
             has_schema_privilege('authenticated', 'public', 'CREATE') AS auth_create,
             has_schema_privilege('anon', 'public', 'USAGE') AS anon_usage,
             has_schema_privilege('authenticated', 'public', 'USAGE') AS auth_usage
    `);
    expect(posture[0]).toEqual({
      public_can_create: false,
      anon_create: false,
      auth_create: false,
      anon_usage: true,
      auth_usage: true,
    });
  });
});

describe('tail chain definition', () => {
  it('applies the role bootstrap exactly once and ends at 013', () => {
    expect(CLEAN_INSTALL_CHAIN.filter((f) => f.includes('000_'))).toHaveLength(1);
    expect(CLEAN_INSTALL_CHAIN[0]).toContain('000_selfhost_roles_bootstrap');
    expect(CLEAN_INSTALL_CHAIN.at(-1)).toContain('013_public_schema_create_lockdown');
  });
});
