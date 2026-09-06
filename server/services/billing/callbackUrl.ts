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