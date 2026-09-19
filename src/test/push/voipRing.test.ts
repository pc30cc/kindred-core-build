/**
 * The VoIP ring's silent-failure surface.
 *
 * Every assertion here corresponds to a way an incoming call stops ringing
 * while everything still looks healthy: APNs answers 200 to a push with the
 * wrong topic, the wrong push type or a stale token, and the only symptom is
 * a phone that stays quiet. None of that is visible in a log, so it is
 * pinned down here instead.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  buildVoipRequest,
  getApnsCredentials,
  isVoipConfigured,
  resetApnsCache,
  type ApnsCredentials,
} from '../../../server/services/push/apnsVoip';

function testCredentials(overrides: Partial<ApnsCredentials> = {}): ApnsCredentials {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    keyId: 'ABC123DEFG',
    teamId: 'TEAM123456',
    privateKey: privateKey as unknown as string,
    bundleId: 'com.webyar.native',
    sandbox: false,
    ...overrides,
  };
}

describe('VoIP push request', () => {
  let creds: ApnsCredentials;

  beforeAll(() => {
    creds = testCredentials();
  });

  it('addresses the VoIP topic, not the app topic', () => {
    const { headers } = buildVoipRequest(creds, { token: 'abc123', payload: {} });
    // Without the `.voip` suffix APNs accepts the push and PushKit never sees
    // it — the single most common reason a CallKit app never rings.
    expect(headers['apns-topic']).toBe('com.webyar.native.voip');
  });

  it('declares itself a VoIP push at immediate priority', () => {
    const { headers } = buildVoipRequest(creds, { token: 'abc123', payload: {} });
    expect(headers['apns-push-type']).toBe('voip');
    expect(headers['apns-priority']).toBe(10);
  });

  it('expires the ring rather than delivering it late', () => {
    const now = Math.floor(Date.now() / 1000);
    const { headers } = buildVoipRequest(creds, {
      token: 'abc123',
      payload: {},
      expirationSeconds: 45,
    });
    const expiry = Number(headers['apns-expiration']);
    // A ring delivered after the caller hung up is worse than no ring: the
    // operator answers a call nobody is on.
    expect(expiry).toBeGreaterThanOrEqual(now + 44);
    expect(expiry).toBeLessThanOrEqual(now + 47);
  });

  it('collapses a ring and its cancellation onto one another', () => {
    const callId = '3F2504E0-4F89-11D3-9A0C-0305E82C3301';
    const ring = buildVoipRequest(creds, {
      token: 'abc123',
      payload: { event: 'incoming', call_id: callId },
      collapseId: callId,
    });
    const cancel = buildVoipRequest(creds, {
      token: 'abc123',
      payload: { event: 'cancel', call_id: callId },
      collapseId: callId,
    });
    expect(ring.headers['apns-collapse-id']).toBe(cancel.headers['apns-collapse-id']);
  });

  it('keeps a collapse id inside the 64-byte limit Apple enforces', () => {
    const { headers } = buildVoipRequest(creds, {
      token: 'abc123',
      payload: {},
      collapseId: 'x'.repeat(200),
    });
    expect(String(headers['apns-collapse-id']).length).toBeLessThanOrEqual(64);
  });

  it('signs with the key id and team, and sends no key material', () => {
    const { headers } = buildVoipRequest(creds, { token: 'abc123', payload: {} });
    const authorization = String(headers.authorization);
    expect(authorization.startsWith('bearer ')).toBe(true);

    const [rawHeader, rawBody] = authorization.slice(7).split('.');
    const header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8'));
    const body = JSON.parse(Buffer.from(rawBody, 'base64url').toString('utf8'));
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('ABC123DEFG');
    expect(body.iss).toBe('TEAM123456');
    // The private key must never leave the server environment.
    expect(authorization).not.toContain('PRIVATE KEY');
  });

  it('sends the payload verbatim, so the app can read the call id', () => {
    const payload = { event: 'incoming', call_id: 'abc', channel: 'video', caller: 'Maryam' };
    const { body } = buildVoipRequest(creds, { token: 'abc123', payload });
    expect(JSON.parse(body.toString('utf8'))).toEqual(payload);
  });

  it('goes to production unless told otherwise', () => {
    expect(buildVoipRequest(creds, { token: 'a', payload: {} }).host)
      .toBe('https://api.push.apple.com');
    expect(buildVoipRequest(testCredentials({ sandbox: true }), { token: 'a', payload: {} }).host)
      .toBe('https://api.sandbox.push.apple.com');
  });
});

describe('VoIP configuration', () => {
  it('is simply off when the environment carries no key', () => {
    const saved = {
      APNS_KEY_ID: process.env.APNS_KEY_ID,
      APNS_TEAM_ID: process.env.APNS_TEAM_ID,
      APNS_BUNDLE_ID: process.env.APNS_BUNDLE_ID,
      APNS_PRIVATE_KEY: process.env.APNS_PRIVATE_KEY,
    };
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_TEAM_ID;
    delete process.env.APNS_BUNDLE_ID;
    delete process.env.APNS_PRIVATE_KEY;
    resetApnsCache();
    try {
      // Not an error state: a deployment without calls is a valid deployment.
      expect(getApnsCredentials()).toBeNull();
      expect(isVoipConfigured()).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetApnsCache();
    }
  });
});
