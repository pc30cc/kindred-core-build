/**
 * APNs VoIP PUSH — the CallKit ring.
 *
 * Why this exists next to `fcm.ts` rather than inside it: a CallKit ring on
 * iOS is delivered by PushKit, and PushKit only accepts a push sent with
 * `apns-push-type: voip` to the `<bundle-id>.voip` topic. Firebase cannot send
 * one — its HTTP v1 API has no VoIP push type — so the ring has to go to Apple
 * directly.
 *
 * The connection, the credentials and the provider token used to live here
 * too. They are in `apns.ts` now, because the native operator app's ordinary
 * notifications go to Apple directly as well and there is no reason for two
 * HTTP/2 sessions to the same host. What is left here is the one thing that
 * is genuinely about ringing a phone: the headers and payload of a VoIP push.
 */
import {
  apnsHost,
  getApnsCredentials,
  getProviderToken,
  performApnsRequest,
  type ApnsCredentials,
  type ApnsRequest,
  type ApnsSendOutcome,
} from './apns.js';

// Re-exported because callers and tests have always reached for them through
// this module, and where the credentials are read from is not their business.
export { getApnsCredentials, resetApnsCache } from './apns.js';
export type { ApnsCredentials, ApnsSendOutcome } from './apns.js';

/**
 * Whether a call can ring a phone at all.
 *
 * The same credentials as every other APNs push — there is one key — but its
 * own name, because "can we ring" is the question `adminNotifications` and the
 * device registration route are actually asking.
 */
export function isVoipConfigured(): boolean {
  return getApnsCredentials() !== null;
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

const RING_EXPIRY_SECONDS = 45;

/**
 * Builds the exact request Apple will see.
 *
 * Split out from the send so it can be asserted on: every one of these
 * headers is a silent failure when it is wrong. A missing `.voip` suffix on
 * the topic, or `alert` instead of `voip` as the push type, returns a
 * perfectly successful 200 from APNs and simply never rings.
 */
export function buildVoipRequest(creds: ApnsCredentials, input: VoipPushInput): ApnsRequest {
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
    'apns-expiration': Math.floor(Date.now() / 1000) + (input.expirationSeconds ?? RING_EXPIRY_SECONDS),
    'content-type': 'application/json',
    'content-length': body.length,
  };
  if (input.collapseId) headers['apns-collapse-id'] = input.collapseId.slice(0, 64);
  return {
    host: apnsHost(creds),
    headers,
    body,
  };
}

/**
 * Sends one VoIP push. Resolves with an outcome; never rejects.
 */
export async function sendVoipPush(input: VoipPushInput): Promise<ApnsSendOutcome> {
  const creds = getApnsCredentials();
  if (!creds) return { ok: false, reason: 'not_configured' };
  return performApnsRequest(buildVoipRequest(creds, input));
}
