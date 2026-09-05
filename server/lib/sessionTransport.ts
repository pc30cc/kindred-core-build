/**
 * Where the opaque first-party session token is read from, for BOTH
 * supported transports of the SAME credential:
 *
 *   - web       → the HttpOnly `gs_session` cookie (unchanged)
 *   - native    → `Authorization: Bearer <opaque session token>` sent by the
 *                 Capacitor app, which cannot use cookies from
 *                 `capacitor://localhost`
 *
 * This is intentionally a tiny, dependency-free module: it only decides
 * WHERE to read the string. Hashing, lookup, expiry, renewal and revocation
 * all remain in server/services/auth/sessions.ts, so there is exactly one
 * implementation of session validation for web and mobile alike.
 */

export const SESSION_COOKIE = 'gs_session';

export type SessionTransport = 'cookie' | 'bearer';

export function readSessionToken(req: any): { token: string | null; transport: SessionTransport } {
  const header = req?.headers?.authorization ?? req?.headers?.Authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) return { token: match[1].trim(), transport: 'bearer' };
  }
  const cookie = req?.cookies?.[SESSION_COOKIE];
  return { token: typeof cookie === 'string' && cookie ? cookie : null, transport: 'cookie' };
}
