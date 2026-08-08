/**
 * Geo resolution precedence + canonical country contract.
 *
 * Order under test (server/services/geo/index.ts):
 *   cache → MaxMind Local → external provider → CF-IPCountry → centroid → none
 *
 * Cloudflare must be strictly optional: with MaxMind Local and a real IP the
 * city must resolve with no CF header at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = {
  geo: { enabled: true, default_provider: 'maxmind_local', allow_centroid_fallback: true, cache_ttl_seconds: 600 },
  maxmind_local: { enabled: true, db_path: '/app/data/GeoLite2-City.mmdb', auto_reload: true },
};

const state = {
  settings: JSON.parse(JSON.stringify(settings)) as any,
  local: null as any,
  providerRow: null as any,
  cacheRow: null as any,
};

vi.mock('../../../server/services/geo/settings', () => ({
  getMapGeoSettings: async () => state.settings,
  patchMapGeoSettings: async () => state.settings,
}));

vi.mock('../../../server/services/geo/maxmindLocal', () => ({
  lookupMaxmindLocal: async () => state.local,
  checkMaxmindLocalHealth: async () => ({ ok: false }),
  validateMmdbCandidate: async () => null,
  invalidateMaxmindReader: () => {},
}));

vi.mock('../../../server/services/geo/ipCache', () => ({
  readIpCache: async () => state.cacheRow,
  writeIpCache: async () => {},
  purgeExpiredIpCache: async () => 0,
}));

vi.mock('../../../server/supabase', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        gt: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: table === 'provider_configs' ? state.providerRow : null }),
        single: async () => ({ data: table === 'provider_configs' ? state.providerRow : null }),
        insert: async () => ({ data: null }),
        upsert: async () => ({ data: null }),
        update: () => chain,
        delete: () => chain,
      };
      return chain;
    },
  }),
}));

const { resolveVisitorGeo, normalizeGeoPayload } = await import('../../../server/services/geo/index');

const cfg = {} as any;

beforeEach(() => {
  state.settings = JSON.parse(JSON.stringify(settings));
  state.local = null;
  state.providerRow = null;
  state.cacheRow = null;
});

describe('canonical country contract', () => {
  it('turns a bare code into code + full name', () => {
    const n = normalizeGeoPayload({ country_code: 'tr' });
    expect(n.country_code).toBe('TR');
    expect(n.country).toMatch(/T(ü|u)rk/i);
  });

  it('keeps a full name and derives the code when only a name-ish value exists', () => {
    expect(normalizeGeoPayload({ country: 'Turkey' }).country).toBe('Turkey');
    expect(normalizeGeoPayload({ country: 'TR' }).country_code).toBe('TR');
  });
});

describe('resolution precedence', () => {
  it('MaxMind enabled + DB present resolves city WITHOUT Cloudflare', async () => {
    state.local = {
      country: 'Turkey', country_code: 'TR', region: 'Istanbul', city: 'Istanbul',
      latitude: 41, longitude: 29, timezone: 'Europe/Istanbul',
    };
    const r = await resolveVisitorGeo(cfg, null, { raw_ip: '185.23.45.67', ip_hash: 'h1', country: null });
    expect(r.source).toBe('provider');
    expect(r.city).toBe('Istanbul');
    expect(r.country_code).toBe('TR');
    expect(r.timezone).toBe('Europe/Istanbul');
  });

  it('preserves the MMDB timezone end-to-end', async () => {
    state.local = { country_code: 'DE', city: 'Berlin', region: null, country: 'Germany', latitude: 52, longitude: 13, timezone: 'Europe/Berlin' };
    const r = await resolveVisitorGeo(cfg, null, { raw_ip: '5.5.5.5', ip_hash: 'h2' });
    expect(r.timezone).toBe('Europe/Berlin');
  });

  it('cache wins over every live source', async () => {
    state.cacheRow = {
      source: 'maxmind_local', country_code: 'DE', country_name: 'Germany', region: null,
      city: 'Berlin', latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin',
      accuracy_level: 'city', is_fallback: false,
    };
    state.local = { country_code: 'TR', city: 'Istanbul', region: null, country: 'Turkey', latitude: 41, longitude: 29, timezone: null };
    const r = await resolveVisitorGeo(cfg, null, { raw_ip: '1.1.1.1', ip_hash: 'h3' });
    expect(r.source).toBe('cache');
    expect(r.city).toBe('Berlin');
  });

  it('MaxMind enabled but file missing (lookup returns null) falls through, never throws', async () => {
    state.local = null;
    const r = await resolveVisitorGeo(cfg, null, { raw_ip: '185.23.45.67', ip_hash: 'h4', country: 'TR' });
    expect(['centroid', 'session']).toContain(r.source);
    expect(r.country_code).toBe('TR');
    expect(r.country).toMatch(/T(ü|u)rk/i);
  });

  it('MaxMind disabled → CF country still yields a country-level result', async () => {
    state.settings.maxmind_local.enabled = false;
    const r = await resolveVisitorGeo(cfg, null, { raw_ip: '185.23.45.67', ip_hash: 'h5', country: 'TR' });
    expect(r.country_code).toBe('TR');
    expect(r.country).not.toBe('TR');
  });

  it('no MaxMind, no provider, no CF country → nothing, and no crash', async () => {
    state.settings.maxmind_local.enabled = false;
    const r = await resolveVisitorGeo(cfg, null, { raw_ip: '185.23.45.67', ip_hash: 'h6', country: null });
    expect(r.source).toBe('none');
    expect(r.latitude).toBeNull();
  });

  it('a legacy provider_configs row selecting maxmind_local is IGNORED (single source of truth)', async () => {
    state.providerRow = { provider_name: 'maxmind_local', config: { db_path: '/somewhere/else.mmdb' }, is_active: true };
    state.settings.maxmind_local.enabled = false;
    const r = await resolveVisitorGeo(cfg, null, { raw_ip: '185.23.45.67', ip_hash: 'h7', country: 'DE' });
    // Falls to CF/centroid — it must NOT have used the provider row's db_path.
    expect(r.source).not.toBe('provider');
    expect(r.country_code).toBe('DE');
  });

  it('MaxMind miss → configured external provider is consulted next', async () => {
    state.local = null;
    state.providerRow = { provider_name: 'ipinfo', config: { api_token: 't' }, is_active: true };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ country: 'NL', city: 'Amsterdam', region: 'NH', loc: '52.37,4.89', timezone: 'Europe/Amsterdam' }),
    }));
    vi.stubGlobal('fetch', fetchMock as any);
    const r = await resolveVisitorGeo(cfg, null, { raw_ip: '185.23.45.67', ip_hash: 'h8' });
    expect(r.source).toBe('provider');
    expect(r.city).toBe('Amsterdam');
    expect(r.country_code).toBe('NL');
    expect(r.country).toBe('Netherlands');
    vi.unstubAllGlobals();
  });

  it('external provider failure degrades to the CF country fallback', async () => {
    state.local = null;
    state.providerRow = { provider_name: 'ipinfo', config: { api_token: 't' }, is_active: true };
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }) as any);
    const r = await resolveVisitorGeo(cfg, null, { raw_ip: '185.23.45.67', ip_hash: 'h9', country: 'TR' });
    expect(r.country_code).toBe('TR');
    expect(r.source).not.toBe('provider');
    vi.unstubAllGlobals();
  });
});
