/**
 * Shared helper for the PostgreSQL integration suites.
 *
 * Every suite installs the forward-only migration chain into the SAME database
 * (CI runs them with --no-file-parallelism). A suite that re-applies an older
 * migration on top of a newer one recreates a stale function overload and the
 * next `CREATE FUNCTION` fails with "is not unique" / "cannot change return
 * type". Real deployments never do this — a runner applies each migration
 * exactly once — so the suites reset the namespace first and install the chain
 * from scratch.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Idempotent Supabase-compatible role bootstrap. Migration 011 (shipped, thus
 * unmodifiable) legitimately assumes `anon`/`authenticated`/`service_role`
 * exist, so every stock-PostgreSQL install must apply this first.
 */
export const ROLE_BOOTSTRAP = 'database/migrations/000_selfhost_roles_bootstrap.sql';

/** AI-KB / fan-out TAIL, in apply order. */
export const AI_KB_TAIL_MIGRATIONS = [
  'database/migrations/007_entitlement_fanout_jobs.sql',
  'database/migrations/008_entitlement_fanout_generations.sql',
  'database/migrations/009_fanout_cursor_generation_and_ai_kb_tx.sql',
  'database/migrations/010_fanout_rpc_security_and_kb_state_machine.sql',
  'database/migrations/011_ai_kb_slug_namespace_lock.sql',
  'database/migrations/012_ai_kb_acl_reassert_guarded.sql',
  'database/migrations/013_public_schema_create_lockdown.sql',
];

/** Back-compat alias: the tail without the bootstrap. */
export const MIGRATION_CHAIN = AI_KB_TAIL_MIGRATIONS;

/**
 * The AI-KB TAIL plus the role bootstrap, applied exactly once. Used by the
 * tail-compatibility suite, which must NOT reset functions and must NOT
 * inherit roles or schema from another suite. This is NOT the full production
 * chain — 001–003 require Supabase's `auth` schema and are proven by the
 * dedicated CI jobs.
 */
export const CLEAN_INSTALL_CHAIN = [ROLE_BOOTSTRAP, ...AI_KB_TAIL_MIGRATIONS];

/**
 * Minimal structural type for a connected `pg` client. `rowCount` is part of
 * every real `pg` QueryResult (null for statements that report no count) and
 * is what the atomic-claim/single-use tests assert on, so it belongs in the
 * structural type rather than being cast away at each call site.
 */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}


/**
 * Statements PostgreSQL refuses inside a transaction block. `psql -f` — how
 * scripts/migrate-database.sh and the CI replay jobs apply the self-host
 * chain — autocommits every statement, so a migration may use them; a file
 * sent as ONE query runs as one implicit transaction instead, where they fail
 * with "cannot run inside a transaction block". An index statement holds no
 * semicolon of its own, so the first one ends it.
 */
const NON_TRANSACTIONAL_STATEMENT = /^[ \t]*(?:create[ \t]+(?:unique[ \t]+)?|drop[ \t]+)index[ \t]+concurrently\b[^;]*;/gim;

/** True when `sql` holds nothing but whitespace and comments. */
function isBlankSql(sql: string): boolean {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim() === '';
}

/**
 * Applies one migration file's SQL as `psql -f` would, as far as the chain
 * depends on it: each non-transactional statement (above) is sent on its own,
 * and the SQL around it as one query, exactly as before, in file order.
 */
export async function applyMigrationSql(db: PgQueryable, sql: string): Promise<void> {
  const parts: string[] = [];
  let rest = 0;
  for (const match of sql.matchAll(NON_TRANSACTIONAL_STATEMENT)) {
    const at = match.index ?? 0;
    parts.push(sql.slice(rest, at), match[0]);
    rest = at + match[0].length;
  }
  parts.push(sql.slice(rest));
  for (const part of parts) {
    if (!isBlankSql(part)) await db.query(part);
  }
}

/** Applies files in exact order WITHOUT resetting anything first. */
export async function applyChainClean(db: PgQueryable, files = CLEAN_INSTALL_CHAIN): Promise<void> {
  for (const file of files) {
    await db.query(readFileSync(resolve(process.cwd(), file), 'utf8'));
  }
}

const MANAGED_FUNCTIONS = [
  'enqueue_entitlement_fanout',
  'claim_entitlement_fanout_jobs',
  'advance_entitlement_fanout',
  'complete_entitlement_fanout',
  'fail_entitlement_fanout',
  'entitlement_fanout_touch',
  '_ai_kb_apply_generated',
  'accept_ai_kb_generated_article',
  'publish_ai_kb_generated_article',
  'reject_ai_kb_generated_article',
];

/** Drops every overload of every function this chain owns. */
export async function resetManagedFunctions(db: PgQueryable): Promise<void> {
  await db.query(`
    DO $reset$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT oid::regprocedure AS sig FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname = ANY (ARRAY[${MANAGED_FUNCTIONS.map((f) => `'${f}'`).join(', ')}])
      LOOP
        EXECUTE 'DROP FUNCTION ' || r.sig || ' CASCADE';
      END LOOP;
    END
    $reset$;
  `);
}

/**
 * Applies the role bootstrap, then the chain in order from a clean function
 * namespace. The bootstrap is idempotent, so suites sharing one database never
 * depend on another suite having created the roles.
 */
export async function installMigrationChain(
  db: PgQueryable,
  files = AI_KB_TAIL_MIGRATIONS,
): Promise<void> {
  await db.query(readFileSync(resolve(process.cwd(), ROLE_BOOTSTRAP), 'utf8'));
  await resetManagedFunctions(db);
  for (const file of files.filter((f) => f !== ROLE_BOOTSTRAP)) {
    await db.query(readFileSync(resolve(process.cwd(), file), 'utf8'));
  }
}
