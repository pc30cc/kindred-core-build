import type { SupabaseClient } from '@supabase/supabase-js';
import type { ServerConfig } from './config.js';
import { dataClientFor, dataDriver, directDataClient } from './db/index.js';

/**
 * The server's database client. The name is historical: with `DATABASE_URL`
 * set this is the direct PostgreSQL driver (server/db), and Supabase — when it
 * hosts the database at all — is used as nothing but PostgreSQL. Without it,
 * the legacy driver talks to Supabase's PostgREST with the service-role key.
 * Either way the API is supabase-js's, so no call site cares which.
 */
export function getServiceClient(config: ServerConfig): SupabaseClient {
  if (dataDriver() === 'postgres') return directDataClient();
  return dataClientFor(config.supabaseUrl, config.supabaseServiceRoleKey);
}

/**
 * The service-role client's type, named without re-importing
 * `@supabase/supabase-js` in every helper that only needs to pass one along.
 */
export type ServiceClient = ReturnType<typeof getServiceClient>;

/**
 * An anon-key client. Nothing in the server uses one — every query runs as the
 * trusted role and authorizes in code — and with a direct database connection
 * there is no anon key to use, so this refuses rather than hand back a client
 * with service-role reach under an anon name.
 */
export function getAnonClient(config: ServerConfig): SupabaseClient {
  if (dataDriver() === 'postgres') {
    throw new Error('getAnonClient: there is no anon role over a direct DATABASE_URL connection');
  }
  return dataClientFor(config.supabaseUrl, config.supabaseAnonKey);
}
