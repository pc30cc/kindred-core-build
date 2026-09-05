/**
 * Runtime-resolved browser origins for CORS.
 *
 * Domains must NOT be baked into env/build artifacts: when the operator moves
 * the dashboard, API or public/widget host to a new domain they change it once
 * in Super Admin → Domains (`platform_domains`) and every server-side consumer
 * follows without a redeploy or a container restart.
 *
 * Resolution order for the allowed browser origins:
 *   1. `platform_domains` (app_base_url / api_base_url / public_base_url)
 *   2. `CORS_ORIGINS` env (static fallback, still honoured)
 *
 * The lookup is cached in-process with a short TTL. A cross-origin request is
 * never blocked on a DB round-trip: an expired cache is served STALE while a
 * single refresh runs in the background, so a slow/unavailable DB degrades to
 * "previous known origins" instead of an outage.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

const TTL_MS = 60_000;

let cache: string[] = [];
let cachedAt = 0;
let inFlight: Promise<void> | null = null;

/** `https://App.Example.com/` → `https://app.example.com` (origin only). */
function toOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value === '*') return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

async function refresh(config: ServerConfig): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('platform_domains')
      .select('app_base_url, api_base_url, public_base_url')
      .limit(1)
      .maybeSingle();

    const next = [data?.app_base_url, data?.api_base_url, data?.public_base_url]
      .map(toOrigin)
      .filter((o): o is string => !!o);

    cache = Array.from(new Set(next));
    cachedAt = Date.now();
  } catch (err: any) {
    // Keep the previous cache; only push the retry forward a little so a hard
    // DB failure cannot turn into a per-request query storm.
    cachedAt = Date.now() - TTL_MS + 5_000;
    console.warn('[platformOrigins] refresh failed:', err?.message || err);
  } finally {
    inFlight = null;
  }
}

/** Static origins configured through `CORS_ORIGINS` (wildcard ignored). */
export function staticOrigins(config: ServerConfig): string[] {
  return (config.corsOrigins || [])
    .map(toOrigin)
    .filter((o): o is string => !!o);
}

/**
 * Current allow-list. Synchronous by design (the `cors` origin callback runs
 * per request); refreshes happen out of band.
 */
export function allowedOrigins(config: ServerConfig): string[] {
  if (Date.now() - cachedAt > TTL_MS && !inFlight) {
    inFlight = refresh(config);
  }
  return Array.from(new Set([...staticOrigins(config), ...cache]));
}

/**
 * Origins of the first-party NATIVE shells (Capacitor iOS/Android). The
 * bundled app serves its own assets from `capacitor://localhost`, so every
 * API call it makes is cross-origin and needs CORS headers.
 *
 * This is CORS only, and deliberately narrow:
 *  - it is NOT added to `config.corsOrigins`, so `verifyOriginForMutation`
 *    (the cookie-CSRF check) is completely unaffected — a browser page can
 *    never present one of these origins anyway;
 *  - native sessions authenticate with `Authorization: Bearer`, not with
 *    the `gs_session` cookie, so allowing these origins grants no
 *    cookie-riding capability to anyone.
 */
/**
 * EXACT-MATCH allow-list, deliberately a single entry: the iOS shell built
 * by this repo runs from `capacitor://localhost` (see capacitor.config.ts —
 * no `server.url`, no `iosScheme` override). `ionic://localhost` is NOT
 * allowed because nothing in this project ever serves from it; add an
 * origin here only when a shipped build actually uses it.
 *
 * Never allow `"null"` (opaque origins: sandboxed iframes, `file://`,
 * redirected requests), never a wildcard, never a scheme prefix match.
 */
const NATIVE_APP_ORIGINS = new Set(['capacitor://localhost']);

export function isNativeAppOrigin(origin: unknown): boolean {
  if (typeof origin !== 'string') return false;
  const value = origin.trim();
  // Exact match only — no lowercasing tricks, no `null`, no wildcards.
  if (!value || value === 'null' || value === '*') return false;
  return NATIVE_APP_ORIGINS.has(value);
}

/**
 * TRUST BOUNDARY for handing a RAW session token back in a response body
 * (the native login path). True only when the caller cannot be an ordinary
 * browser page: the native shell origin, or no Origin header at all
 * (non-browser client — browsers always send Origin on POST). Everything
 * else must keep the HttpOnly-cookie web flow, so a web page can never
 * upgrade itself to a JS-readable long-lived credential.
 */
export function allowsMobileTokenIssuance(origin: unknown): boolean {
  if (origin === undefined || origin === null || origin === '') return true;
  if (typeof origin !== 'string') return false;
  return isNativeAppOrigin(origin);
}



export function isAllowedOrigin(config: ServerConfig, origin: string): boolean {
  if (isNativeAppOrigin(origin)) return true;
  const normalized = toOrigin(origin);
  if (!normalized) return false;
  return allowedOrigins(config).includes(normalized);
}


/** Warm the cache at boot so the first cross-origin request already matches. */
export function primePlatformOrigins(config: ServerConfig): void {
  if (!inFlight) inFlight = refresh(config);
}

/** Test-only. */
export function __resetPlatformOriginsCache(): void {
  cache = [];
  cachedAt = 0;
  inFlight = null;
}
