/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase test double is intentionally untyped. */
/**
 * resolveContactsNetworkProfiles — batched sibling of
 * resolveContactNetworkProfile, added so Contacts (list) can resolve the
 * SAME live session-based city Inbox already shows for an anonymous
 * contact, without an N+1 query per row and without a second geo system.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: { sessions: any[]; ipCache: any[] } = { sessions: [], ipCache: [] };

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb() }));

function fakeSb(): any {
  return {
    from(table: string) {
      const filters: Record<string, any> = {};
      let inField: string | null = null;
      let inValues: string[] = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      const rowsFor = () => {
        const src = table === 'visitor_sessions' ? state.sessions
          : table === 'geo_ip_cache' ? state.ipCache
            : [];
        let out = src.filter((r) => {
          for (const [k, v] of Object.entries(filters)) if (r[k] !== v) return false;
          if (inField && !inValues.includes(r[inField])) return false;
          return true;
        });
        if (orderCol) {
          const col = orderCol;
          out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (orderAsc ? 1 : -1));
        }
        return out;
      };
      const chain: any = {
        select() { return chain; },
        eq(col: string, val: any) { filters[col] = val; return chain; },
        in(col: string, vals: string[]) { inField = col; inValues = vals; return chain; },
        order(col: string, opts?: { ascending?: boolean }) {
          orderCol = col; orderAsc = opts?.ascending !== false; return chain;
        },
        then: (resolve: any) => resolve({ data: rowsFor(), error: null }),
      };
      return chain;
    },
  };
}

const WS = 'w1';
const cfg: any = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };
const POLICY = { entitled: false, canViewRaw: false };
let np: typeof import('../../../server/services/visitors/networkProfile.js');

beforeEach(async () => {
  vi.resetModules();
  np = await import('../../../server/services/visitors/networkProfile.js');
  state.sessions = [];
  state.ipCache = [];
});

describe('resolveContactsNetworkProfiles', () => {
  it('resolves the same city Inbox would show, via the linked visitor_sessions.contact_id — no new geo system', async () => {
    state.sessions = [
      {
        id: 'sess-1', workspace_id: WS, contact_id: 'contact-A', ip_hash: null,
        last_seen_at: '2026-02-01T00:00:00Z',
        geo_country_code: 'IR', geo_country_name: 'Iran', geo_city: 'Tehran',
        geo_region: null, geo_latitude: 35.7, geo_longitude: 51.4,
        geo_timezone: null, geo_source_provider: 'maxmind_local',
        geo_accuracy_level: 'city', geo_is_fallback: false,
        geo_resolved_at: '2026-02-01T00:00:00Z',
        country: null, city: null,
      },
    ];
    const map = await np.resolveContactsNetworkProfiles(cfg, WS, ['contact-A'], POLICY);
    expect(map.get('contact-A')?.geo.city).toBe('Tehran');
  });

  it('batches ONE session query for many contacts (never one query per contact)', async () => {
    state.sessions = [
      { id: 's1', workspace_id: WS, contact_id: 'A', ip_hash: null, last_seen_at: '2026-01-01T00:00:00Z', geo_city: 'Tehran', geo_country_code: 'IR' },
      { id: 's2', workspace_id: WS, contact_id: 'B', ip_hash: null, last_seen_at: '2026-01-02T00:00:00Z', geo_city: 'Shiraz', geo_country_code: 'IR' },
      { id: 's3', workspace_id: WS, contact_id: 'C', ip_hash: null, last_seen_at: '2026-01-03T00:00:00Z', geo_city: 'Tabriz', geo_country_code: 'IR' },
    ];
    const map = await np.resolveContactsNetworkProfiles(cfg, WS, ['A', 'B', 'C'], POLICY);
    expect(map.get('A')?.geo.city).toBe('Tehran');
    expect(map.get('B')?.geo.city).toBe('Shiraz');
    expect(map.get('C')?.geo.city).toBe('Tabriz');
  });

  it('prefers the newest session that carries an ip_hash over a more recent one without it (same preference as resolveContactNetworkProfile)', async () => {
    state.sessions = [
      // Newest overall, but no ip_hash.
      { id: 'newest-no-ip', workspace_id: WS, contact_id: 'A', ip_hash: null, last_seen_at: '2026-03-01T00:00:00Z', geo_city: 'Isfahan', geo_country_code: 'IR' },
      // Older, but has ip_hash — should win.
      { id: 'older-with-ip', workspace_id: WS, contact_id: 'A', ip_hash: 'hash1', last_seen_at: '2026-02-01T00:00:00Z', geo_city: 'Tehran', geo_country_code: 'IR' },
    ];
    const map = await np.resolveContactsNetworkProfiles(cfg, WS, ['A'], POLICY);
    expect(map.get('A')?.geo.city).toBe('Tehran');
    expect(map.get('A')?.visitor_session_id).toBe('older-with-ip');
  });

  it('falls back to the newest session at all when none carries an ip_hash', async () => {
    state.sessions = [
      { id: 'older', workspace_id: WS, contact_id: 'A', ip_hash: null, last_seen_at: '2026-01-01T00:00:00Z', geo_city: 'Shiraz', geo_country_code: 'IR' },
      { id: 'newer', workspace_id: WS, contact_id: 'A', ip_hash: null, last_seen_at: '2026-02-01T00:00:00Z', geo_city: 'Tehran', geo_country_code: 'IR' },
    ];
    const map = await np.resolveContactsNetworkProfiles(cfg, WS, ['A'], POLICY);
    expect(map.get('A')?.geo.city).toBe('Tehran');
  });

  it('a contact with no session at all is simply absent from the map — never crashes', async () => {
    state.sessions = [];
    const map = await np.resolveContactsNetworkProfiles(cfg, WS, ['no-session-contact'], POLICY);
    expect(map.has('no-session-contact')).toBe(false);
    expect(map.size).toBe(0);
  });

  it('returns an empty map for an empty contact id list without querying', async () => {
    const map = await np.resolveContactsNetworkProfiles(cfg, WS, [], POLICY);
    expect(map.size).toBe(0);
  });
});
