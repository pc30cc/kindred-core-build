/**
 * The WHMCS protocol, checked against the SAME vectors the PHP addon's suite
 * verifies (plugins/webyar-whmcs/tests/fixtures/protocol-vectors.json): the
 * request signature and an addon-issued identity assertion. If either side
 * changes its string-to-sign or envelope, one of the two suites fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeSignature, sha256Hex } from '../../../server/services/commerce/signing.js';
import { parseWhmcsAssertion, signWhmcsAssertion, isWhmcsAssertion } from '../../../server/services/commerce/whmcs/identity.js';
import { CommerceError } from '../../../shared/commerce/types.js';

const vectors = JSON.parse(readFileSync(resolve(process.cwd(), 'plugins/webyar-whmcs/tests/fixtures/protocol-vectors.json'), 'utf8')) as {
  secret: string;
  request: Record<string, string>;
  assertion: { now: number; workspace_id: string; token: string; payload: Record<string, unknown> };
};

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
function mint(over: Record<string, unknown>, secret = vectors.secret): string {
  const signed = `whmcs1.${b64url(JSON.stringify({ ...vectors.assertion.payload, ...over }))}`;
  return `${signed}.${signWhmcsAssertion(secret, signed)}`;
}
function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof CommerceError ? err.code : 'other';
  }
}

describe('request signature (shared vector)', () => {
  it('the TypeScript signer produces the signature the PHP addon expects', () => {
    const r = vectors.request;
    expect(sha256Hex(r.body)).toBe(r.string_to_sign.split('\n')[6]);
    const signature = computeSignature(vectors.secret, {
      protocolVersion: r.protocol, method: r.method, canonicalPath: r.path, installationId: r.installation_id,
      timestamp: r.timestamp, nonce: r.nonce, bodySha256Hex: sha256Hex(r.body),
    });
    expect(signature).toBe(r.signature);
  });
});

describe('identity assertion (shared vector)', () => {
  const { now, workspace_id: ws, token } = vectors.assertion;

  it('accepts the assertion the PHP addon minted, and its signature checks out', () => {
    expect(isWhmcsAssertion(token)).toBe(true);
    const parsed = parseWhmcsAssertion(token, ws, now);
    expect(parsed.payload.uid).toBe('1');
    expect(parsed.payload.cid).toBe('10');
    expect(signWhmcsAssertion(vectors.secret, parsed.signedPart)).toBe(parsed.signature);
  });

  it('rejects the wrong workspace, expiry, a future iat, an over-long lifetime and staleness', () => {
    expect(code(() => parseWhmcsAssertion(token, '11111111-1111-1111-1111-111111111111', now))).toBe('identity_expired');
    expect(code(() => parseWhmcsAssertion(token, ws, now + 1000))).toBe('identity_expired');
    expect(code(() => parseWhmcsAssertion(mint({ iat: now + 600, exp: now + 900 }), ws, now))).toBe('identity_expired');
    expect(code(() => parseWhmcsAssertion(mint({ iat: now - 10, exp: now + 3600 }), ws, now))).toBe('identity_expired');
    expect(code(() => parseWhmcsAssertion(mint({ iat: now - 2000, exp: now - 1700 }), ws, now))).toBe('identity_expired');
  });

  it('rejects anything off-schema', () => {
    const bad: Array<Record<string, unknown>> = [
      { aud: 'someone-else' }, { v: 2 }, { typ: 'woo' }, { gid: 'short' }, { uid: 'abc' }, { cid: '-1' },
      { jti: 'not hex!' }, { iss: 'not-a-uuid' }, { email: 'not-an-email' }, { iat: '1790000000' },
    ];
    for (const over of bad) expect(code(() => parseWhmcsAssertion(mint(over), ws, now)), JSON.stringify(over)).toBe('identity_expired');
    expect(code(() => parseWhmcsAssertion('whmcs1.onlytwo', ws, now))).toBe('identity_expired');
    expect(code(() => parseWhmcsAssertion(token.replace(/^whmcs1\./, 'woo1.'), ws, now))).toBe('identity_expired');
  });
});
