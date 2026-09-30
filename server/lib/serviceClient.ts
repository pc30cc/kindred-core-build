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
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const clients = new Map<string, SupabaseClient>();

export function serviceClientFor(supabaseUrl: string, serviceRoleKey: string): SupabaseClient {
  const id = `${supabaseUrl}\u0000${serviceRoleKey}`;
  let client = clients.get(id);
  if (!client) {
    client = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
    clients.set(id, client);
  }
  return client;
}
