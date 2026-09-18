/**
 * APNs VoIP TRANSPORT (HTTP/2, token-based auth).
 *
 * Why this exists next to `fcm.ts` rather than inside it: a CallKit ring on
 * iOS is delivered by PushKit, and PushKit only accepts a push sent with
 * `apns-push-type: voip` to the `<bundle-id>.voip` topic. Firebase cannot send
 * one — its HTTP v1 API has no VoIP push type — so the ring has to go to Apple
 * directly. Ordinary notifications still go through FCM; nothing here changes
 * that path.
 *
 * Deliberate choices, all of them load-bearing:
 *  • Token-based auth with a `.p8` key rather than a certificate: one key
 *    serves every app and never expires, so a ring cannot stop working
 *    because somebody forgot to renew a cert.
 *  • The signing key lives in the server environment ONLY — never in the
 *    database, never in the app bundle, never logged. Same rule as FCM.
 *  • One long-lived HTTP/2 session per environment, because APNs throttles
 *    connection churn much harder than it throttles requests.
 *  • Every failure is returned, never thrown: a phone that cannot be reached
 *    must not break the call for everybody else.
 */
import http2 from 'node:http2';
import jwt from 'jsonwebtoken';

export interface ApnsCredentials {
  keyId: string;
  teamId: string;
  privateKey: string;
  /** The app's bundle identifier. The VoIP topic is this plus `.voip`. */
  bundleId: string;
  /** Apple's production gateway unless explicitly told otherwise. */
  sandbox: boolean;
}

export interface ApnsSendOutcome {
  ok: boolean;
  /** Dead address: forget the token rather than retrying it forever. */
  unregistered?: boolean;
  status?: number;
  reason?: string;
}

const PRODUCTION_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

let cachedCreds: ApnsCredentials | null | undefined;

/**
 * Reads credentials from env. Returns null when VoIP push is simply not
 * configured, which is a valid deployment state — the call still rings in
 * every browser that has the operator console open.
 */
export function getApnsCredentials(): ApnsCredentials | null {
  if (cachedCreds !== undefined) return cachedCreds;
  cachedCreds = loadCredentials();
  return cachedCreds;
}

export function isVoipConfigured(): boolean {
  return getApnsCredentials() !== null;
}

/** Test seam: forget the memoized credentials, token and connection. */
export function resetApnsCache(): void {
  cachedCreds = undefined;
  providerToken = null;
  closeSession();
}

function loadCredentials(): ApnsCredentials | null {
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  const bundleId = process.env.APNS_BUNDLE_ID?.trim() || process.env.IOS_BUNDLE_ID?.trim();
  const raw = process.env.APNS_PRIVATE_KEY ?? process.env.APNS_PRIVATE_KEY_BASE64;
  if (!keyId || !teamId || !bundleId || !raw) return null;

  const privateKey = normalizeKey(raw.trim());
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    // Never log the value itself: it is the signing key.
    console.error('[apns] APNS_PRIVATE_KEY is not a PEM-encoded .p8 key');
    return null;
  }
  return {
    keyId,
    teamId,
    privateKey,
    bundleId,
    sandbox: (process.env.APNS_ENVIRONMENT || '').trim().toLowerCase() === 'sandbox',
  };
}

function normalizeKey(value: string): string {
  if (value.includes('BEGIN PRIVATE KEY')) {
    return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
  }
  // Base64 of the whole .p8 file is the friendlier thing to paste into a
  // single-line environment variable.
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return value;
  }
}

// ── Provider token ──────────────────────────────────────────────────────
//
// Apple rejects a token refreshed more often than once every 20 minutes and
// expires one older than 60, so it is regenerated on a 45-minute cadence.

let providerToken: { value: string; issuedAt: number } | null = null;
const TOKEN_MAX_AGE_MS = 45 * 60 * 1000;

function getProviderToken(creds: ApnsCredentials): string {
  const now = Date.now();
  if (providerToken && now - providerToken.issuedAt < TOKEN_MAX_AGE_MS) {
    return providerToken.value;
  }
  const value = jwt.sign({}, creds.privateKey, {
    algorithm: 'ES256',
    issuer: creds.teamId,
    keyid: creds.keyId,
    // `iat` is what Apple validates the age against; jsonwebtoken sets it.
    noTimestamp: false,
  });
  providerToken = { value, issuedAt: now };
  return value;
}

// ── Connection ──────────────────────────────────────────────────────────

let session: http2.ClientHttp2Session | null = null;
let sessionHost: string | null = null;

function closeSession(): void {
  try { session?.close(); } catch { /* already gone */ }
  session = null;
  sessionHost = null;
}

function getSession(host: string): http2.ClientHttp2Session {
  if (session && !session.closed && !session.destroyed && sessionHost === host) {
    return session;
  }
  if (session) closeSession();
  const next = http2.connect(host);
  // A dead socket must not take the process with it, and must not be reused.
  next.on('error', () => { if (session === next) closeSession(); });
  next.on('close', () => { if (session === next) closeSession(); });
  next.setTimeout(30_000, () => { if (session === next) closeSession(); });
  session = next;
  sessionHost = host;
  return next;
}

export interface VoipPushInput {
  /** The device's PushKit token, hex-encoded. */
  token: string;
  /** The whole payload PushKit hands to the app. Kept small on purpose. */
  payload: Record<string, unknown>;
  /** Groups a ring and its cancellation so Apple can collapse them. */
  collapseId?: string;
  /** Seconds. A ring is worthless once it has stopped ringing. */
  expirationSeconds?: number;
}

/**
 * Sends one VoIP push. Resolves with an outcome; never rejects.
 */
export async function sendVoipPush(input: VoipPushInput): Promise<ApnsSendOutcome> {
  const creds = getApnsCredentials();
  if (!creds) return { ok: false, reason: 'not_configured' };

  const host = creds.sandbox ? SANDBOX_HOST : PRODUCTION_HOST;
  const body = Buffer.from(JSON.stringify(input.payload), 'utf8');

  const headers: Record<string, string | number> = {
    ':method': 'POST',
    ':path': `/3/device/${input.token}`,
    authorization: `bearer ${getProviderToken(creds)}`,
    'apns-topic': `${creds.bundleId}.voip`,
    'apns-push-type': 'voip',
    // 10 is "send immediately". A VoIP push at any other priority is a
    // contradiction: there is nothing to defer.
    'apns-priority': 10,
    'apns-expiration': Math.floor(Date.now() / 1000) + (input.expirationSeconds ?? 45),
    'content-type': 'application/json',
    'content-length': body.length,
  };
  if (input.collapseId) headers['apns-collapse-id'] = input.collapseId.slice(0, 64);

  return new Promise<ApnsSendOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ApnsSendOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    let request: http2.ClientHttp2Stream;
    try {
      request = getSession(host).request(headers);
    } catch (err) {
      closeSession();
      return finish({ ok: false, reason: err instanceof Error ? err.message : 'connect_failed' });
    }

    let status = 0;
    let responseBody = '';

    request.setTimeout(10_000, () => {
      request.close(http2.constants.NGHTTP2_CANCEL);
      finish({ ok: false, reason: 'timeout' });
    });
    request.on('response', (h) => { status = Number(h[':status']) || 0; });
    request.on('data', (chunk) => { responseBody += chunk; });
    request.on('error', (err) => {
      finish({ ok: false, reason: err instanceof Error ? err.message : 'stream_error' });
    });
    request.on('end', () => {
      if (status === 200) return finish({ ok: true, status });
      let reason: string | undefined;
      try { reason = JSON.parse(responseBody)?.reason; } catch { /* not JSON */ }
      finish({
        ok: false,
        status,
        reason,
        // 410 means the token is dead; 400 + BadDeviceToken means it never
        // was one. Both mean stop trying, rather than retrying forever.
        unregistered: status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered',
      });
    });

    request.end(body);
  });
}
