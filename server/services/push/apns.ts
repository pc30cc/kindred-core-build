/**
 * APNs TRANSPORT (HTTP/2, token-based auth).
 *
 * Everything that talks to Apple directly lives here: the credentials, the
 * provider token, the one long-lived connection, and the request/response
 * dance. Two things are built on top of it —
 *
 *   • `apnsVoip.ts`, the CallKit ring, which has to be sent to Apple because
 *     Firebase cannot produce an `apns-push-type: voip` push at all.
 *   • `sendApnsAlert` below, the ordinary banner, which is sent to Apple
 *     because the native operator app has no Firebase in it.
 *
 * That second one is the reason this file was split out of `apnsVoip.ts`. The
 * Capacitor build registers an FCM token and is dispatched through `fcm.ts`
 * exactly as before; the SwiftUI app registers its raw APNs token and comes
 * through here. A device row says which it is, and nothing else changes.
 *
 * Adding FirebaseMessaging to the native app was the alternative and it is a
 * worse trade: eight SPM products, a `GoogleService-Info.plist` in the bundle,
 * UIApplicationDelegate swizzling, and a third party in the path of every
 * operator notification — to reach a service that then forwards to the same
 * Apple endpoint this file already has credentials for.
 *
 * Deliberate choices, all of them load-bearing:
 *  • Token-based auth with a `.p8` key rather than a certificate: one key
 *    serves every app and never expires, so notifications cannot stop working
 *    because somebody forgot to renew a cert.
 *  • The signing key lives in the server environment ONLY — never in the
 *    database, never in the app bundle, never logged. Same rule as FCM.
 *  • One long-lived HTTP/2 session per environment, because APNs throttles
 *    connection churn much harder than it throttles requests.
 *  • Every failure is returned, never thrown: a phone that cannot be reached
 *    must not break anything for anybody else.
 */
import http2 from 'node:http2';
import { createPrivateKey } from 'node:crypto';
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

/**
 * The APNs-specific half of a send. Every field maps 1:1 to a documented
 * `aps` key or `apns-*` header — nothing here is invented, so a value an
 * operator sets in Super Admin is exactly what Apple receives.
 *
 * It lives here rather than in `fcm.ts` because it describes Apple's contract,
 * not Google's; `fcm.ts` re-exports it so its own callers are unaffected.
 */
export interface ApnsDelivery {
  /** 10 = immediate, 5 = power-considerate, 1 = lowest. */
  priority?: number;
  /** Seconds APNs keeps retrying. 0 = deliver now or discard. */
  ttlSeconds?: number;
  interruptionLevel?: 'passive' | 'active' | 'time-sensitive' | 'critical';
  /** 0–1: ranks this notification inside a grouped summary. */
  relevanceScore?: number;
  /** Groups notifications in Notification Center (usually the thread id). */
  threadId?: string;
  /** Registered `UNNotificationCategory` id; drives the action buttons. */
  categoryId?: string;
  /** Custom sound file shipped in the app bundle, or 'default'. */
  soundName?: string;
  /** Lets a Notification Service Extension rewrite the payload. */
  mutableContent?: boolean;
  /** Critical alerts pierce Silent Mode — requires an Apple entitlement. */
  critical?: boolean;
  criticalVolume?: number;
}

const PRODUCTION_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

let cachedCreds: ApnsCredentials | null | undefined;

/**
 * Why the credentials are absent when they were in fact set: the four
 * variables are there, but the key in them cannot be read as a .p8 key.
 * Super Admin says so, rather than calling a key it can see "missing".
 */
export type ApnsCredentialProblem = 'invalid_key';
let credentialProblem: ApnsCredentialProblem | null = null;

export function getApnsCredentialProblem(): ApnsCredentialProblem | null {
  getApnsCredentials();
  return credentialProblem;
}

/**
 * Reads credentials from env. Returns null when APNs is simply not
 * configured, which is a valid deployment state — the call still rings in
 * every browser that has the operator console open, and the console still
 * shows every message.
 */
export function getApnsCredentials(): ApnsCredentials | null {
  if (cachedCreds !== undefined) return cachedCreds;
  cachedCreds = loadCredentials();
  return cachedCreds;
}

export function isApnsConfigured(): boolean {
  return getApnsCredentials() !== null;
}

/** Test seam: forget the memoized credentials, token and connection. */
export function resetApnsCache(): void {
  cachedCreds = undefined;
  credentialProblem = null;
  providerToken = null;
  closeSession();
}

function loadCredentials(): ApnsCredentials | null {
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  const bundleId = process.env.APNS_BUNDLE_ID?.trim() || process.env.IOS_BUNDLE_ID?.trim();
  const raw = process.env.APNS_PRIVATE_KEY || process.env.APNS_PRIVATE_KEY_BASE64;
  if (!keyId || !teamId || !bundleId || !raw) return null;

  const privateKey = normalizeKey(raw);
  const unreadable = keyProblem(privateKey);
  if (unreadable) {
    // Never log the value itself: it is the signing key. What is wrong with
    // it, and which variables to look at, is enough to fix it.
    console.error(
      `[apns] APNS_PRIVATE_KEY / APNS_PRIVATE_KEY_BASE64 is set but is not a usable .p8 key (${unreadable}). ` +
        'Paste the whole AuthKey_<KEY_ID>.p8 file, or `base64 -i AuthKey_<KEY_ID>.p8` of it.',
    );
    credentialProblem = 'invalid_key';
    return null;
  }
  credentialProblem = null;
  return {
    keyId,
    teamId,
    privateKey,
    bundleId,
    sandbox: (process.env.APNS_ENVIRONMENT || '').trim().toLowerCase() === 'sandbox',
  };
}

/**
 * The .p8 key as Node reads it, from whatever shape it arrived in.
 *
 * A key goes into a deployment's environment through a form field, and the
 * field decides what the line breaks become: kept, turned into spaces, into a
 * literal "\n", or dropped altogether — and sometimes the value keeps the
 * quotes it was pasted with. The key between the two markers is the same in
 * every one of those, so it is rebuilt from that rather than refused: a key
 * that was pasted correctly in every way that matters must not silently stop
 * every iPhone notification.
 *
 * Accepted: the PEM file in any of those shapes; base64 of the whole file
 * (the friendliest thing to paste into a single-line variable); and the
 * base64 body alone, without its marker lines.
 */
export function normalizeKey(value: string): string {
  let text = value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  if (!text.includes('BEGIN PRIVATE KEY')) {
    const decoded = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
    // Base64 of the file decodes to the PEM; the body alone decodes to the
    // key's binary form, and is itself what goes between the markers.
    if (decoded.includes('BEGIN PRIVATE KEY')) text = decoded.trim();
  }
  const body = text
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/[\s'"]+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/** Why a normalized key cannot sign an ES256 token, or null when it can. */
function keyProblem(pem: string): string | null {
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ec') return `a ${key.asymmetricKeyType ?? 'non-EC'} key, not the EC key Apple issues`;
    return null;
  } catch {
    return 'not a readable private key';
  }
}

// ── Provider token ──────────────────────────────────────────────────────
//
// Apple rejects a token refreshed more often than once every 20 minutes and
// expires one older than 60, so it is regenerated on a 45-minute cadence.

let providerToken: { value: string; issuedAt: number } | null = null;
const TOKEN_MAX_AGE_MS = 45 * 60 * 1000;

export function getProviderToken(creds: ApnsCredentials): string {
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

export function apnsHost(creds: ApnsCredentials): string {
  return creds.sandbox ? SANDBOX_HOST : PRODUCTION_HOST;
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

// ── One request ─────────────────────────────────────────────────────────

export interface ApnsRequest {
  host: string;
  headers: Record<string, string | number>;
  body: Buffer;
}

/**
 * Sends one prepared request. Resolves with an outcome; never rejects.
 */
export function performApnsRequest(request: ApnsRequest): Promise<ApnsSendOutcome> {
  const { host, headers, body } = request;

  return new Promise<ApnsSendOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ApnsSendOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    let stream: http2.ClientHttp2Stream;
    try {
      stream = getSession(host).request(headers);
    } catch (err) {
      closeSession();
      return finish({ ok: false, reason: err instanceof Error ? err.message : 'connect_failed' });
    }

    let status = 0;
    let responseBody = '';

    stream.setTimeout(10_000, () => {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      finish({ ok: false, reason: 'timeout' });
    });
    stream.on('response', (h) => { status = Number(h[':status']) || 0; });
    stream.on('data', (chunk) => { responseBody += chunk; });
    stream.on('error', (err) => {
      finish({ ok: false, reason: err instanceof Error ? err.message : 'stream_error' });
    });
    stream.on('end', () => {
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

    stream.end(body);
  });
}

// ── Alert pushes ────────────────────────────────────────────────────────

export interface ApnsAlertInput {
  /** The device's APNs token, hex-encoded, from `didRegisterForRemoteNotifications`. */
  token: string;
  title: string;
  body: string;
  /** Identifiers ONLY. Never tokens, credentials or private metadata. */
  data: Record<string, string>;
  badge?: number;
  /** Whether this one makes a noise at all. A custom name comes from `apns`. */
  sound?: boolean;
  collapseId?: string;
  apns?: ApnsDelivery;
  /**
   * The bundle id to address, when it is not the credentials'.
   *
   * There are two iOS apps against one APNs key: the Capacitor build
   * (`com.webyar.app`) and the native operator app (`com.webyar.ai`). The
   * topic is the bundle id, so a native alert sent to the Capacitor topic is
   * accepted by Apple and delivered to nobody — a silence with a 200 in front
   * of it, which is the worst shape a bug can take here.
   */
  topic?: string;
}

/**
 * Builds the exact request Apple will see.
 *
 * Split out from the send so it can be asserted on: several of these headers
 * fail silently when they are wrong. The wrong `apns-topic` is a 400 nobody
 * reads; the wrong `apns-push-type` is accepted and simply never shown.
 */
export function buildAlertRequest(creds: ApnsCredentials, input: ApnsAlertInput): ApnsRequest {
  const delivery = input.apns ?? {};

  const aps: Record<string, unknown> = {
    alert: { title: input.title, body: input.body },
  };
  if (typeof input.badge === 'number') aps.badge = input.badge;
  if (delivery.threadId) aps['thread-id'] = delivery.threadId;
  if (delivery.categoryId) aps.category = delivery.categoryId;
  if (delivery.interruptionLevel) aps['interruption-level'] = delivery.interruptionLevel;
  if (typeof delivery.relevanceScore === 'number') aps['relevance-score'] = delivery.relevanceScore;
  if (delivery.mutableContent) aps['mutable-content'] = 1;

  if (input.sound !== false) {
    const name = delivery.soundName || 'default';
    // A critical alert is a different shape of the same key, and it is the
    // only one that carries a volume. It also needs an Apple-granted
    // entitlement in the app, without which APNs rejects the push outright —
    // which is why it is never the default.
    aps.sound = delivery.critical
      ? { critical: 1, name, volume: clamp01(delivery.criticalVolume ?? 1) }
      : name;
  }

  const payload: Record<string, unknown> = { aps, ...input.data };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');

  const headers: Record<string, string | number> = {
    ':method': 'POST',
    ':path': `/3/device/${input.token}`,
    authorization: `bearer ${getProviderToken(creds)}`,
    // No `.voip` suffix. That suffix is the whole difference between a ring
    // and a banner, and getting it wrong here would be a 200 that never
    // appears.
    'apns-topic': input.topic || creds.bundleId,
    'apns-push-type': 'alert',
    'apns-priority': delivery.priority ?? 10,
    'content-type': 'application/json',
    'content-length': body.length,
  };
  // Omitted, not zeroed, when there is no policy: an absent header means
  // "store and retry", and a zero means "deliver now or throw it away".
  if (typeof delivery.ttlSeconds === 'number') {
    headers['apns-expiration'] = delivery.ttlSeconds === 0
      ? 0
      : Math.floor(Date.now() / 1000) + delivery.ttlSeconds;
  }
  if (input.collapseId) headers['apns-collapse-id'] = input.collapseId.slice(0, 64);

  return { host: apnsHost(creds), headers, body };
}

/**
 * The bundle id the NATIVE operator app is built with.
 *
 * `APNS_BUNDLE_ID` names whichever app the VoIP ring goes to, and a
 * deployment that ships both builds needs two topics from one key. Falls back
 * to the credentials' own bundle id, which is right for a deployment that
 * only ships one app.
 */
export function nativeBundleId(): string | undefined {
  return process.env.APNS_NATIVE_BUNDLE_ID?.trim() || undefined;
}

export async function sendApnsAlert(input: ApnsAlertInput): Promise<ApnsSendOutcome> {
  const creds = getApnsCredentials();
  if (!creds) return { ok: false, reason: 'not_configured' };
  const request = prepare(() => buildAlertRequest(creds, input));
  return 'ok' in request ? request : performApnsRequest(request);
}

/**
 * Builds a request, turning a failure into an outcome. Signing the provider
 * token is the part that can throw, and a throw here used to escape the
 * whole dispatch: every device of every recipient went unsent and the log
 * row was left at "attempted", with nothing to say why.
 */
export function prepare(build: () => ApnsRequest): ApnsRequest | ApnsSendOutcome {
  try {
    return build();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[apns] could not prepare the request', { message });
    return { ok: false, reason: `request_failed: ${message}`.slice(0, 200) };
  }
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
