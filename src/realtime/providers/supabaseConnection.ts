/**
 * The operator console's Supabase Realtime connection — built on demand from
 * what the server says (GET /api/realtime/supabase-config), never from a
 * project compiled into the bundle.
 *
 * Supabase Realtime is an optional transport: an install whose database is
 * plain PostgreSQL, or a Supabase project reached only through DATABASE_URL,
 * has none, the endpoint answers 404, and callers fall back to polling.
 * supabase-js itself is loaded only when a connection is actually made.
 */
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = (RESOLVED_API_BASE as string | undefined) || '';

/** The slice of a supabase-js client the adapter uses. */
export interface RealtimeChannelLike {
  on(type: 'broadcast', filter: { event: string }, cb: (msg: { payload?: unknown }) => void): RealtimeChannelLike;
  subscribe(cb: (status: string) => void): unknown;
}

export interface SupabaseRealtimeClientLike {
  channel(topic: string, opts?: unknown): RealtimeChannelLike;
  removeChannel(ch: RealtimeChannelLike): Promise<unknown>;
}

let connection: Promise<SupabaseRealtimeClientLike | null> | null = null;

async function connect(): Promise<SupabaseRealtimeClientLike | null> {
  const res = await fetch(`${API_BASE}/api/realtime/supabase-config`, { credentials: 'include' });
  if (!res.ok) return null;
  const { supabase_url: url, anon_key: key } = (await res.json()) as { supabase_url?: string; anon_key?: string };
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key, {
    // Realtime transport only: no Supabase Auth session is ever created,
    // persisted, refreshed or detected (dashboard identity is the first-party
    // gs_session cookie). The no-op lock keeps this instance from contending
    // with the embedded widget's own client for the Navigator lock.
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'gs-dashboard-no-auth',
      lock: <R>(_name: string, _acquireTimeout: number, fn: () => Promise<R>) => fn(),
    },
  }) as unknown as SupabaseRealtimeClientLike;
}

/** The shared connection, or null when this install has no Supabase Realtime. */
export function getSupabaseRealtimeClient(): Promise<SupabaseRealtimeClientLike | null> {
  if (!connection) {
    connection = connect().catch(() => null);
    // A refusal or network failure is retried on the next subscription.
    void connection.then((c) => {
      if (!c) connection = null;
    });
  }
  return connection;
}
