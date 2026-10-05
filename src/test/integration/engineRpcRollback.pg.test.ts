// @vitest-environment node
/**
 * A function that writes and returns rows, called through the in-process
 * PostgREST engine with `.single()` / `.maybeSingle()` / an exact count: when
 * the response is an error (not exactly one row, an offset past the end), the
 * function's writes must not survive — PostgREST runs the request in one
 * transaction and rolls it back, and so must the engine.
 *
 * Real PostgreSQL, real function, real rows; no mocks. Driven by
 * TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DatabasePool, databaseSettings } from '../../../server/db/pool';
import { PostgrestEngine } from '../../../server/db/postgrest/engine';
import { SchemaCache } from '../../../server/db/postgrest/schemaCache';
import { createPgFetch } from '../../../server/db/pgFetch';

const DSN = process.env.TEST_DATABASE_URL;

const suite = DSN ? describe : describe.skip;
const SCHEMA = 'engine_rpc_rollback';

suite('engine: a writing RPC whose response fails leaves nothing behind', () => {
  let admin: pg.Client;
  let pool: DatabasePool;
  // A schema outside the generated Database types, as the parity suite types it.
  let sb: Pick<SupabaseClient, 'from' | 'rpc'>;

  const notes = async () => (await admin.query(`SELECT note FROM ${SCHEMA}.ledger ORDER BY id`)).rows.map((r) => r.note);
  const nextId = async () => (await admin.query(`SELECT nextval('${SCHEMA}.ledger_id_seq')::int AS v`)).rows[0].v;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: DSN });
    await admin.connect();
    await admin.query(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.ledger (id serial PRIMARY KEY, note text NOT NULL);
      CREATE FUNCTION ${SCHEMA}.take(_n int) RETURNS SETOF ${SCHEMA}.ledger LANGUAGE sql AS $$
        INSERT INTO ${SCHEMA}.ledger (note) SELECT 'take-' || g FROM generate_series(1, _n) g RETURNING *
      $$;
      CREATE FUNCTION ${SCHEMA}.take_notes(_n int) RETURNS SETOF text LANGUAGE sql AS $$
        INSERT INTO ${SCHEMA}.ledger (note) SELECT 'note-' || g FROM generate_series(1, _n) g RETURNING note
      $$;
      GRANT USAGE ON SCHEMA ${SCHEMA} TO PUBLIC;
      GRANT ALL ON ALL TABLES IN SCHEMA ${SCHEMA} TO PUBLIC;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO PUBLIC;
    `);
    const settings = databaseSettings({ DATABASE_URL: DSN, DATABASE_SCHEMAS: SCHEMA, DATABASE_ROLE: 'none' })!;
    pool = new DatabasePool(settings);
    const engine = new PostgrestEngine(pool, new SchemaCache(pool, settings.schemas), { maxRows: settings.maxRows });
    sb = createClient('http://direct-database.invalid', 'direct-database', {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: SCHEMA },
      global: { fetch: createPgFetch(engine) },
    }) as unknown as Pick<SupabaseClient, 'from' | 'rpc'>;
  });

  beforeEach(async () => {
    await admin.query(`TRUNCATE ${SCHEMA}.ledger RESTART IDENTITY`);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('several rows + .single(): PGRST116, and none of the rows is kept', async () => {
    const r = await sb.rpc('take', { _n: 3 }).single();
    expect(r.status).toBe(406);
    expect(r.error?.code).toBe('PGRST116');
    expect(r.error?.details).toBe('The result contains 3 rows');
    expect(await notes()).toEqual([]);
  });

  it('zero rows + .single(): PGRST116, nothing written', async () => {
    const r = await sb.rpc('take', { _n: 0 }).single();
    expect(r.error?.code).toBe('PGRST116');
    expect(await notes()).toEqual([]);
  });

  it('exactly one row + .single(): the row, and it is kept', async () => {
    const r = await sb.rpc('take', { _n: 1 }).single();
    expect(r.error).toBeNull();
    expect(r.data).toEqual({ id: 1, note: 'take-1' });
    expect(await notes()).toEqual(['take-1']);
  });

  // .maybeSingle() is enforced by supabase-js, not by the server: it asks for
  // a plain array and raises PGRST116 itself when there is more than one row.
  // The server never saw a single-object request, so the writes stay —
  // PostgREST 14.5 keeps them too (recorded in postgrestParity/expected.json,
  // 'rpc writes setof maybeSingle many rows'). Callers that must not keep a
  // multi-row write use .single().
  it('several rows + .maybeSingle(): the client-side error, and — as in PostgREST — the rows stay', async () => {
    const r = await sb.rpc('take', { _n: 2 }).maybeSingle();
    expect(r.error?.code).toBe('PGRST116');
    expect(r.error?.message).toBe('JSON object requested, multiple (or no) rows returned');
    expect(await notes()).toEqual(['take-1', 'take-2']);
  });

  it('a scalar set-returning function behaves the same', async () => {
    const r = await sb.rpc('take_notes', { _n: 2 }).single();
    expect(r.error?.code).toBe('PGRST116');
    expect(await notes()).toEqual([]);
  });

  it('called again after a failure: only the later, successful call is kept', async () => {
    const failed = await sb.rpc('take', { _n: 2 }).single();
    expect(failed.error?.code).toBe('PGRST116');
    const ok = await sb.rpc('take', { _n: 1 }).single();
    expect(ok.error).toBeNull();
    // The failed call's ids were consumed (sequences are not transactional,
    // in PostgREST too) but its rows are gone.
    expect(ok.data).toEqual({ id: 3, note: 'take-1' });
    expect(await notes()).toEqual(['take-1']);
    expect(await nextId()).toBe(4);
  });

  it('without .single() the rows are kept and returned', async () => {
    const r = await sb.rpc('take', { _n: 2 });
    expect(r.error).toBeNull();
    expect(r.data).toEqual([
      { id: 1, note: 'take-1' },
      { id: 2, note: 'take-2' },
    ]);
    expect(await notes()).toEqual(['take-1', 'take-2']);
  });

  it('an exact count with an offset past the end: 416, and the writes are rolled back', async () => {
    const r = await sb.rpc('take', { _n: 2 }, { count: 'exact' }).range(5, 9);
    expect(r.status).toBe(416);
    expect(r.error?.code).toBe('PGRST103');
    expect(await notes()).toEqual([]);
  });

  it('an exact count runs the function once', async () => {
    const r = await sb.rpc('take', { _n: 3 }, { count: 'exact' }).range(0, 1);
    expect(r.status).toBe(206);
    expect(r.count).toBe(3);
    expect(r.data).toHaveLength(2);
    expect(await notes()).toEqual(['take-1', 'take-2', 'take-3']);
  });
});
