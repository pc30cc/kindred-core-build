/**
 * Core ↔ Channels server-to-server authentication boundary.
 *
 * The Channels Gateway and the Channels Worker are trusted internal services,
 * but that trust must be AUTHENTICATED. Every `/internal/channels/*` route
 * goes through `requireInternalService`, which compares a dedicated
 * `CORE_INTERNAL_SECRET` in constant time.
 *
 * The secret is never logged, never returned, and is deliberately distinct
 * from SUPABASE_SERVICE_ROLE_KEY, the auth/JWT secret, the plugin master key
 * and CHANNELS_WEBHOOK_SIGNING_KEY.
 */

import { timingSafeEqual } from 'node:crypto';
import type { ServerConfig } from '../config.js';

export function constantTimeEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function bearerOf(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Express guard. Returns true when the caller presented the internal secret.
 * Writes the response and returns false otherwise — with no detail about why.
 */
export function requireInternalService(req: any, res: any): boolean {
  const config = (req as any).serverConfig as ServerConfig | undefined;
  const expected = config?.coreInternalSecret;

  if (!expected) {
    // Fail closed: an unconfigured internal boundary must never be open.
    res.status(503).json({ error: 'Internal channel boundary not configured' });
    return false;
  }

  const presented = bearerOf(req.headers?.authorization);
  if (!constantTimeEquals(presented, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}
