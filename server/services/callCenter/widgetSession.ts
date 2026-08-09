/**
 * Call Center widget session token (HMAC). Short-lived. Bound to call_id when issued.
 * Visitors never receive a service token; only this opaque session.
 */
import crypto from 'crypto';
import type { ServerConfig } from '../../config.js';

const TTL_SECONDS = 60 * 30; // 30 min

function secret(config: ServerConfig): string {
  return (
    (config as any).widgetTokenSecret ||
    (config as any).sessionSecret ||
    config.supabaseServiceRoleKey
  );
}

/**
 * Rate-limit trust class — mirrors WidgetRateLimitTrust in
 * server/services/widget/security.ts. A valid x-cc-session signature only
 * proves "our server minted this at some point for workspace X"; bootstrap
 * decides which workspace using publicKey/workspaceId + Origin, all of
 * which a non-browser caller can supply arbitrarily. 'public' is the only
 * value any bootstrap path issues today — 'workspace' is reserved for a
 * future stronger-proof escalation path (e.g. a challenge), not implemented
 * here. See resolveTrustedRateLimitWorkspaceId in server/middleware/security.ts
 * for the consumer of this claim.
 */
export type CallWidgetRateLimitTrust = 'public' | 'workspace';

export interface WidgetSessionPayload {
  workspace_id: string;
  public_key: string | null;
  call_id?: string | null;
  visitor_id?: string | null;
  origin?: string | null;
  /** Per-session random id — lets rate limiting key on the session itself
   * (callWidgetSessionRateLimiter in server/middleware/security.ts) instead
   * of only IP, so a single credential can't be hammered past a sane cap
   * purely by rotating source IPs. Optional only for parsing sessions signed
   * before this field existed; every session signed from here on carries one. */
  nonce?: string;
  /** Rate-limit trust class — see CallWidgetRateLimitTrust. Optional only
   * for parsing sessions signed before this field existed; those — and any
   * value other than the literal string 'workspace' — are treated as
   * 'public' everywhere this is consumed (fail to lower trust, never
   * escalate). */
  rl?: CallWidgetRateLimitTrust;
  iat: number;
  exp: number;
}

/**
 * Every real bootstrap path's input shape — never includes `rl`. This is
 * enforced at the type level (not just by convention) so a production call
 * site cannot accidentally, or a future caller cannot deliberately, opt a
 * session into a stronger rate-limit trust class than its own proof
 * justifies. If a genuinely stronger-proof escalation path is ever built,
 * give it its own explicitly-named signer rather than widening this one.
 */
export type PublicWidgetSessionInput = Omit<WidgetSessionPayload, 'iat' | 'exp' | 'nonce' | 'rl'>;

/**
 * The ONLY session signer production routes call. Always signs
 * `rl: 'public'` — see CallWidgetRateLimitTrust's doc comment. `rl` is
 * excluded from PublicWidgetSessionInput and re-asserted after the spread,
 * so even a caller that bypasses the type system (e.g. `as any`) cannot
 * make this function emit 'workspace'.
 */
export function signWidgetSession(
  config: ServerConfig,
  payload: PublicWidgetSessionInput,
  ttlSec = TTL_SECONDS,
): string {
  return signWidgetSessionWithTrust(config, { ...payload, rl: 'public' }, ttlSec);
}

/**
 * INTERNAL / TEST-ONLY. Not called by any production route — every real
 * issuer goes through signWidgetSession() above, which always forces
 * `rl: 'public'`. This exists solely so tests can construct a genuine
 * `rl: 'workspace'` session to prove resolveTrustedRateLimitWorkspaceId's
 * workspace-trust branch is still reachable, without opening that door on
 * the public signer. Do not call this from server/routes/callWidget.ts or
 * any other production route.
 */
export function signWidgetSessionWithTrust(
  config: ServerConfig,
  payload: Omit<WidgetSessionPayload, 'iat' | 'exp' | 'nonce'>,
  ttlSec = TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const full: WidgetSessionPayload = {
    rl: 'public',
    ...payload,
    nonce: crypto.randomBytes(8).toString('hex'),
    iat: now,
    exp: now + ttlSec,
  };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret(config))
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

export function verifyWidgetSession(
  config: ServerConfig,
  token: string,
): WidgetSessionPayload | null {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = crypto
    .createHmac('sha256', secret(config))
    .update(body)
    .digest('base64url');
  if (
    expect.length !== sig.length ||
    !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as WidgetSessionPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}