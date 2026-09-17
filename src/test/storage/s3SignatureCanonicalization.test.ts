/**
 * SIGV4 CANONICALIZATION — the regression guard for a bug that shipped.
 *
 * Every analytics object key is Hive-partitioned:
 *
 *   analytics/web/workspace=<uuid>/year=2026/month=08/day=10/part-*.parquet
 *
 * SigV4 signs the PERCENT-ENCODED path, and every S3-compatible server
 * canonicalizes the path it receives before verifying. Sending `workspace=x`
 * literally while the server verifies `workspace%3Dx` produces two different
 * signatures and a 403 SignatureDoesNotMatch — so for a while, every
 * analytics write to every S3 vendor failed.
 *
 * It survived two phases of tests because the existing suites stub `fetch`
 * and assert on *which bucket* a request reached, never on whether the
 * signature was correct. A stub that cannot reject a bad signature cannot
 * catch a signing bug.
 *
 * So this suite VERIFIES THE SIGNATURE. It recomputes SigV4 independently
 * from the request the driver produced and rejects it on mismatch, exactly
 * as a real server does. That is the only kind of test that could have
 * caught this, and the only kind that will catch it coming back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac, createHash } from 'node:crypto';

const { uploadWithConfig, downloadWithConfig, deleteWithConfig, listWithConfig, storageConfigFromRecord } =
  await import('../../../server/services/storage/index.js');

const ACCESS = 'AKIAEXAMPLE';
const SECRET = 'secretexamplekey123';
const REGION = 'us-east-1';
const BUCKET = 'analytics-bucket';
const ENDPOINT = 'http://objects.example.test:9000';

const config = storageConfigFromRecord('minio', {
  bucket: BUCKET, endpoint: ENDPOINT, access_key: ACCESS, secret_key: SECRET, region: REGION,
});

interface Seen { method: string; url: string; authorization: string; verified: boolean; reason?: string }
let seen: Seen[] = [];
let restore: () => void;

/**
 * Recompute the signature the way a server does, from the request as sent.
 *
 * Deliberately independent of the driver: it derives the canonical URI from
 * the URL's own path, which is what the server sees on the wire. If the
 * driver signed a differently-encoded path than it sent, these disagree —
 * which is precisely the shipped bug.
 */
function verify(method: string, url: string, headers: Record<string, string>): { ok: boolean; reason?: string } {
  const auth = headers['Authorization'] ?? headers['authorization'];
  if (!auth) return { ok: false, reason: 'no Authorization header' };

  const credMatch = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request/.exec(auth);
  const signedMatch = /SignedHeaders=([^,]+)/.exec(auth);
  const sigMatch = /Signature=([0-9a-f]+)/.exec(auth);
  if (!credMatch || !signedMatch || !sigMatch) return { ok: false, reason: 'malformed Authorization' };

  const [, keyId, dateStamp, region] = credMatch;
  const signedHeaders = signedMatch[1]!;
  const provided = sigMatch[1]!;
  if (keyId !== ACCESS) return { ok: false, reason: 'wrong access key' };

  const amzDate = headers['x-amz-date'] ?? headers['X-Amz-Date'] ?? '';
  const payloadHash = headers['x-amz-content-sha256'] ?? headers['X-Amz-Content-Sha256'] ?? '';
  const parsed = new URL(url);

  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  lower['host'] = parsed.host;

  const canonicalHeaders = signedHeaders
    .split(';')
    .map((h) => `${h}:${lower[h] ?? ''}`)
    .join('\n') + '\n';

  const canonicalRequest = [
    method,
    parsed.pathname,
    parsed.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const sts = [
    'AWS4-HMAC-SHA256', amzDate, scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const kDate = createHmac('sha256', `AWS4${SECRET}`).update(dateStamp!).digest();
  const kRegion = createHmac('sha256', kDate).update(region!).digest();
  const kService = createHmac('sha256', kRegion).update('s3').digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  const expected = createHmac('sha256', kSigning).update(sts).digest('hex');

  return expected === provided
    ? { ok: true }
    : { ok: false, reason: 'SignatureDoesNotMatch' };
}

function installVerifyingStub(): () => void {
  const real = globalThis.fetch;
  const store = new Map<string, Buffer>();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const result = verify(method, url, headers);
    seen.push({ method, url, authorization: headers['Authorization'] ?? '', verified: result.ok, reason: result.reason });

    // A real server rejects a bad signature. So does this.
    if (!result.ok) {
      return new Response(
        `<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code></Error>`,
        { status: 403 },
      );
    }

    const parsed = new URL(url);
    const key = parsed.pathname.split('/').slice(2).join('/');

    if (method === 'GET' && parsed.searchParams.get('list-type') === '2') {
      const prefix = parsed.searchParams.get('prefix') ?? '';
      const keys = [...store.keys()].filter((k) => decodeURIComponent(k).startsWith(prefix));
      return new Response(
        `<?xml version="1.0"?><ListBucketResult>${
          keys.map((k) => `<Contents><Key>${decodeURIComponent(k)}</Key></Contents>`).join('')
        }<IsTruncated>false</IsTruncated></ListBucketResult>`,
        { status: 200 },
      );
    }
    if (method === 'PUT') {
      const body = init?.body as ArrayBuffer | ArrayBufferView | string | undefined;
      const bytes = ArrayBuffer.isView(body)
        ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
        : body instanceof ArrayBuffer ? Buffer.from(body) : Buffer.from(String(body ?? ''));
      store.set(key, Buffer.from(bytes));
      return new Response('', { status: 200 });
    }
    if (method === 'DELETE') { store.delete(key); return new Response(null, { status: 204 }); }
    const found = store.get(key);
    return found === undefined
      ? new Response('', { status: 404 })
      : new Response(found, { status: 200 });
  }) as typeof globalThis.fetch;

  return () => { globalThis.fetch = real; };
}

beforeEach(() => { seen = []; restore = installVerifyingStub(); });
afterEach(() => { restore(); });

/** The real shape: Hive partitioning puts '=' in four places. */
const ANALYTICS_KEY =
  'analytics/web/workspace=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/year=2026/month=08/day=10/part-20260810T100000-abc123.parquet';

describe('the signature is actually checked', () => {
  it('rejects a tampered signature, so a passing test means something', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = { ...(init?.headers ?? {}) } as Record<string, string>;
      headers['Authorization'] = String(headers['Authorization'] ?? '').replace(/Signature=[0-9a-f]+/, 'Signature=' + '0'.repeat(64));
      return real(input, { ...init, headers });
    }) as typeof globalThis.fetch;

    const put = await uploadWithConfig(config, {
      fileKey: 'plain.parquet', data: Buffer.from('x'), contentType: 'application/octet-stream',
    });
    globalThis.fetch = real;
    expect(put.success).toBe(false);
  });
});

describe('Hive-partitioned analytics keys', () => {
  it('PUT signs the same encoded path it sends', async () => {
    const data = Buffer.from('parquet-bytes');
    const put = await uploadWithConfig(config, {
      fileKey: ANALYTICS_KEY, data, contentType: 'application/vnd.apache.parquet',
    });
    expect(put.success, seen[0]?.reason ?? '').toBe(true);
    expect(seen.every((s) => s.verified)).toBe(true);
  });

  it('sends "=" percent-encoded on the wire', async () => {
    await uploadWithConfig(config, {
      fileKey: ANALYTICS_KEY, data: Buffer.from('x'), contentType: 'application/octet-stream',
    });
    const url = seen[0]!.url;
    expect(url).toContain('workspace%3D');
    expect(url).toContain('year%3D2026');
    expect(url).not.toContain('workspace=');
  });

  it('round-trips PUT then GET', async () => {
    const data = Buffer.from('round-trip-bytes');
    await uploadWithConfig(config, {
      fileKey: ANALYTICS_KEY, data, contentType: 'application/octet-stream',
    });
    const got = await downloadWithConfig(config, ANALYTICS_KEY);
    expect(got.success).toBe(true);
    expect(got.data?.equals(data)).toBe(true);
  });

  it('DELETE signs correctly too', async () => {
    await uploadWithConfig(config, {
      fileKey: ANALYTICS_KEY, data: Buffer.from('x'), contentType: 'application/octet-stream',
    });
    const removed = await deleteWithConfig(config, ANALYTICS_KEY);
    expect(removed.success).toBe(true);
  });

  it('LIST signs a canonical query string', async () => {
    await uploadWithConfig(config, {
      fileKey: ANALYTICS_KEY, data: Buffer.from('x'), contentType: 'application/octet-stream',
    });
    const listed = await listWithConfig(config, 'analytics/web/');
    expect(listed.success, seen.find((s) => !s.verified)?.reason ?? '').toBe(true);
    expect(listed.keys).toContain(ANALYTICS_KEY);
  });

  it('LIST sorts query parameters, as SigV4 requires', async () => {
    await listWithConfig(config, 'analytics/web/', 'cursor-token');
    const url = seen[seen.length - 1]!.url;
    const query = new URL(url).search.slice(1);
    const keys = query.split('&').map((p) => p.split('=')[0]!);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('other key shapes', () => {
  // '+' is the other character new URL() leaves alone but SigV4 encodes.
  for (const [label, key] of [
    ['plain', 'plain.parquet'],
    ['nested', 'a/b/c.parquet'],
    ['plus', 'a/b+c.parquet'],
    ['space', 'a/b c.parquet'],
    ['tilde', 'a/b~c.parquet'],
    ['parens', "a/b(1)'x.parquet"],
  ] as const) {
    it(`signs and round-trips a ${label} key`, async () => {
      const data = Buffer.from(label);
      const put = await uploadWithConfig(config, {
        fileKey: key, data, contentType: 'application/octet-stream',
      });
      expect(put.success, seen.find((s) => !s.verified)?.reason ?? '').toBe(true);
      const got = await downloadWithConfig(config, key);
      expect(got.data?.equals(data)).toBe(true);
    });
  }
});

describe('general storage keys still work', () => {
  // The fix touches shared code, so the non-analytics namespaces must be
  // unaffected — these are the shapes the general pool actually writes.
  for (const key of [
    'workspace/11111111-1111-1111-1111-111111111111/uploads/logo.png',
    'users/22222222-2222-2222-2222-222222222222/avatar.jpg',
    'platform/branding/favicon.ico',
  ]) {
    it(`round-trips ${key.split('/')[0]}/`, async () => {
      const data = Buffer.from(key);
      const put = await uploadWithConfig(config, {
        fileKey: key, data, contentType: 'application/octet-stream',
      });
      expect(put.success).toBe(true);
      const got = await downloadWithConfig(config, key);
      expect(got.data?.equals(data)).toBe(true);
    });
  }
});
