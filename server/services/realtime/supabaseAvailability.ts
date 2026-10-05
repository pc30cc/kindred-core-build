import type { ServerConfig } from '../../config.js';
import { supabaseServicesClient } from '../../db/index.js';

/**
 * Whether the optional Supabase Realtime transport can work: it needs a
 * Supabase project to publish through (SUPABASE_URL and the service-role key,
 * server side) and its anon key for the browsers that subscribe. A database
 * reached only through DATABASE_URL has no Realtime service — Centrifugo or
 * polling carry realtime there.
 */
export function supabaseRealtimeAvailable(config: ServerConfig): boolean {
  return !!config.supabaseAnonKey && supabaseServicesClient() !== null;
}
