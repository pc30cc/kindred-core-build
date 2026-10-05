/**
 * The data layer's one entry point.
 *
 * Two drivers answer the same supabase-js API:
 *
 *   * `postgres` — `DATABASE_URL` is set. The server talks straight to
 *     PostgreSQL: supabase-js keeps building the queries, and the in-process
 *     PostgREST engine (./postgrest) runs them over a `pg` pool. Any
 *     PostgreSQL 15+ works — a self-hosted one, a managed one, or the
 *     database of a Supabase project, which is then used as nothing more than
 *     PostgreSQL.
 *   * `supabase-rest` — no `DATABASE_URL`: the previous behaviour, PostgREST
 *     over HTTPS with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. Kept so an
 *     install that has not set `DATABASE_URL` yet keeps running unchanged.
 *
 * Call sites never choose: getServiceClient(), serviceClientFor() and the
 * workers' clients all come from here.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createPgFetch } from './pgFetch.js';
import { DatabasePool, databaseSettings } from './pool.js';
import { PostgrestEngine } from './postgrest/engine.js';
import { SchemaCache } from './postgrest/schemaCache.js';

export type DataDriver = 'postgres' | 'supabase-rest';

/**
 * The base URL supabase-js is handed in `postgres` mode. It is never
 * resolved — pgFetch answers every request — and `.invalid` guarantees that
 * nothing could reach a real host if it ever were.
 */
export const DIRECT_DATABASE_BASE_URL = 'http://direct-database.invalid';

export function dataDriver(env: NodeJS.ProcessEnv = process.env): DataDriver {
  return env.DATABASE_URL?.trim() ? 'postgres' : 'supabase-rest';
}

interface Direct {
  pool: DatabasePool;
  cache: SchemaCache;
  engine: PostgrestEngine;
  client: SupabaseClient;
}

let direct: Direct | null = null;

function openDirect(): Direct {
  const settings = databaseSettings();
  if (!settings) throw new Error('DATABASE_URL is not set');
  const pool = new DatabasePool(settings);
  const cache = new SchemaCache(pool, settings.schemas);
  const engine = new PostgrestEngine(pool, cache, { maxRows: settings.maxRows });
  const client = createClient(DIRECT_DATABASE_BASE_URL, 'direct-database', {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: createPgFetch(engine) },
    db: { schema: settings.schemas[0] },
  });
  return { pool, cache, engine, client };
}

function getDirect(): Direct {
  if (!direct) direct = openDirect();
  return direct;
}

/** The process-wide direct client (postgres driver only). */
export function directDataClient(): SupabaseClient {
  return getDirect().client;
}

/** The raw pool (postgres driver only) — for health checks and tooling. */
export function directPool(): DatabasePool {
  return getDirect().pool;
}

const restClients = new Map<string, SupabaseClient>();

/**
 * A server-side client for `(url, key)` under the `supabase-rest` driver, or
 * the direct client under `postgres` (the arguments are then irrelevant —
 * there is one database).
 */
export function dataClientFor(supabaseUrl: string, serviceRoleKey: string): SupabaseClient {
  if (dataDriver() === 'postgres') return directDataClient();
  const id = `${supabaseUrl}\u0000${serviceRoleKey}`;
  let client = restClients.get(id);
  if (!client) {
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error('Set DATABASE_URL (or, for the legacy REST driver, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)');
    }
    client = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
    restClients.set(id, client);
  }
  return client;
}

/** The client for the environment's own database, whichever driver applies. */
export function dataClientFromEnv(env: NodeJS.ProcessEnv = process.env): SupabaseClient {
  if (dataDriver(env) === 'postgres') return directDataClient();
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error('DATABASE_URL is required (or, for the legacy REST driver, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)');
  }
  return dataClientFor(url, key);
}

/** True when this process can reach its database by either driver. */
export function databaseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return dataDriver(env) === 'postgres' || (!!env.SUPABASE_URL?.trim() && !!env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

/** Closes the direct pool (tests, graceful shutdown). */
export async function closeDataLayer(): Promise<void> {
  const d = direct;
  direct = null;
  restClients.clear();
  if (d) await d.pool.end();
}
