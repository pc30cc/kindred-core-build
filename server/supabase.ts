import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { ServerConfig } from './config.js';

let serviceClient: SupabaseClient | null = null;
let anonClient: SupabaseClient | null = null;

export function getServiceClient(config: ServerConfig): SupabaseClient {
  if (!serviceClient) {
    serviceClient = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return serviceClient;
}

export function getAnonClient(config: ServerConfig): SupabaseClient {
  if (!anonClient) {
    anonClient = createClient(config.supabaseUrl, config.supabaseAnonKey);
  }
  return anonClient;
}
