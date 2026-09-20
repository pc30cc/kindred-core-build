/**
 * Internal-service authentication (Core <-> control service).
 *
 * The same secret is accepted from either transport because proxies routinely
 * strip Authorization. There is NO unauthenticated mode: with the secret unset
 * the service refuses to boot (see config.ts `required`).
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const TELEPHONY_SECRET_HEADER = 'x-telephony-internal-secret';

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function presentedSecret(req: Pick<Request, 'header'>): string | null {
  const header = req.header(TELEPHONY_SECRET_HEADER);
  if (header) return header;
  const auth = req.header('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : null;
}

export function internalAuth(expected: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expected) return res.status(401).json({ error: 'internal_secret_not_configured' });
    const presented = presentedSecret(req);
    if (!presented || !safeEqual(presented, expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };
}

/** Outbound headers when this service calls Core. */
export function coreAuthHeaders(secret: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${secret}`,
    [TELEPHONY_SECRET_HEADER]: secret,
  };
}
