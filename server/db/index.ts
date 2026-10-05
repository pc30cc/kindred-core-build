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
 * workers' clients all come from here. Which one applies, and whether any
 * Supabase service may be used at all, is DATABASE_MODE (./mode.ts).
 */
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { platformSigningSecret } from '../lib/platformSecret.js';
import { databaseMode } from './mode.js';
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

export { databaseMode, ignoredSupabaseVars, type DatabaseMode } from './mode.js';

export function dataDriver(env: NodeJS.ProcessEnv = process.env): DataDriver {
  return databaseMode(env) === 'supabase-rest' ? 'supabase-rest' : 'postgres';
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
    // No db.schema: a request without a profile header lands in the first of
    // DATABASE_SCHEMAS, exactly as PostgREST treats db-schemas.
    global: { fetch: createPgFetch(engine) },
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
  servicesClient = undefined;
  if (d) await d.pool.end();
}

/**
 * The two legacy ServerConfig fields a worker that builds its config by hand
 * needs, for whichever driver applies. Under `postgres` they no longer select
 * a database (see ServerConfig.supabaseUrl); the key carries the platform
 * signing secret, or — when a worker has none — a random per-process value, so
 * nothing it might sign could be forged from a known constant.
 */
export function workerDatabaseConfig(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): { supabaseUrl: string; supabaseServiceRoleKey: string; signingSecret: string } {
  if (dataDriver(env) === 'postgres') {
    const signingSecret = platformSigningSecret(env) || randomBytes(32).toString('hex');
    // postgres-only hands the worker nothing of Supabase's, set or not.
    const services = databaseMode(env) === 'postgres+supabase-services';
    return {
      supabaseUrl: (services && env.SUPABASE_URL?.trim()) || DIRECT_DATABASE_BASE_URL,
      supabaseServiceRoleKey: (services && env.SUPABASE_SERVICE_ROLE_KEY) || signingSecret,
      signingSecret,
    };
  }
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(`${label} DATABASE_URL is required (or SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the legacy REST driver)`);
  }
  return { supabaseUrl, supabaseServiceRoleKey, signingSecret: platformSigningSecret(env) };
}

let servicesClient: SupabaseClient | null | undefined;

/**
 * A client for Supabase's own HTTP services — Auth admin and Realtime — or
 * null when this process may not use them.
 *
 *   supabase-rest               the data client itself, as it always was;
 *   postgres+supabase-services  a client for SUPABASE_URL (required by that
 *                               mode), used only by the optional extras —
 *                               legacy auth.users cleanup and the Supabase
 *                               Realtime transport;
 *   postgres-only               null, always — whatever SUPABASE_* variables
 *                               are still set. Supabase Realtime is then
 *                               unavailable to the resolver, the publisher and
 *                               the widget alike; realtime runs on Centrifugo.
 */
export function supabaseServicesClient(env: NodeJS.ProcessEnv = process.env): SupabaseClient | null {
  const mode = databaseMode(env);
  if (mode === 'postgres-only') return null;
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (mode === 'supabase-rest') return url && key ? dataClientFor(url, key) : null;
  if (servicesClient === undefined) {
    servicesClient = url && key ? createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }) : null;
  }
  return servicesClient;
}
