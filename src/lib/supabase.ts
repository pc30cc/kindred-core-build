/**
 * Browser Supabase client — strict singleton (untyped facade).
 *
 * The codebase has two import paths for the browser client:
 *   - `@/lib/supabase`             (this file — historical, untyped)
 *   - `@/integrations/supabase/client` (Lovable auto-generated, typed)
 *
 * Calling `createClient(...)` in BOTH files produces:
 *   "Multiple GoTrueClient instances detected in the same browser context"
 * with concurrent token refresh races and random 401s on long-lived
 * widget / realtime connections.
 *
 * Fix: this module no longer creates a client. It returns the SAME
 * instance as `@/integrations/supabase/client`, but typed as `any` so
 * legacy hooks that use loose row shapes keep type-checking. The public
 * API surface is unchanged for every existing caller.
 */
import { supabase as typedClient } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const supabase = typedClient as unknown as SupabaseClient<any, 'public', any>;
