import { databaseMode } from '../db/mode.js';

/**
 * The root secret the server's own HMAC signers derive their keys from —
 * widget sessions, visitor cookies, continuity and contact-verification
 * hashes, presence leases, signed attachment URLs, realtime topics, call
 * widget cookies and recording playback tokens.
 *
 * It used to be SUPABASE_SERVICE_ROLE_KEY, read straight from the
 * environment. With the database reached through DATABASE_URL that key may
 * not exist at all, so the root has its own name: PLATFORM_SIGNING_SECRET.
 * Until it is set the service-role key keeps the role, so nothing changes for
 * an install that has not moved yet.
 *
 * Moving an install off Supabase: set PLATFORM_SIGNING_SECRET to the value the
 * service-role key had. Every signature and stored hash stays valid; the
 * service-role key can then be removed. A new value instead invalidates them
 * (visitors start new widget sessions, continuity links stop resolving).
 * In DATABASE_MODE=postgres-only the fallback is off: PLATFORM_SIGNING_SECRET
 * must be set, so removing a leftover Supabase key can never change the root.
 */
export function platformSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  // postgres-only takes nothing from the legacy Supabase variables: the root
  // is PLATFORM_SIGNING_SECRET or nothing, and loadConfig refuses to start
  // without it.
  if (databaseMode(env) === 'postgres-only') return env.PLATFORM_SIGNING_SECRET || '';
  return env.PLATFORM_SIGNING_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || '';
}

/** PLATFORM_SIGNING_SECRET must be long enough to be a key, not a password. */
export const MIN_PLATFORM_SIGNING_SECRET_LENGTH = 32;
