/**
 * Records expected.json from a real PostgREST.
 *
 *   1. Create a database with database/migrations/000*.sql and fixture.sql.
 *   2. Run the PostgREST version production runs (the application_name of
 *      its connections in pg_stat_activity — 14.5 when this was last
 *      recorded) against it with db-schemas = "pgrst_parity" and a
 *      JWT secret; mint a service_role token.
 *   3. PARITY_DATABASE_URL=postgres://... POSTGREST_REFERENCE_URL=http://host:port \
 *      POSTGREST_REFERENCE_JWT=<token> npx tsx src/test/integration/postgrestParity/record.ts
 *
 * Re-record only when moving the reference to a new PostgREST version, and
 * say which one in the commit.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { PARITY_DIR, SEED_SQL, STATE_SQL, runCases } from './runner';
import type { Sb } from './cases';

async function main() {
  const dsn = process.env.PARITY_DATABASE_URL;
  const base = process.env.POSTGREST_REFERENCE_URL;
  const jwt = process.env.POSTGREST_REFERENCE_JWT;
  if (!dsn || !base || !jwt) throw new Error('PARITY_DATABASE_URL, POSTGREST_REFERENCE_URL and POSTGREST_REFERENCE_JWT are required');

  const db = new pg.Client({ connectionString: dsn });
  await db.connect();
  // The state snapshots format timestamps in the session's zone; UTC, as the
  // engine's own sessions and Supabase's default.
  await db.query("SET TimeZone TO 'UTC'");
  const sb = createClient('http://reference.invalid', jwt, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'pgrst_parity' },
    global: {
      fetch: (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return fetch(`${base}${url.pathname.replace(/^\/rest\/v1/, '')}${url.search}`, init);
      },
    },
  }) as unknown as Sb;
  const results = await runCases(
    sb,
    async () => {
      await db.query(SEED_SQL);
    },
    async () => (await db.query(STATE_SQL)).rows[0].state,
  );
  const version = (await fetch(`${base}/`, { headers: { Authorization: `Bearer ${jwt}` } })).headers.get('server');
  writeFileSync(
    join(PARITY_DIR, 'expected.json'),
    `${JSON.stringify({ recordedWith: version ?? 'PostgREST', results }, null, 2)}\n`,
  );
  await db.end();
  console.log(`recorded ${Object.keys(results).length} cases from ${version ?? base}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
