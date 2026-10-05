/**
 * One service-role client per (url, key), reused for the life of the process.
 *
 * `createClient(url, key)` with the default options is not a cheap value to
 * throw away: its auth client keeps an in-memory session store and starts a
 * token auto-refresh interval, and that interval holds the client — so a
 * client built per call is never collected, and every one of them keeps
 * ticking every 30 s. Built per request by the plan, billing and email
 * paths, 30 minutes of load left 7,258 of them alive (plus their timers and
 * sockets); memory grew by ~450 MB and throughput fell by a fifth.
 *
 * A server-side client never holds a user session, so the options match
 * getServiceClient(): no persisted session, no refresh ticker.
 *
 * With `DATABASE_URL` set the arguments no longer pick anything — there is one
 * database — and the process-wide direct client is returned (server/db).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { dataClientFor } from '../db/index.js';

export function serviceClientFor(supabaseUrl: string, serviceRoleKey: string): SupabaseClient {
  return dataClientFor(supabaseUrl, serviceRoleKey);
}
