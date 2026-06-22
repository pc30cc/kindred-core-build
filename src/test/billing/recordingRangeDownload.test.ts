/**
 * Tests for the read-only ranged recording download path.
 *
 * Scope (intentionally narrow):
 *   1. downloadFileRange honors a Range header on the local provider
 *      and returns 206 with the exact byte slice and a correct
 *      Content-Range string.
 *   2. Without a Range header it returns a full 200 body (backward
 *      compatible with the existing downloadFile path).
 *   3. An unsatisfiable range surfaces 416 without throwing.
 *
 * The local provider is fully deterministic and exercises the same
 * range-parsing/slice code paths used by the admin recording proxy.
 * Provider-specific networked variants (S3-family, Bunny) are not
 * unit-tested here because they delegate to the same upstream
 * Range/Content-Range contract via fetch.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Force resolveStorageConfig to hit its final fallback: { provider: 'local',
// localPath: '/tmp/storage' }. We do this by stubbing the supabase client so
// every query returns no rows — no workspace override, no global default.
vi.mock('../../../server/supabase.js', () => {
  const builder: any = {
    from: () => builder,
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    single: async () => ({ data: null }),
    maybeSingle: async () => ({ data: null }),
  };
  return { getServiceClient: () => builder };
});

import * as storage from '../../../server/services/storage/index';

const STORAGE_DIR = '/tmp/storage';
const KEY = `range-test-${Date.now()}.bin`;
const FILE = join(STORAGE_DIR, KEY);

beforeAll(() => {
  if (!existsSync(STORAGE_DIR)) mkdirSync(STORAGE_DIR, { recursive: true });
  writeFileSync(FILE, Buffer.from('0123456789ABCDEF'));
});

afterAll(() => {
  try { unlinkSync(FILE); } catch { /* noop */ }
});

describe('downloadFileRange (local provider)', () => {
  it('returns full body with status 200 when no Range header is provided', async () => {
    const r = await storage.downloadFileRange({} as any, 'ws', 'sample.bin');
    expect(r.success).toBe(true);
    expect(r.status).toBe(200);
    expect(r.data?.toString()).toBe('0123456789ABCDEF');
    expect(r.contentLength).toBe(16);
  });

  it('returns the exact slice with 206 + Content-Range when Range is provided', async () => {
    const r = await storage.downloadFileRange({} as any, 'ws', 'sample.bin', 'bytes=4-9');
    expect(r.success).toBe(true);
    expect(r.status).toBe(206);
    expect(r.data?.toString()).toBe('456789');
    expect(r.contentLength).toBe(6);
    expect(r.contentRange).toBe('bytes 4-9/16');
  });

  it('clamps open-ended ranges to total size', async () => {
    const r = await storage.downloadFileRange({} as any, 'ws', 'sample.bin', 'bytes=10-');
    expect(r.status).toBe(206);
    expect(r.data?.toString()).toBe('ABCDEF');
    expect(r.contentRange).toBe('bytes 10-15/16');
  });

  it('surfaces 416 for ranges past end of file', async () => {
    const r = await storage.downloadFileRange({} as any, 'ws', 'sample.bin', 'bytes=999-');
    expect(r.success).toBe(false);
    expect(r.status).toBe(416);
    expect(r.totalSize).toBe(16);
  });
});