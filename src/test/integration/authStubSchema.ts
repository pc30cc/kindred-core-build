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
 * `public.call_center_settings` — 101_call_widget_presentation_contract.sql
 * ALTERs/UPDATEs this table, but unlike every other table the self-host
 * chain touches, it (and `platform_call_center_settings`) is only ever
 * CREATEd in supabase/migrations/ (the hosted-only mirror), never in
 * database/migrations/ (the self-host chain) — a genuine, unclosed
 * self-host/hosted parity gap (unlike the 017/018/047/056/064/067 gaps
 * documented above, which 016a/084 actually closed). A real self-host
 * deployment replaying database/migrations/*.sql in order hits this exact
 * "relation does not exist" failure today; fixing it for real means adding
 * a dedicated self-host migration that faithfully reconstructs the table
 * from its full hosted history (10+ migrations of column/constraint/RLS
 * evolution, including a real anon-read-access tightening) — out of scope
 * for a test-schema stub. This stub only lets the self-host chain replay
 * far enough in a test database for unrelated suites to exercise
 * migrations after it; it is not a substitute for that follow-up.
 */
async function applyCallCenterSettingsStub(db: PgQueryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.call_center_settings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL UNIQUE,
      offline_behavior text NOT NULL DEFAULT 'callback',
      widget_theme jsonb NOT NULL DEFAULT '{}'::jsonb,
      pre_call_form_schema jsonb NOT NULL DEFAULT '[]'::jsonb
    );
  `);
}

/**
 * `public.platform_branding` (104_platform_ui_defaults.sql) and
 * `public.billing_payments.amount`/`.refund_amount` (105_billing_payment_
 * state_machine.sql) — the SAME kind of self-host/hosted parity gap as
 * `call_center_settings` above (created with full history only in
 * supabase/migrations/, never in database/migrations/), discovered while
 * verifying the SEO feature's own migration (121_seo_audit_core.sql)
 * replays against the full chain. Same rationale, same scope: unblocks the
 * chain far enough for unrelated suites to run; not a substitute for a real
 * self-host migration reconstructing either table's full hosted history.
 */
async function applyBillingAndBrandingGapStubs(db: PgQueryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.platform_branding (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid()
    );
    CREATE TABLE IF NOT EXISTS public.billing_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid,
      amount bigint,
      refund_amount bigint DEFAULT 0,
      provider_name text,
      provider_payment_id text,
      payment_intent_id uuid,
      purchase_type text,
      action_type text,
      plan_id uuid,
      plan_name_snapshot text,
      billing_interval text,
      paid_at timestamptz,
      invoice_number text,
      created_at timestamptz DEFAULT now()
    );
  `);
}

/**
 * database/migrations/*.sql in filename order, with NO exclusions.
 *
 * 017 and 018 used to be skipped here: they reference base product tables
 * (`widget_smart_rules` for 017, `call_sessions`/`call_queue_entries` for
 * 018) that no earlier self-host migration created, so a fresh, unexcluded
 * chain failed at 017 with "relation public.widget_smart_rules does not
 * exist". That gap — plus the same one behind 047/056/064/067
 * (`billing_plans`, `ai_agent_settings`, `widget_prechat_settings`) — is now
 * closed by `016a_selfhost_product_parity_base_tables.sql` and
 * `084_selfhost_parity_table_policies.sql`, so the whole chain replays
 * against an empty database with ON_ERROR_STOP=1 and this set is empty.
 *
 * Keep it (rather than deleting it) so a future, genuinely unavoidable
 * exclusion has one documented place to live instead of being scattered.
 */
export const AUTH_CHAIN_EXCLUDED_FILES = new Set<string>([]);


/**
 * Ensures the full auth-relevant self-host migration chain (000 through the
 * newest 0NN_*.sql, minus AUTH_CHAIN_EXCLUDED_FILES) is installed on `db`,
 * safe to call from MULTIPLE test files sharing ONE database in the same
 * CI run (this repo's "Integration tests" job runs every src/test/integration
 * .pg.test.ts file — except the dedicated AI-KB-tail one — against a single
 * shared `app` database with --no-file-parallelism).
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
  await applyCallCenterSettingsStub(db);
  await applyBillingAndBrandingGapStubs(db);

  const dir = resolve(process.cwd(), 'database/migrations');
  const allFiles = readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !AUTH_CHAIN_EXCLUDED_FILES.has(f))
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
