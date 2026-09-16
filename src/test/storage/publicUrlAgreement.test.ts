/**
 * The URL an upload returns and the URL a read derives must be the same URL.
 *
 * They are produced by two different functions per provider, and the two used
 * to normalize differently: Bunny's read path ran the operator's `cdn_url`
 * through `publicBase()` (which supplies a scheme when the value has none)
 * while its upload path used the raw value. A caller that PERSISTED the
 * upload's URL therefore stored something a later read would not reproduce —
 * and an operator who typed a bare hostname got a "URL" with no scheme at
 * all, which anything rendering it treats as a relative path.
 *
 * This is the class of bug that leaves an old CDN hostname frozen in a
 * database row long after the provider behind it changed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StorageConfig } from '../../../server/services/storage/index.js';

const { uploadWithConfig, getFileUrlWithConfig } =
  await import('../../../server/services/storage/index.js');

let restoreFetch: () => void;

beforeEach(() => {
  const realFetch = globalThis.fetch;
  // Every provider's upload is a single PUT; nothing here needs a body back.
  globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof globalThis.fetch;
  restoreFetch = () => { globalThis.fetch = realFetch; };
});
afterEach(() => { restoreFetch(); });

const KEY = 'workspace/6ee40d07-32a3-4594-8a5f-d439f81afa5b/branding/icon.jpg';

const bunny = (cdnUrl?: string): StorageConfig => ({
  provider: 'bunny_storage',
  storageZone: 'examplezone',
  apiKey: 'key',
  ...(cdnUrl ? { cdnUrl } : {}),
});

const s3 = (cdnUrl?: string): StorageConfig => ({
  provider: 'arvan_storage',
  bucket: 'examplebucket',
  endpoint: 'https://s3.ir-thr-at1.arvanstorage.ir',
  s3Region: 'ir-thr-at1',
  accessKeyId: 'ak',
  secretAccessKey: 'sk',
  ...(cdnUrl ? { cdnUrl } : {}),
});

/** Every shape an operator can plausibly type into the CDN field. */
const CDN_VALUES = [
  undefined,                          // no pull zone configured
  'https://cdn.example.com',          // the documented form
  'http://cdn.example.com',           // plain http, deliberately preserved
  'cdn.example.com',                  // bare hostname — no scheme typed
  'https://cdn.example.com/',         // trailing slash
];

describe('upload and read agree on the public URL', () => {
  for (const [name, make] of [['bunny', bunny], ['s3-compatible', s3]] as const) {
    for (const cdnUrl of CDN_VALUES) {
      it(`${name} · cdn_url=${cdnUrl ?? '(none)'}`, async () => {
        const config = make(cdnUrl);
        const uploaded = await uploadWithConfig(config, {
          fileKey: KEY, data: Buffer.from('x'), contentType: 'image/jpeg',
        });
        expect(uploaded.success, uploaded.error).toBe(true);
        expect(uploaded.url).toBe(getFileUrlWithConfig(config, KEY));
      });
    }
  }
});

describe('a derived public URL is always a URL', () => {
  it('supplies a scheme the operator did not type', () => {
    // A schemeless "URL" renders as a relative path, so the asset 404s on
    // whatever page happens to embed it.
    const config = bunny('cdn.example.com');
    expect(getFileUrlWithConfig(config, KEY)).toBe(`https://cdn.example.com/${KEY}`);
  });

  it('keeps a scheme the operator DID type, including plain http', () => {
    // Rewriting http→https here would break a pull zone that genuinely has
    // no TLS; that is the operator's call, not this function's.
    expect(getFileUrlWithConfig(bunny('http://cdn.example.com'), KEY))
      .toBe(`http://cdn.example.com/${KEY}`);
  });

  it('falls back to the storage zone hostname when no pull zone is set', () => {
    expect(getFileUrlWithConfig(bunny(), KEY))
      .toBe(`https://examplezone.b-cdn.net/${KEY}`);
  });
});
