/**
 * Browser Supabase client — strict singleton.
 *
 * Re-exports the canonical client from `@/integrations/supabase/client` so
 * the entire app shares ONE GoTrueClient instance under the same auth
 * storage key. Creating a second `createClient(...)` here would log:
 *
 *   "Multiple GoTrueClient instances detected in the same browser context"
 *
 * and cause concurrent token refresh races + session-state ping-pong that
 * surfaces as random 401s on long-lived widget / realtime connections.
 *
 * Both `import { supabase } from '@/lib/supabase'` and
 * `import { supabase } from '@/integrations/supabase/client'` now resolve
 * to the same object.
 */
export { supabase } from '@/integrations/supabase/client';
