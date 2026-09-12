/**
 * X (Twitter) DM channel — pure logic that can be verified without a live
 * X API credential: OAuth 1.0a request signing and the DM-event → Bot-API
 * translator. (Everything else — send/poll — is a thin network client
 * exercised the same way Instagram/WhatsApp's are: manually, against a real
 * connected account, since there is no sandboxed X API to run in CI.)
 */
import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  buildOAuth1Header,
  parseXCredential,
  percentEncode,
  redactXToken,
} from '../../../channels/providers/x/client.js';
import { xDmEventsToBotUpdates } from '../../../server/services/channels/x/toBotUpdate.js';
import type { XDmEvent } from '../../../shared/channels/xDmEvent.js';

const CRED = {
  apiKey: 'consumer-key',
  apiSecret: 'consumer-secret',
  accessToken: 'user-token',
  accessTokenSecret: 'user-token-secret',
};

/** Parses `OAuth k1="v1", k2="v2"` back into a plain object for re-derivation. */
function parseHeader(header: string): Record<string, string> {
  const body = header.replace(/^OAuth\s+/, '');
  const params: Record<string, string> = {};
  for (const pair of body.split(', ')) {
    const eq = pair.indexOf('=');
    const key = decodeURIComponent(pair.slice(0, eq));
    const value = decodeURIComponent(pair.slice(eq + 1).replace(/^"|"$/g, ''));
    params[key] = value;
  }
  return params;
}

describe('X OAuth 1.0a signing', () => {
  it('percent-encodes reserved characters per RFC 3986, unlike encodeURIComponent', () => {
    expect(percentEncode("a b!c*d'e(f)g")).toBe('a%20b%21c%2Ad%27e%28f%29g');
    expect(encodeURIComponent("!*'()")).toBe("!*'()"); // the gap this function closes
  });

  it('produces a header whose signature independently re-derives to the same value', () => {
    const url = 'https://api.twitter.com/2/dm_conversations/123/messages';
    const header = buildOAuth1Header(CRED, 'POST', url, { foo: 'bar baz' }, null);
    const params = parseHeader(header);

    expect(params.oauth_consumer_key).toBe(CRED.apiKey);
    expect(params.oauth_token).toBe(CRED.accessToken);
    expect(params.oauth_signature_method).toBe('HMAC-SHA1');
    expect(params.oauth_version).toBe('1.0');

    // Re-derive the signature from the header's own nonce/timestamp plus the
    // known query params, exactly as the OAuth 1.0a spec defines it.
    const allParams: Record<string, string> = {
      oauth_consumer_key: params.oauth_consumer_key,
      oauth_nonce: params.oauth_nonce,
      oauth_signature_method: params.oauth_signature_method,
      oauth_timestamp: params.oauth_timestamp,
      oauth_token: params.oauth_token,
      oauth_version: params.oauth_version,
      foo: 'bar baz',
    };
    const paramString = Object.keys(allParams)
      .sort()
      .map((key) => `${percentEncode(key)}=${percentEncode(allParams[key])}`)
      .join('&');
    const baseString = `POST&${percentEncode(url)}&${percentEncode(paramString)}`;
    const signingKey = `${percentEncode(CRED.apiSecret)}&${percentEncode(CRED.accessTokenSecret)}`;
    const expectedSignature = createHmac('sha1', signingKey).update(baseString).digest('base64');

    expect(params.oauth_signature).toBe(expectedSignature);
  });

  it('a different consumer secret produces a different signature', () => {
    const url = 'https://api.twitter.com/2/users/me';
    const a = parseHeader(buildOAuth1Header(CRED, 'GET', url, null, null)).oauth_signature;
    const b = parseHeader(buildOAuth1Header({ ...CRED, apiSecret: 'different' }, 'GET', url, null, null))
      .oauth_signature;
    expect(a).not.toBe(b);
  });

  it('query params change the signature (they are part of the signature base)', () => {
    const url = 'https://api.twitter.com/2/dm_events';
    const a = parseHeader(buildOAuth1Header(CRED, 'GET', url, { max_results: '50' }, null)).oauth_signature;
    const b = parseHeader(buildOAuth1Header(CRED, 'GET', url, { max_results: '10' }, null)).oauth_signature;
    expect(a).not.toBe(b);
  });
});

describe('X credential parsing', () => {
  it('parses a complete envelope', () => {
    const cred = parseXCredential(JSON.stringify({
      api_key: 'k', api_secret: 's', access_token: 't', access_token_secret: 'ts',
    }));
    expect(cred).toEqual({ apiKey: 'k', apiSecret: 's', accessToken: 't', accessTokenSecret: 'ts' });
  });

  it('rejects a JSON envelope missing any of the four fields', () => {
    expect(() => parseXCredential(JSON.stringify({ api_key: 'k', api_secret: 's', access_token: 't' })))
      .toThrow(/missing/);
  });

  it('rejects a non-JSON credential', () => {
    expect(() => parseXCredential('not-json')).toThrow(/JSON envelope/);
  });

  it('redacts an OAuth1 access token shape from log output', () => {
    const text = `token=${'a'.repeat(40)}-${'b'.repeat(30)} rest`;
    expect(redactXToken(text)).toBe('token=[REDACTED_ACCESS_TOKEN] rest');
  });
});

describe('X DM events → Bot-API updates', () => {
  const baseEvent: XDmEvent = {
    id: '1900000000000000001',
    text: 'Hello there',
    eventType: 'MessageCreate',
    createdAt: '2026-09-10T12:00:00.000Z',
    dmConversationId: 'dm-conv-1',
    senderId: 'user-42',
    senderUsername: 'someone',
    mediaUrls: [],
  };

  it('translates a text DM into a Bot-API message keyed by the conversation id', () => {
    const [update] = xDmEventsToBotUpdates([baseEvent], 'self-1');
    expect(update.message.chat.id).toBe('dm-conv-1');
    expect(update.message.from.id).toBe('user-42');
    expect(update.message.text).toBe('Hello there');
  });

  it('drops the connected account\'s own outbound echoes', () => {
    const updates = xDmEventsToBotUpdates([{ ...baseEvent, senderId: 'self-1' }], 'self-1');
    expect(updates).toEqual([]);
  });

  it('drops events with neither text nor a resolvable attachment', () => {
    const updates = xDmEventsToBotUpdates([{ ...baseEvent, text: null }], 'self-1');
    expect(updates).toEqual([]);
  });

  it('maps a photo attachment into the shared photo shape', () => {
    const event: XDmEvent = { ...baseEvent, text: null, mediaUrls: [{ kind: 'photo', url: 'https://pbs.twimg.com/x.jpg' }] };
    const [update] = xDmEventsToBotUpdates([event], 'self-1');
    expect(update.message.photo[0].file_id).toBe('https://pbs.twimg.com/x.jpg');
  });

  it('produces a stable numeric message id for the same event id', () => {
    const [a] = xDmEventsToBotUpdates([baseEvent], 'self-1');
    const [b] = xDmEventsToBotUpdates([baseEvent], 'self-1');
    expect(a.message.message_id).toBe(b.message.message_id);
    expect(typeof a.message.message_id).toBe('number');
  });
});
