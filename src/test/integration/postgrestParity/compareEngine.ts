/**
 * Runs the parity cases through the in-process engine and diffs them against
 * expected.json. `npx tsx src/test/integration/postgrestParity/compareEngine.ts`
 * with PARITY_DATABASE_URL set prints every case that differs; the vitest
 * suite (postgrestEngineParity.pg.test.ts) asserts the same thing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { DatabasePool, databaseSettings } from '../../../../server/db/pool';
import { PostgrestEngine } from '../../../../server/db/postgrest/engine';
import { SchemaCache } from '../../../../server/db/postgrest/schemaCache';
import { createPgFetch } from '../../../../server/db/pgFetch';
import { FIXTURE_SQL, PARITY_DIR, SEED_SQL, runCases } from './runner';
import type { Sb } from './cases';

export async function engineResults(dsn: string) {
  // Fixture and seed go in as the login role; the engine's pool runs as
  // service_role, like the server.
  const admin = new pg.Client({ connectionString: dsn });
  await admin.connect();
  // The roles the fixture grants to (and the engine assumes), as on any
  // database the migrations built.
  await admin.query(readFileSync(join(process.cwd(), 'database', 'migrations', '000_selfhost_roles_bootstrap.sql'), 'utf8'));
  await admin.query(FIXTURE_SQL);
  const settings = databaseSettings({ DATABASE_URL: dsn, DATABASE_SCHEMAS: 'pgrst_parity' })!;
  const pool = new DatabasePool(settings);
  const engine = new PostgrestEngine(pool, new SchemaCache(pool, settings.schemas), { maxRows: settings.maxRows });
  const sb = createClient('http://direct-database.invalid', 'direct-database', {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'pgrst_parity' },
    global: { fetch: createPgFetch(engine) },
  }) as unknown as Sb;
  try {
    return await runCases(sb, async () => {
      await admin.query(SEED_SQL);
    });
  } finally {
    await pool.end();
    await admin.end();
  }
}

export function expectedResults(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PARITY_DIR, 'expected.json'), 'utf8')).results;
}

async function main() {
  const dsn = process.env.PARITY_DATABASE_URL;
  if (!dsn) throw new Error('PARITY_DATABASE_URL is required');
  const got = await engineResults(dsn);
  const want = expectedResults();
  let bad = 0;
  for (const name of Object.keys(want)) {
    if (!isDeepStrictEqual(JSON.stringify(got[name]), JSON.stringify(want[name]))) {
      bad++;
      console.log(`\n✗ ${name}\n  want: ${JSON.stringify(want[name])}\n  got:  ${JSON.stringify(got[name])}`);
    }
  }
  console.log(`\n${Object.keys(want).length - bad}/${Object.keys(want).length} cases match`);
  process.exit(bad ? 1 : 0);
}

if (process.argv[1]?.endsWith('compareEngine.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
