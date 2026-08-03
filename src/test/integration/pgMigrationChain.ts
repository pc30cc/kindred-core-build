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

/** Migration chain HEAD, in apply order. */
export const MIGRATION_CHAIN = [
  'database/migrations/007_entitlement_fanout_jobs.sql',
  'database/migrations/008_entitlement_fanout_generations.sql',
  'database/migrations/009_fanout_cursor_generation_and_ai_kb_tx.sql',
  'database/migrations/010_fanout_rpc_security_and_kb_state_machine.sql',
];

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
export async function resetManagedFunctions(db: any): Promise<void> {
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

/** Applies the chain in order from a clean function namespace. */
export async function installMigrationChain(db: any, files = MIGRATION_CHAIN): Promise<void> {
  await resetManagedFunctions(db);
  for (const file of files) {
    await db.query(readFileSync(resolve(process.cwd(), file), 'utf8'));
  }
}
