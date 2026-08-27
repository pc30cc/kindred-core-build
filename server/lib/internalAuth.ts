/**
 * Core ↔ Channels server-to-server authentication boundary.
 *
 * The Channels Gateway and the Channels Worker are trusted internal services,
 * but that trust must be AUTHENTICATED. Every `/internal/channels/*` route
 * goes through `requireInternalService`, which compares a dedicated
 * `CORE_INTERNAL_SECRET` in constant time.
 *
 * TRANSPORT NOTE — why two headers are accepted:
 * reverse proxies in front of Core (Traefik/Coolify, corporate gateways, some
 * CDN auth middlewares) routinely CONSUME or REWRITE `Authorization`. When
 * that happens Core sees no credential at all, which used to be reported to
 * the caller as a plain 401 — indistinguishable from a genuinely mismatched
 * secret, and it sent operators hunting for a secret difference that did not
 * exist. Callers therefore send the same value in BOTH `Authorization:
 * Bearer` and the dedicated `X-Core-Internal-Secret` header, and failures are
 * returned with a machine-readable `reason` so the cause is unambiguous.
 *
 * The secret is never logged, never returned, and is deliberately distinct
 * from SUPABASE_SERVICE_ROLE_KEY, the auth/JWT secret, the plugin master key
 * and CHANNELS_WEBHOOK_SIGNING_KEY.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { ServerConfig } from '../config.js';

/** Header used when a proxy eats `Authorization`. Same value, different name. */
export const INTERNAL_SECRET_HEADER = 'x-core-internal-secret';

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
 * Non-reversible short fingerprint of a secret, safe to log and to compare
 * across services. Domain-separated so it can never collide with any other
 * hash the platform derives from the same value.
 */
export function internalSecretFingerprint(secret: string | null | undefined): string | null {
  const value = typeof secret === 'string' ? secret.trim() : '';
  if (!value) return null;
  return createHash('sha256').update(`core-internal-secret:${value}`).digest('hex').slice(0, 12);
}

/** Reads the presented secret from either accepted transport. */
export function presentedInternalSecret(req: any): string | null {
  const direct = req?.headers?.[INTERNAL_SECRET_HEADER];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  return bearerOf(req?.headers?.authorization);
}

export type InternalAuthFailure = 'not_configured' | 'missing_credential' | 'secret_mismatch';

/**
 * Express guard. Returns true when the caller presented the internal secret.
 * Writes the response and returns false otherwise — the body names WHICH of
 * the three failure modes occurred, but never any part of either secret.
 */
export function requireInternalService(req: any, res: any): boolean {
  const config = (req as any).serverConfig as ServerConfig | undefined;
  const expected = config?.coreInternalSecret;

  if (!expected) {
    // Fail closed: an unconfigured internal boundary must never be open.
    res.status(503).json({
      error: 'Internal channel boundary not configured',
      reason: 'not_configured' satisfies InternalAuthFailure,
    });
    return false;
  }

  const presented = presentedInternalSecret(req);
  if (!presented) {
    // No credential arrived at all — almost always a proxy stripping headers,
    // NOT a wrong value. Saying so saves hours of misdirected debugging.
    res.status(401).json({
      error: 'Unauthorized',
      reason: 'missing_credential' satisfies InternalAuthFailure,
    });
    return false;
  }

  if (!constantTimeEquals(presented, expected)) {
    res.status(401).json({
      error: 'Unauthorized',
      reason: 'secret_mismatch' satisfies InternalAuthFailure,
    });
    return false;
  }
  return true;
}
