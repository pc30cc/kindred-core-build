/**
 * Request signing — pure cryptographic logic (spec §71: invalid signature,
 * modified body, expired timestamp, reused nonce all fail closed). Nonce
 * replay itself is DB-backed (server/services/commerce/signing.ts's
 * verifyIncomingSignature) and covered by
 * src/test/commerce/eventIngestion.test.ts; this file covers the
 * signature/skew logic in isolation.
 */
import { describe, it, expect } from 'vitest';
import {
  computeSignature,
  constantTimeEquals,
  sha256Hex,
  buildSignedHeaders,
  CLOCK_SKEW_SECONDS,
} from '../../../server/services/commerce/signing.js';
import { COMMERCE_PROTOCOL_VERSION } from '../../../shared/commerce/types.js';

describe('commerce request signing', () => {
  it('produces headers that verify against a hand-computed signature', () => {
    const secret = 'installation-secret';
    const headers = buildSignedHeaders(secret, 'inst-1', 'POST', '/api/commerce/events', '{"a":1}');

    const expected = computeSignature(secret, {
      protocolVersion: COMMERCE_PROTOCOL_VERSION,
      method: 'POST',
      canonicalPath: '/api/commerce/events',
      installationId: 'inst-1',
      timestamp: headers['X-WebYar-Timestamp'],
      nonce: headers['X-WebYar-Nonce'],
      bodySha256Hex: sha256Hex('{"a":1}'),
    });

    expect(constantTimeEquals(expected, headers['X-WebYar-Signature'])).toBe(true);
  });

  it('a modified body after signing produces a different signature', () => {
    const secret = 'installation-secret';
    const headers = buildSignedHeaders(secret, 'inst-1', 'POST', '/api/commerce/events', '{"a":1}');
    const tamperedSignature = computeSignature(secret, {
      protocolVersion: COMMERCE_PROTOCOL_VERSION,
      method: 'POST',
      canonicalPath: '/api/commerce/events',
      installationId: 'inst-1',
      timestamp: headers['X-WebYar-Timestamp'],
      nonce: headers['X-WebYar-Nonce'],
      bodySha256Hex: sha256Hex('{"a":2}'), // different body
    });
    expect(constantTimeEquals(tamperedSignature, headers['X-WebYar-Signature'])).toBe(false);
  });

  it('a wrong installation secret produces a different signature', () => {
    const headers = buildSignedHeaders('secret-a', 'inst-1', 'GET', '/wp-json/webyar/v1/health', '');
    const wrongSecretSig = computeSignature('secret-b', {
      protocolVersion: COMMERCE_PROTOCOL_VERSION,
      method: 'GET',
      canonicalPath: '/wp-json/webyar/v1/health',
      installationId: 'inst-1',
      timestamp: headers['X-WebYar-Timestamp'],
      nonce: headers['X-WebYar-Nonce'],
      bodySha256Hex: sha256Hex(''),
    });
    expect(constantTimeEquals(wrongSecretSig, headers['X-WebYar-Signature'])).toBe(false);
  });

  it('a signature bound to a different canonical path does not verify', () => {
    const secret = 'installation-secret';
    const headers = buildSignedHeaders(secret, 'inst-1', 'POST', '/wp-json/webyar/v1/orders/lookup', '{}');
    const forOtherPath = computeSignature(secret, {
      protocolVersion: COMMERCE_PROTOCOL_VERSION,
      method: 'POST',
      canonicalPath: '/wp-json/webyar/v1/orders/tracking', // different route
      installationId: 'inst-1',
      timestamp: headers['X-WebYar-Timestamp'],
      nonce: headers['X-WebYar-Nonce'],
      bodySha256Hex: sha256Hex('{}'),
    });
    expect(constantTimeEquals(forOtherPath, headers['X-WebYar-Signature'])).toBe(false);
  });

  it('constantTimeEquals rejects mismatched lengths without throwing', () => {
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('the configured clock skew window is bounded (not unlimited)', () => {
    expect(CLOCK_SKEW_SECONDS).toBeGreaterThan(0);
    expect(CLOCK_SKEW_SECONDS).toBeLessThanOrEqual(600);
  });
});
