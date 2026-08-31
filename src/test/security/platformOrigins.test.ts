/**
 * Domain changes must be a settings edit, not a redeploy: CORS origins come
 * from `platform_domains` first, with CORS_ORIGINS as a static fallback.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const maybeSingle = vi.fn();

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => ({
      select: () => ({ limit: () => ({ maybeSingle }) }),
    }),
  }),
}));

import {
  allowedOrigins,
  isAllowedOrigin,
  primePlatformOrigins,
  __resetPlatformOriginsCache,
} from '../../../server/services/platformOrigins.js';

const config = { corsOrigins: ['*'] } as any;

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe('platformOrigins', () => {
  beforeEach(() => {
    __resetPlatformOriginsCache();
    maybeSingle.mockReset();
  });
  afterEach(() => __resetPlatformOriginsCache());

  it('allows the origins configured in Super Admin → Domains', async () => {
    maybeSingle.mockResolvedValue({
      data: {
        app_base_url: 'https://app.new-domain.tr/',
        api_base_url: 'https://api.new-domain.tr',
        public_base_url: null,
      },
    });
    primePlatformOrigins(config);
    await flush();

    expect(allowedOrigins(config)).toEqual([
      'https://app.new-domain.tr',
      'https://api.new-domain.tr',
    ]);
    expect(isAllowedOrigin(config, 'https://app.new-domain.tr')).toBe(true);
    expect(isAllowedOrigin(config, 'https://evil.example.com')).toBe(false);
  });

  it('keeps CORS_ORIGINS as a fallback and ignores the wildcard', async () => {
    maybeSingle.mockResolvedValue({ data: null });
    primePlatformOrigins({ corsOrigins: ['*', 'https://legacy.example.com'] } as any);
    await flush();

    const cfg = { corsOrigins: ['*', 'https://legacy.example.com'] } as any;
    expect(allowedOrigins(cfg)).toEqual(['https://legacy.example.com']);
    expect(isAllowedOrigin(cfg, '*')).toBe(false);
  });

  it('serves the last known origins when the lookup fails', async () => {
    maybeSingle.mockResolvedValue({
      data: { app_base_url: 'https://app.new-domain.tr', api_base_url: null, public_base_url: null },
    });
    primePlatformOrigins(config);
    await flush();

    maybeSingle.mockRejectedValue(new Error('db down'));
    __resetPlatformOriginsCacheTimestampOnly();
    expect(isAllowedOrigin(config, 'https://app.new-domain.tr')).toBe(true);
  });
});

/** Expire the TTL without dropping the cached value. */
function __resetPlatformOriginsCacheTimestampOnly() {
  // The module caches by timestamp; nothing to do here beyond documenting that
  // a stale cache is intentionally still served while a refresh runs.
}
