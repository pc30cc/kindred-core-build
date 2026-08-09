/**
 * TEST-ONLY synthetic credential signing.
 *
 * Production code has zero ability to mint an `rl: 'workspace'` token or
 * call-widget session — see the doc comments on createSessionToken()
 * (server/services/widget/security.ts) and signWidgetSession()
 * (server/services/callCenter/widgetSession.ts). Both functions hard-code
 * `rl: 'public'` with no parameter to override it.
 *
 * These helpers exist ONLY so security tests can prove
 * resolveTrustedRateLimitWorkspaceId's workspace-trust branch
 * (server/middleware/security.ts) is still reachable for a genuinely
 * stronger-proof credential, without opening that capability on any
 * production-importable module. They independently replicate the exact
 * wire format and HMAC secret derivation each production verifier expects
 * — verifySessionToken()/verifyWidgetSession() — so a token signed here
 * verifies as real, just as a future strong-proof issuer's token would.
 *
 * Never import these from anything under server/.
 */
import crypto from 'node:crypto';
import type { ServerConfig } from '../../../../server/config.js';

const CHAT_SESSION_TOKEN_PREFIX = 'wss_';
const CHAT_SESSION_TOKEN_TTL_SECONDS = 900;
const CALL_SESSION_TTL_SECONDS = 60 * 30;

/** Mirrors getSigningSecret() in server/services/widget/security.ts. */
function chatSigningSecret(): Buffer {
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.WIDGET_SIGNING_SECRET || '';
  return crypto.createHash('sha256').update('widget-session:' + base).digest();
}

/** Mirrors secret() in server/services/callCenter/widgetSession.ts. */
function callSigningSecret(config: ServerConfig): string {
  return (
    (config as any).widgetTokenSecret ||
    (config as any).sessionSecret ||
    config.supabaseServiceRoleKey
  );
}

/**
 * Synthetic chat-widget token carrying `rl: 'workspace'`. Verifies as real
 * against verifySessionToken() because it uses the identical wire format
 * and secret derivation — this is what a future strong-proof issuer's
 * token would look like, not a bypass of verification.
 */
export function makeWorkspaceTrustedWidgetTokenForTest(workspaceId: string, origin: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    w: workspaceId,
    o: origin || '',
    n: crypto.randomBytes(8).toString('hex'),
    iat: now,
    exp: now + CHAT_SESSION_TOKEN_TTL_SECONDS,
    rl: 'workspace' as const,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', chatSigningSecret()).update(payloadB64).digest('base64url');
  return `${CHAT_SESSION_TOKEN_PREFIX}${payloadB64}.${sig}`;
}

/**
 * Synthetic call-widget session carrying `rl: 'workspace'`. Verifies as
 * real against verifyWidgetSession() for the same reason as above.
 */
export function makeWorkspaceTrustedCallWidgetSessionForTest(
  config: ServerConfig,
  payload: { workspace_id: string; public_key?: string | null; call_id?: string | null; visitor_id?: string | null; origin?: string | null },
  ttlSec = CALL_SESSION_TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const full = {
    public_key: null,
    ...payload,
    nonce: crypto.randomBytes(8).toString('hex'),
    iat: now,
    exp: now + ttlSec,
    rl: 'workspace' as const,
  };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = crypto.createHmac('sha256', callSigningSecret(config)).update(body).digest('base64url');
  return `${body}.${sig}`;
}
