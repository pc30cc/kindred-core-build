import { createClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../../config.js';
import { allowedOrigins } from '../platformOrigins.js';

type RequestLike = {
  protocol?: string;
  get?: (name: string) => string | undefined;
};

function parseHttpOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      return null;
    }
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Canonical allow-list for browser return URLs handed to payment gateways.
 * The authenticated mutation Origin is already verified by requireUser; the
 * remaining entries cover same-host proxies and the platform domain registry.
 */
export function isAllowedBillingCallbackUrl(
  req: RequestLike,
  config: ServerConfig,
  raw: string,
): boolean {
  const target = parseHttpOrigin(raw);
  if (!target) return false;

  const candidates = new Set<string>(allowedOrigins(config));
  const requestOrigin = parseHttpOrigin(req.get?.('origin'));
  if (requestOrigin) candidates.add(requestOrigin);

  const refererOrigin = parseHttpOrigin(req.get?.('referer'));
  if (refererOrigin) candidates.add(refererOrigin);

  const host = req.get?.('host');
  const hostOrigin = host ? parseHttpOrigin(`${req.protocol || 'https'}://${host}`) : null;
  if (hostOrigin) candidates.add(hostOrigin);

  const forwardedHost = req.get?.('x-forwarded-host')?.split(',')[0]?.trim();
  const forwardedProto = req.get?.('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol || 'https';
  const forwardedOrigin = forwardedHost ? parseHttpOrigin(`${forwardedProto}://${forwardedHost}`) : null;
  if (forwardedOrigin) candidates.add(forwardedOrigin);

  for (const configured of [process.env.PUBLIC_APP_URL, process.env.APP_URL]) {
    const origin = parseHttpOrigin(configured);
    if (origin) candidates.add(origin);
  }

  return candidates.has(target);
}

/** A signed simulator URL may redirect only to an ordinary HTTPS/local URL. */
export function isSafeSignedBillingCallback(raw: string): boolean {
  return parseHttpOrigin(raw) !== null;
}

/**
 * Canonical PUBLIC API origin — the address of THIS Express deployment, which
 * a split app/API topology serves from a different host than the browser
 * app. The bank/gateway callback (`/api/billing/return`,
 * `/api/billing/test-gateway`) MUST be built from this origin, never from a
 * browser-supplied return URL: deriving it from `browserReturnUrl.origin`
 * silently pointed the bank at the app host, which 404s whenever the app
 * host does not reverse-proxy `/api/*`.
 *
 * Resolution order (never the client-supplied callback URL):
 *   1. `platform_domains.api_base_url` — operator-managed, canonical
 *   2. `API_BASE_URL` / `PUBLIC_API_URL` env — safe, server-controlled fallback
 *   3. `platform_domains.app_base_url` / `PUBLIC_APP_URL` / `APP_URL` — only
 *      when no API-specific origin was ever configured, i.e. a genuine
 *      single-origin deployment where app and API are the same host
 */
export async function resolvePublicApiOrigin(
  supabaseUrl: string,
  supabaseServiceRoleKey: string,
): Promise<string> {
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
  const { data } = await supabase
    .from('platform_domains')
    .select('app_base_url, api_base_url')
    .limit(1)
    .maybeSingle();

  const candidates: unknown[] = [
    (data as { api_base_url?: unknown } | null)?.api_base_url,
    process.env.API_BASE_URL,
    process.env.PUBLIC_API_URL,
    (data as { app_base_url?: unknown } | null)?.app_base_url,
    process.env.PUBLIC_APP_URL,
    process.env.APP_URL,
  ];
  for (const candidate of candidates) {
    const origin = parseHttpOrigin(candidate);
    if (origin) return origin;
  }
  throw new Error('BILLING_API_ORIGIN_NOT_CONFIGURED');
}