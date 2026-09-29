/**
 * S3 ListObjectsV2 requests must carry a valid SigV4 signature.
 *
 * The signer used to put the query string into the canonical request exactly
 * as written (`list-type=2&prefix=…&max-keys=1000`). SigV4 requires the
 * parameters sorted by name, and every S3 server rebuilds the canonical
 * request that way — so every list call was rejected with 403
 * SignatureDoesNotMatch (seen live against ArvanCloud). Uploads and deletes
 * have no query string and kept working, which hid it; but workspace and
 * account deletion list each storage scope before deleting it, so no deletion
 * touching an S3 scope could ever complete — the admin "delete user" button
 * reported success while nothing was removed.
 *
 * The check below re-derives the signature the way a server does, from the
 * request as received, independently of the client's own canonicalisation.
 */
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { StorageConfig } from '../../../server/services/storage/index.js';
const { listWithConfig, sigV4CanonicalQuery } = await import('../../../server/services/storage/index.js');

const config: StorageConfig = {
  provider: 'arvan_storage',
  bucket: 'webyar',
  endpoint: 'https://webyar.s3.ir-thr-at1.arvanstorage.ir',
  s3Region: 'ir-thr-at1',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();
const rfc3986 = (v: string) =>
  encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** What an S3 server computes from the request it receives (AWS SigV4 spec). */
function serverSideSignature(method: string, url: string, headers: Record<string, string>, secret: string): string {
  const parsed = new URL(url);
  const auth = headers.Authorization;
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)![1].split(';');
  const scope = /Credential=[^/]+\/([^,]+)/.exec(auth)![1];
  const [date, region, service] = scope.split('/');

  const query = [...parsed.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalRequest = [
    method,
    parsed.pathname.split('/').map((s) => rfc3986(decodeURIComponent(s))).join('/'),
    query,
    signedHeaders.map((h) => `${h}:${lower[h]}`).join('\n') + '\n',
    signedHeaders.join(';'),
    lower['x-amz-content-sha256'],
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    lower['x-amz-date'],
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
  return crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
}

let captured: Array<{ url: string; headers: Record<string, string> }>;
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  captured = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), headers: init?.headers as Record<string, string> });
    return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
  }) as typeof globalThis.fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('S3 list signing', () => {
  it('signs a ListObjectsV2 request the way the server verifies it', async () => {
    const res = await listWithConfig(config, 'workspace/f71f1064-9da6-45ae-badb-3827e5a17cf0/');
    expect(res.success).toBe(true);

    const { url, headers } = captured[0];
    const sent = /Signature=([0-9a-f]+)/.exec(headers.Authorization)![1];
    expect(sent).toBe(serverSideSignature('GET', url, headers, config.secretAccessKey!));
  });

  it('also signs continuation tokens containing characters that need encoding', async () => {
    await listWithConfig(config, 'users/a b/', '1/ab+cd==*');

    const { url, headers } = captured[0];
    expect(new URL(url).searchParams.get('continuation-token')).toBe('1/ab+cd==*');
    expect(new URL(url).searchParams.get('prefix')).toBe('users/a b/');
    const sent = /Signature=([0-9a-f]+)/.exec(headers.Authorization)![1];
    expect(sent).toBe(serverSideSignature('GET', url, headers, config.secretAccessKey!));
  });
});

describe('sigV4CanonicalQuery', () => {
  it('sorts parameters by name regardless of the order they were written in', () => {
    expect(sigV4CanonicalQuery('?list-type=2&prefix=workspace%2Fx%2F&max-keys=1000')).toBe(
      'list-type=2&max-keys=1000&prefix=workspace%2Fx%2F',
    );
  });

  it('encodes per RFC 3986 (spaces as %20, not +)', () => {
    expect(sigV4CanonicalQuery('?prefix=a+b&x=(1)')).toBe('prefix=a%20b&x=%281%29');
  });

  it('is empty for a request without a query string', () => {
    expect(sigV4CanonicalQuery('')).toBe('');
  });
});
