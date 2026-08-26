/**
 * server/services/auth-email.ts's resolveAppBaseUrl.
 *
 * Before this fix, the fallback chain ended in `config.corsOrigins[0]`.
 * server/config.ts defaults CORS_ORIGINS to '*' when unset, so a
 * deployment with no platform_domains.app_base_url and no APP_BASE_URL
 * could generate a broken link starting with a literal wildcard character
 * followed by "/auth/reset-password?token=..." — never a valid URL,
 * silently, in a real email. This proves the fixed preference order
 * (platform domain > APP_BASE_URL > a real CORS origin > fail loudly in
 * production) and that the wildcard can never surface as a base URL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerConfig } from '../../../server/config.js';

let platformDomainRow: { app_base_url: string } | null = null;

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      return {
        select: () => ({
          limit: () => ({
            maybeSingle: async () => {
              if (table === 'platform_domains') return { data: platformDomainRow, error: null };
              return { data: null, error: null };
            },
          }),
        }),
      };
    },
  }),
}));

const { resolveAppBaseUrl } = await import('../../../server/services/auth-email.js');

function makeConfig(corsOrigins: string[]): ServerConfig {
  return {
    port: 3001,
    supabaseUrl: 'http://x',
    supabaseAnonKey: 'k',
    supabaseServiceRoleKey: 'k',
    corsOrigins,
    rateLimitWindowMs: 60000,
    rateLimitMax: 100,
    selfHostBillingUnlimited: false,
  };
}

describe('resolveAppBaseUrl', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    platformDomainRow = null;
    delete process.env.APP_BASE_URL;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('prefers a configured platform_domains.app_base_url over everything else', async () => {
    platformDomainRow = { app_base_url: 'https://platform-domain.example.com' };
    process.env.APP_BASE_URL = 'https://env-var.example.com';
    const url = await resolveAppBaseUrl(makeConfig(['https://cors.example.com']));
    expect(url).toBe('https://platform-domain.example.com');
  });

  it('strips a trailing slash from the platform domain', async () => {
    platformDomainRow = { app_base_url: 'https://platform-domain.example.com/' };
    const url = await resolveAppBaseUrl(makeConfig(['*']));
    expect(url).toBe('https://platform-domain.example.com');
  });

  it('falls back to APP_BASE_URL when no platform domain is configured', async () => {
    process.env.APP_BASE_URL = 'https://env-var.example.com';
    const url = await resolveAppBaseUrl(makeConfig(['*']));
    expect(url).toBe('https://env-var.example.com');
  });

  it('falls back to a configured CORS origin ONLY if it is a real absolute http(s) URL', async () => {
    const url = await resolveAppBaseUrl(makeConfig(['https://dashboard.example.com', 'https://other.example.com']));
    expect(url).toBe('https://dashboard.example.com');
  });

  it('NEVER uses the literal "*" wildcard as a base URL', async () => {
    process.env.NODE_ENV = 'development';
    const url = await resolveAppBaseUrl(makeConfig(['*']));
    expect(url).not.toContain('*');
    expect(url).toBe('http://localhost:5173');
  });

  it('CORS_ORIGINS="*" with no platform domain and no APP_BASE_URL falls through to the dev fallback outside production', async () => {
    process.env.NODE_ENV = 'test';
    const url = await resolveAppBaseUrl(makeConfig(['*']));
    expect(url).toBe('http://localhost:5173');
  });

  it('in production, with no valid base URL resolvable anywhere, throws instead of emailing a broken link', async () => {
    process.env.NODE_ENV = 'production';
    await expect(resolveAppBaseUrl(makeConfig(['*']))).rejects.toThrow(/No valid application base URL/);
  });

  it('in production, a real APP_BASE_URL still resolves normally (does not throw)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_BASE_URL = 'https://app.example.com';
    const url = await resolveAppBaseUrl(makeConfig(['*']));
    expect(url).toBe('https://app.example.com');
  });

  it('an invalid (non-URL) APP_BASE_URL is skipped, not used', async () => {
    process.env.APP_BASE_URL = 'not-a-valid-url';
    const url = await resolveAppBaseUrl(makeConfig(['https://dashboard.example.com']));
    expect(url).toBe('https://dashboard.example.com');
  });

  it('a non-http(s) platform_domains.app_base_url (e.g. malformed) is skipped, not used', async () => {
    platformDomainRow = { app_base_url: 'not a url at all' };
    process.env.APP_BASE_URL = 'https://env-fallback.example.com';
    const url = await resolveAppBaseUrl(makeConfig(['*']));
    expect(url).toBe('https://env-fallback.example.com');
  });
});
