/**
 * Minimal `auth` schema stub for running the self-host migration chain
 * against plain PostgreSQL in a test environment with no Supabase/GoTrue
 * instance available (see aiKbTailMigrationCompatibility.pg.test.ts's own
 * disclaimer — the real, complete chain is proven by the dedicated CI jobs
 * that run against the actual `supabase/postgres` image, which already
 * ships a real `auth` schema).
 *
 * Every statement here is `IF NOT EXISTS`/`CREATE OR REPLACE`, so running
 * this against a database that ALREADY has a real `auth` schema (i.e. real
 * CI) is a harmless no-op, not a conflict.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROLE_BOOTSTRAP, type PgQueryable } from './pgMigrationChain';

export async function applyAuthSchemaStub(db: PgQueryable): Promise<void> {
  await db.query(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      encrypted_password text,
      email_confirmed_at timestamptz,
      phone text,
      raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
    CREATE TABLE IF NOT EXISTS auth.sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      refreshed_at timestamptz,
      not_after timestamptz,
      user_agent text,
      ip inet
    );
  `);
}

/**
 * Ensures the full self-host migration chain (000 through the newest
 * 0NN_*.sql, NO exclusions — every file in database/migrations/ applies,
 * matching the real production/CI contract exactly) is installed on `db`,
 * safe to call from MULTIPLE test files sharing ONE database in the same
 * CI run (this repo's "Integration tests" job runs every src/test/integration
 * .pg.test.ts file — except the dedicated AI-KB-tail one — against a single
 * shared `app` database with --no-file-parallelism).
 *
 * 017 and 018 previously required exclusion here: each referenced a table
 * (`widget_smart_rules` / `call_sessions`) no earlier self-host migration
 * created, so the chain could never actually apply past 016 on a truly
 * fresh database — self-host could never have completed first-run
 * migration at all. Both files now carry their own real, current-final
 * hosted-derived base schema (Smart Engagement tables for 017; Call
 * Center's call_sessions/call_queue_entries for 018) ported ahead of their
 * original ALTER logic, so the chain applies end to end with zero
 * exclusions — see each file's own top-of-file comment for the full
 * root-cause trace and scope decisions.
 *
 * 001-023 contain non-idempotent DDL (bare `CREATE POLICY`, no `IF NOT
 * EXISTS`) — by design, since a real deployment only ever runs each
 * migration once. Re-running them because a SECOND test file's beforeAll
 * shares the database a FIRST file's beforeAll already set up would fail
 * with "policy already exists". So this only installs that base range
 * once per database (guarded by `to_regclass('public.profiles')`), then
 * ALWAYS (re)applies 024+ — those are all `CREATE TABLE IF NOT EXISTS` /
 * `DROP POLICY IF EXISTS; CREATE POLICY` / `CREATE OR REPLACE FUNCTION`,
 * deliberately safe to apply repeatedly, which is exactly what lets
 * multiple auth .pg.test.ts files each reason about 024-032 in isolation
 * without needing to coordinate who "owns" installing them.
 */
export async function ensureAuthChainInstalled(db: PgQueryable): Promise<void> {
  await applyAuthSchemaStub(db);

  const dir = resolve(process.cwd(), 'database/migrations');
  const allFiles = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await db.query(`SELECT to_regclass('public.profiles') IS NOT NULL AS installed`);
  const baseAlreadyInstalled = !!rows[0]?.installed;

  const baseFiles = allFiles.filter((f) => Number(f.slice(0, 3)) < 24);
  const authFiles = allFiles.filter((f) => Number(f.slice(0, 3)) >= 24);

  if (!baseAlreadyInstalled) {
    await db.query(readFileSync(resolve(process.cwd(), ROLE_BOOTSTRAP), 'utf8'));
    for (const file of baseFiles.filter((f) => `database/migrations/${f}` !== ROLE_BOOTSTRAP)) {
      await db.query(readFileSync(resolve(dir, file), 'utf8'));
    }
  }

  for (const file of authFiles) {
    await db.query(readFileSync(resolve(dir, file), 'utf8'));
  }
}
