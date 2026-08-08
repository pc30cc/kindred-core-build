/**
 * Test I — an IP change mid-session must move the WHOLE network identity.
 *
 * A visitor starts on IP A (Turkey) and continues on IP B (Germany) — VPN,
 * mobile handover, corporate proxy. The session must end up with ip_hash B and
 * Germany geo: never "new IP + old country", and never a blend of the two.
 * When the new IP cannot be resolved at all, the stale Turkish geo must be
 * CLEARED rather than left behind.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HASH_A = 'aaaa1111aaaa1111';
const HASH_B = 'bbbb2222bbbb2222';

const cache: Record<string, any> = {};
const updates: Array<{ table: string; patch: any; filters: Record<string, any> }> = [];

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const filters: Record<string, any> = {};
      const chain: any = {
        select() { return chain; },
        eq(col: string, val: any) { filters[col] = val; return chain; },
        update(patch: any) { updates.push({ table, patch, filters }); return chain; },
        upsert() { return chain; },
        insert() { return chain; },
        maybeSingle: async () => ({ data: null }),
        then: (resolve: any) => resolve({ data: null, error: null }),
      };
      return chain;
    },
  }),
}));
vi.mock('../../../server/services/geo/ipCache.js', () => ({
  readIpCache: async (_cfg: any, hash: string) => cache[hash] ?? null,
  writeIpCache: async () => {},
}));
vi.mock('../../../server/services/geo/settings.js', () => ({
  getMapGeoSettings: async () => ({
    geo: { default_provider: 'maxmind_local', allow_centroid_fallback: false, cache_ttl_seconds: 3600 },
    maxmind_local: { enabled: false, db_path: null, auto_reload: false },
  }),
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishVisitorEvent: async () => {},
}));

const cfg: any = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };
const sessionUpdates = () => updates.filter((u) => u.table === 'visitor_sessions');

beforeEach(() => {
  updates.length = 0;
  for (const k of Object.keys(cache)) delete cache[k];
  cache[HASH_A] = {
    ip_hash: HASH_A, source: 'maxmind_local', country_code: 'TR', country_name: 'Turkey',
    region: 'Istanbul', city: 'Istanbul', latitude: 41, longitude: 29, timezone: 'Europe/Istanbul',
  };
  cache[HASH_B] = {
    ip_hash: HASH_B, source: 'maxmind_local', country_code: 'DE', country_name: 'Germany',
    region: 'Berlin', city: 'Berlin', latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin',
  };
});

describe('Test I — IP change mid-session re-resolves geo', () => {
  it('replaces Turkey with Germany when the visitor moves from IP A to IP B', async () => {
    const { enrichVisitorSessionGeo } = await import('../../../server/services/geo/index.js');
    await enrichVisitorSessionGeo(cfg, {
      sessionId: 's1', workspaceId: 'w1', ipHash: HASH_B, rawIp: '5.5.5.5',
      previousIpHash: HASH_A,
    });
    const patch = sessionUpdates().at(-1)!.patch;
    expect(patch.geo_country_code).toBe('DE');
    expect(patch.geo_city).toBe('Berlin');
    expect(patch.geo_timezone).toBe('Europe/Berlin');
    // No residue of the previous network identity.
    expect(JSON.stringify(patch)).not.toContain('Istanbul');
    expect(patch.country).toBe('DE');
  });

  it('clears the stale geo when the NEW ip cannot be resolved', async () => {
    delete cache[HASH_B];
    const { enrichVisitorSessionGeo } = await import('../../../server/services/geo/index.js');
    await enrichVisitorSessionGeo(cfg, {
      sessionId: 's1', workspaceId: 'w1', ipHash: HASH_B, rawIp: '5.5.5.5',
      previousIpHash: HASH_A,
    });
    const patch = sessionUpdates().at(-1)!.patch;
    expect(patch.geo_country_code).toBeNull();
    expect(patch.geo_city).toBeNull();
    expect(patch.geo_resolved_at).toBeNull();
  });

  it('keeps existing geo when the ip did NOT change and nothing resolves', async () => {
    delete cache[HASH_A];
    const { enrichVisitorSessionGeo } = await import('../../../server/services/geo/index.js');
    await enrichVisitorSessionGeo(cfg, {
      sessionId: 's1', workspaceId: 'w1', ipHash: HASH_A, rawIp: '1.1.1.1',
      previousIpHash: HASH_A,
    });
    expect(sessionUpdates().length).toBe(0);
  });

  it('the shared session writer forwards the previous ip_hash and rewrites ip_hash', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('server/services/widget/crossWidgetIdentity.ts', 'utf8'));
    expect(src).toContain('previousIpHash');
    expect(src).toContain('ip_hash: net.ipHash');
  });
});
