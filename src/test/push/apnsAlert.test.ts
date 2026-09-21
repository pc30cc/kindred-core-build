/**
 * The native app's notifications go to Apple directly, and this is the shape
 * of what Apple is handed.
 *
 * Every assertion corresponds to a way a banner silently fails to appear.
 * APNs answers 200 to a push addressed at the wrong topic, sent with the
 * wrong push type, or carrying an `aps` dictionary it does not recognise —
 * the operator simply never hears anything, and there is nothing in any log
 * to look at. The VoIP ring has the same problem and the same treatment in
 * `voipRing.test.ts`; this is its sibling for ordinary notifications.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  buildAlertRequest,
  type ApnsCredentials,
} from '../../../server/services/push/apns';

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
    bundleId: 'com.webyar.app',
    sandbox: false,
    ...overrides,
  };
}

const base = {
  token: 'abc123',
  title: 'Sara Karimi',
  body: 'Is the order shipped yet?',
  data: { conversationId: 'c-1', workspaceId: 'w-1' },
};

function payloadOf(request: { body: Buffer }): any {
  return JSON.parse(request.body.toString('utf8'));
}

describe('APNs alert request', () => {
  let creds: ApnsCredentials;

  beforeAll(() => {
    creds = testCredentials();
  });

  it('addresses the app topic, with no .voip suffix', () => {
    const { headers } = buildAlertRequest(creds, base);
    // The suffix is the whole difference between a ring and a banner. With
    // it, PushKit is addressed and the notification never appears.
    expect(headers['apns-topic']).toBe('com.webyar.app');
  });

  it('addresses the native app when it is a different app from the credentials', () => {
    // One APNs key, two bundle ids: the Capacitor build and the SwiftUI one.
    // Sending a native alert to the Capacitor topic is a 200 that reaches
    // nobody.
    const { headers } = buildAlertRequest(creds, { ...base, topic: 'com.webyar.native' });
    expect(headers['apns-topic']).toBe('com.webyar.native');
  });

  it('declares itself an alert', () => {
    const { headers } = buildAlertRequest(creds, base);
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-priority']).toBe(10);
  });

  it('carries the title and body where iOS looks for them', () => {
    const payload = payloadOf(buildAlertRequest(creds, base));
    expect(payload.aps.alert).toEqual({
      title: 'Sara Karimi',
      body: 'Is the order shipped yet?',
    });
  });

  it('carries the identifiers alongside aps, not inside it', () => {
    // `aps` is Apple's dictionary; anything of ours placed inside it is
    // ignored, and the app reads these from the top level of userInfo.
    const payload = payloadOf(buildAlertRequest(creds, base));
    expect(payload.conversationId).toBe('c-1');
    expect(payload.workspaceId).toBe('w-1');
    expect(payload.aps.conversationId).toBeUndefined();
  });

  it('sends the badge only when there is one', () => {
    expect(payloadOf(buildAlertRequest(creds, base)).aps.badge).toBeUndefined();
    expect(payloadOf(buildAlertRequest(creds, { ...base, badge: 0 })).aps.badge).toBe(0);
    expect(payloadOf(buildAlertRequest(creds, { ...base, badge: 7 })).aps.badge).toBe(7);
  });

  it('makes a sound by default and is silent when asked', () => {
    expect(payloadOf(buildAlertRequest(creds, base)).aps.sound).toBe('default');
    expect(payloadOf(buildAlertRequest(creds, { ...base, sound: false })).aps.sound).toBeUndefined();
  });

  it('shapes a critical alert the way Apple requires', () => {
    // A critical alert is a dictionary with a volume, not a string — and the
    // volume has to be inside 0…1 or APNs rejects the whole push.
    const payload = payloadOf(buildAlertRequest(creds, {
      ...base,
      apns: { critical: true, criticalVolume: 4, soundName: 'urgent.caf' },
    }));
    expect(payload.aps.sound).toEqual({ critical: 1, name: 'urgent.caf', volume: 1 });
  });

  it('passes the delivery policy through to the keys iOS reads', () => {
    const payload = payloadOf(buildAlertRequest(creds, {
      ...base,
      apns: {
        threadId: 'conv-1',
        categoryId: 'WEBYAR_MESSAGE',
        interruptionLevel: 'time-sensitive',
        relevanceScore: 0.8,
        mutableContent: true,
        priority: 5,
      },
    }));
    expect(payload.aps['thread-id']).toBe('conv-1');
    // The category id is what puts Reply and Mark as read on the banner.
    expect(payload.aps.category).toBe('WEBYAR_MESSAGE');
    expect(payload.aps['interruption-level']).toBe('time-sensitive');
    expect(payload.aps['relevance-score']).toBe(0.8);
    expect(payload.aps['mutable-content']).toBe(1);

    const { headers } = buildAlertRequest(creds, { ...base, apns: { priority: 5 } });
    expect(headers['apns-priority']).toBe(5);
  });

  it('tells the difference between "no expiry policy" and "expire now"', () => {
    // An absent header means store and retry; a zero means deliver this
    // instant or throw it away. Collapsing the two would silently discard
    // every notification for a deployment that never set a TTL.
    expect(buildAlertRequest(creds, base).headers['apns-expiration']).toBeUndefined();
    expect(buildAlertRequest(creds, { ...base, apns: { ttlSeconds: 0 } })
      .headers['apns-expiration']).toBe(0);

    const now = Math.floor(Date.now() / 1000);
    const later = buildAlertRequest(creds, { ...base, apns: { ttlSeconds: 600 } })
      .headers['apns-expiration'] as number;
    expect(later).toBeGreaterThanOrEqual(now + 599);
    expect(later).toBeLessThanOrEqual(now + 601);
  });

  it('collapses on request, and bounds the id Apple will accept', () => {
    expect(buildAlertRequest(creds, base).headers['apns-collapse-id']).toBeUndefined();
    const long = 'c'.repeat(100);
    expect(buildAlertRequest(creds, { ...base, collapseId: long })
      .headers['apns-collapse-id']).toHaveLength(64);
  });

  it('sends to the production gateway unless told otherwise', () => {
    expect(buildAlertRequest(creds, base).host).toBe('https://api.push.apple.com');
    expect(buildAlertRequest(testCredentials({ sandbox: true }), base).host)
      .toBe('https://api.sandbox.push.apple.com');
  });

  it('signs with a bearer token', () => {
    const { headers } = buildAlertRequest(creds, base);
    expect(String(headers.authorization)).toMatch(/^bearer ey/);
  });

  it('declares a content-length that matches the body it sends', () => {
    // A mismatch here is an HTTP/2 stream error rather than an APNs reason
    // code, so it never reaches the dispatch log.
    const request = buildAlertRequest(creds, base);
    expect(headersLength(request)).toBe(request.body.length);
  });
});

function headersLength(request: { headers: Record<string, string | number> }): number {
  return Number(request.headers['content-length']);
}
