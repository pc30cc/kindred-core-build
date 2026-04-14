import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Supabase client is kept for non-auth product features (database queries, realtime, storage).
// All user authentication flows go through the backend API — NOT through this client.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('[supabase] Missing VITE_SUPABASE_URL or anon key env vars — DB features will not work');
}

// Safe client creation — never crash the app if env vars are missing
let supabase: SupabaseClient;
try {
  supabase = createClient(
    SUPABASE_URL || 'https://placeholder.supabase.co',
    SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder'
  );
} catch (e) {
  console.error('[supabase] Failed to create client:', e);
  // Create a minimal placeholder so the app doesn't crash
  supabase = createClient('https://placeholder.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder');
}

export { supabase };
