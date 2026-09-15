/**
 * S3-compatible endpoints come in two address styles, and the object key must
 * be identical in both.
 *
 *   path style          https://s3.region.host/bucket/key
 *   virtual-host style  https://bucket.s3.region.host/key
 *
 * ArvanCloud's documentation shows the virtual-host form, so an operator
 * pastes it into the endpoint field. If the driver then also prepends the
 * bucket, every object lands one level too deep — `bucket/workspace/<id>/…`
 * instead of `workspace/<id>/…`. That file is then invisible to every
 * prefix-scoped check (owner deletion included) and unreachable after the
 * vendor is promoted to primary, because reads look for the canonical key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { StorageConfig } from '../../../server/services/storage/index.js';
const { uploadWithConfig, listWithConfig, getFileUrlWithConfig } =
  await import('../../../server/services/storage/index.js');

interface Captured { method: string; url: string }

let captured: Captured[];
let restoreFetch: () => void;

function installStub(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    captured.push({ method: init?.method ?? 'GET', url });
    if ((init?.method ?? 'GET') === 'GET' && url.includes('list-type=2')) {
      return new Response(
        '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
        { status: 200 },
      );
    }
    return new Response('', { status: 200 });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = realFetch; };
}

beforeEach(() => { captured = []; restoreFetch = installStub(); });
afterEach(() => { restoreFetch(); });

const KEY = 'workspace/6ee40d07-32a3-4594-8a5f-d439f81afa5b/attachments/2026/a.jpg';

const virtualHost: StorageConfig = {
  provider: 'arvan_storage',
  bucket: 'webyar',
  endpoint: 'https://webyar.s3.ir-thr-at1.arvanstorage.ir',
  s3Region: 'ir-thr-at1',
  accessKeyId: 'ak',
  secretAccessKey: 'sk',
};

const pathStyle: StorageConfig = {
  provider: 'arvan_storage',
  bucket: 'webyar',
  endpoint: 'https://s3.ir-thr-at1.arvanstorage.ir',
  s3Region: 'ir-thr-at1',
  accessKeyId: 'ak',
  secretAccessKey: 'sk',
};

describe('virtual-host endpoints do not duplicate the bucket into the key', () => {
  it('uploads to /<key>, not /<bucket>/<key>, when the endpoint names the bucket', async () => {
    await uploadWithConfig(virtualHost, { fileKey: KEY, data: Buffer.from('x'), contentType: 'image/jpeg' });

    const put = captured.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe(`https://webyar.s3.ir-thr-at1.arvanstorage.ir/${KEY}`);
    expect(new URL(put.url).pathname).toBe(`/${KEY}`);
    // The failure this guards: the key silently becoming webyar/workspace/…
    expect(put.url).not.toContain('/webyar/workspace/');
  });

  it('still appends the bucket for a path-style endpoint', async () => {
    await uploadWithConfig(pathStyle, { fileKey: KEY, data: Buffer.from('x'), contentType: 'image/jpeg' });

    const put = captured.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe(`https://s3.ir-thr-at1.arvanstorage.ir/webyar/${KEY}`);
  });

  it('stores the SAME object key under both address styles', async () => {
    await uploadWithConfig(virtualHost, { fileKey: KEY, data: Buffer.from('x'), contentType: 'image/jpeg' });
    await uploadWithConfig(pathStyle, { fileKey: KEY, data: Buffer.from('x'), contentType: 'image/jpeg' });

    const [virtual, path] = captured.filter((c) => c.method === 'PUT');
    const keyOf = (url: string, bucketInPath: boolean) => {
      const p = new URL(url).pathname.replace(/^\//, '');
      return bucketInPath ? p.replace(/^webyar\//, '') : p;
    };
    expect(keyOf(virtual.url, false)).toBe(KEY);
    expect(keyOf(path.url, true)).toBe(KEY);
  });

  it('lists against the bucket root in both styles', async () => {
    await listWithConfig(virtualHost, 'workspace/');
    await listWithConfig(pathStyle, 'workspace/');

    const [virtual, path] = captured.filter((c) => c.url.includes('list-type=2'));
    expect(new URL(virtual.url).pathname).toBe('/');
    expect(new URL(path.url).pathname).toBe('/webyar');
  });
});

describe('a CDN base typed without a scheme still yields an absolute URL', () => {
  it('prefixes https:// for an S3-compatible vendor', () => {
    const url = getFileUrlWithConfig({ ...pathStyle, cdnUrl: 'cdn.webyar.ai' }, KEY);
    expect(url).toBe(`https://cdn.webyar.ai/${KEY}`);
  });

  it('prefixes https:// for Bunny', () => {
    const url = getFileUrlWithConfig(
      { provider: 'bunny_storage', storageZone: 'webyar', cdnUrl: 'cdn.webyar.ai' },
      KEY,
    );
    expect(url).toBe(`https://cdn.webyar.ai/${KEY}`);
  });

  it('leaves an explicit scheme alone', () => {
    const url = getFileUrlWithConfig({ ...pathStyle, cdnUrl: 'https://cdn.webyar.ai' }, KEY);
    expect(url).toBe(`https://cdn.webyar.ai/${KEY}`);
  });
});
