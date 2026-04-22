/**
 * Phase 8B - Time-limited TURN credentials (RFC 7635-style HMAC).
 *
 * The TURN server must be configured with the same shared secret. Username
 * format is `<expirationUnix>:<sub>` and the password is the base64-encoded
 * HMAC-SHA1 of the username using the shared secret.
 *
 * If no shared secret is configured, callers fall back to the static
 * username/credential pair from rtcResolver.getTurnConfig().
 */
import { createHmac } from 'crypto';

export interface TimeLimitedTurnCreds {
  username: string;
  credential: string;
  ttlSeconds: number;
  expiresAt: number;
}

export function mintTurnCreds(opts: {
  sharedSecret: string;
  identity?: string;
  ttlSeconds?: number;
}): TimeLimitedTurnCreds {
  const ttl = Math.max(60, Math.min(opts.ttlSeconds ?? 600, 24 * 3600));
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sub = (opts.identity || 'gs').replace(/[:\s]/g, '_');
  const username = exp + ':' + sub;
  const hmac = createHmac('sha1', opts.sharedSecret);
  hmac.update(username);
  const credential = hmac.digest('base64');
  return {
    username,
    credential,
    ttlSeconds: ttl,
    expiresAt: exp * 1000,
  };
}
