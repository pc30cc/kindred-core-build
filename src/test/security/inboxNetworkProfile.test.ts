/**
 * Phase 2 guards — Inbox and Contacts read through the ONE canonical resolver.
 *
 * Test A: a conversation resolves its OWN visitor_session, never the
 *         contact's newest one.
 * Test C: two sessions of the same contact with different IPs stay separate.
 * Contacts: the /contacts/:id/ip policy has exactly three states and is the
 *         shared one from networkProfile.ts (no local rule).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const state: { sessions: any[]; conversations: any[]; entitled: boolean } = {
  sessions: [],
  conversations: [],
  entitled: true,
};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => fakeSb(),
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkEntitlementFromDB: async () => ({ allowed: state.entitled }),
}));

function fakeSb(): any {
  return {
    from(table: string) {
      const filters: Record<string, any> = {};
      let inField: string | null = null;
      let inValues: string[] = [];
      let notNullField: string | null = null;
      const rowsFor = () => {
        const src =
          table === 'conversations' ? state.conversations
            : table === 'visitor_sessions' ? state.sessions
              : [];
        return src.filter((r) => {
          for (const [k, v] of Object.entries(filters)) if (r[k] !== v) return false;
          if (inField && !inValues.includes(r[inField])) return false;
          if (notNullField && (r[notNullField] === null || r[notNullField] === undefined)) return false;
          return true;
        });
      };
      const chain: any = {
        select() { return chain; },
        eq(col: string, val: any) { filters[col] = val; return chain; },
        in(col: string, vals: string[]) { inField = col; inValues = vals; return chain; },
        not(col: string) { notNullField = col; return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle: async () => ({ data: rowsFor()[0] ?? null }),
        then: (resolve: any) => resolve({ data: rowsFor(), error: null }),
      };
      return chain;
    },
  };
}

const WS = 'w1';
const cfg: any = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };

let np: typeof import('../../../server/services/visitors/networkProfile.js');
beforeEach(async () => {
  np = await import('../../../server/services/visitors/networkProfile.js');
  state.entitled = true;
  state.sessions = [
    {
      id: 'sess-tr', workspace_id: WS, visitor_id: 'v1', contact_id: 'c1',
      last_seen_at: '2026-01-01T00:00:00Z',
      ip_hash: 'aaaabbbbccccdddd', ip_raw: '185.23.44.55',
      geo_country_code: 'TR', geo_country_name: 'Turkey', geo_city: 'Istanbul',
      geo_region: null, geo_latitude: null, geo_longitude: null, geo_timezone: 'Europe/Istanbul',
      geo_source_provider: 'maxmind_local', geo_accuracy_level: 'city',
      geo_is_fallback: false, geo_resolved_at: '2026-01-01T00:00:00Z',
      country: 'Germany', city: 'Berlin', browser: 'Chrome', os: 'macOS', device: 'desktop',
    },
    {
      id: 'sess-de', workspace_id: WS, visitor_id: 'v1', contact_id: 'c1',
      last_seen_at: '2026-02-01T00:00:00Z',
      ip_hash: '1111222233334444', ip_raw: '91.10.20.30',
      geo_country_code: 'DE', geo_country_name: 'Germany', geo_city: 'Berlin',
      geo_region: null, geo_latitude: null, geo_longitude: null, geo_timezone: 'Europe/Berlin',
      geo_source_provider: 'maxmind_local', geo_accuracy_level: 'city',
      geo_is_fallback: false, geo_resolved_at: '2026-02-01T00:00:00Z',
      country: null, city: null, browser: 'Chrome', os: 'Windows', device: 'desktop',
    },
  ];
  state.conversations = [
    { id: 'conv-a', workspace_id: WS, visitor_session_id: 'sess-tr', contact_id: 'c1' },
    { id: 'conv-b', workspace_id: WS, visitor_session_id: 'sess-de', contact_id: 'c1' },
  ];
});

const adminPolicy = { entitled: true, canViewRaw: true };

describe('Test A — conversation resolves its exact session', () => {
  it('does not let the contact newest session leak into the older thread', async () => {
    const map = await np.resolveConversationNetworkProfiles(cfg, WS, ['conv-a', 'conv-b'], adminPolicy);
    expect(map.get('conv-a')!.geo.country_code).toBe('TR');
    expect(map.get('conv-a')!.geo.city).toBe('Istanbul');
    expect(map.get('conv-b')!.geo.country_code).toBe('DE');
  });

  it('persisted geo wins over the legacy country column of the same row', async () => {
    const map = await np.resolveConversationNetworkProfiles(cfg, WS, ['conv-a'], adminPolicy);
    expect(map.get('conv-a')!.geo.country).toBe('Turkey');
  });

  it('falls back to the contact newest session ONLY for legacy rows with no link', async () => {
    state.conversations = [
      { id: 'conv-legacy', workspace_id: WS, visitor_session_id: null, contact_id: 'c1' },
    ];
    const map = await np.resolveConversationNetworkProfiles(cfg, WS, ['conv-legacy'], adminPolicy);
    expect(map.get('conv-legacy')!.geo.country_code).toBe('DE');
  });
});

describe('Test C — different IP, same contact', () => {
  it('returns each conversation own IP', async () => {
    const map = await np.resolveConversationNetworkProfiles(cfg, WS, ['conv-a', 'conv-b'], adminPolicy);
    expect(map.get('conv-a')!.ip.raw).toBe('185.23.44.55');
    expect(map.get('conv-b')!.ip.raw).toBe('91.10.20.30');
  });

  it('never returns a raw IP to a non-admin member', async () => {
    const memberPolicy = { entitled: true, canViewRaw: false };
    const map = await np.resolveConversationNetworkProfiles(cfg, WS, ['conv-a'], memberPolicy);
    const ip = map.get('conv-a')!.ip;
    expect(ip.raw).toBeNull();
    expect(ip.display).not.toContain('44.55');
  });
});

describe('contacts /:id/ip — shared three-state policy', () => {
  it('no entitlement → policy blocks everything (fail closed)', async () => {
    state.entitled = false;
    const policy = await np.resolveIpVisibilityPolicy(cfg, WS, 'owner');
    expect(policy.entitled).toBe(false);
    expect(policy.canViewRaw).toBe(false);
    const profile = await np.resolveContactNetworkProfile(cfg, WS, 'c1', policy);
    expect(profile!.ip.raw).toBeNull();
    expect(profile!.ip.locked).toBe(true);
    expect(profile!.ip.display).toBe('');
  });

  it('entitled ordinary member → masked only', async () => {
    const policy = await np.resolveIpVisibilityPolicy(cfg, WS, 'agent');
    expect(policy.entitled).toBe(true);
    expect(policy.canViewRaw).toBe(false);
    const profile = await np.resolveContactNetworkProfile(cfg, WS, 'c1', policy);
    expect(profile!.ip.raw).toBeNull();
    expect(profile!.ip.display).toMatch(/xxx/);
  });

  it('entitled owner/admin → raw', async () => {
    for (const role of ['owner', 'admin']) {
      const policy = await np.resolveIpVisibilityPolicy(cfg, WS, role);
      expect(policy.canViewRaw).toBe(true);
      const profile = await np.resolveContactNetworkProfile(cfg, WS, 'c1', policy);
      expect(profile!.ip.raw).toBe('185.23.44.55');
    }
  });

  it('the route delegates — no local IP rule left in contacts.ts', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'server/routes/contacts.ts'), 'utf8');
    expect(src).toContain('resolveIpVisibilityPolicy');
    expect(src).toContain('resolveContactNetworkProfile');
    expect(src).not.toContain(".select('ip_raw')");
  });
});

describe('Inbox no longer reads visitor_sessions in the browser', () => {
  it('useConversations goes through the batched server endpoint', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'src/hooks/useConversations.ts'), 'utf8');
    expect(src).toContain('fetchVisitorNetworkForConversations');
    expect(src).not.toContain("from('visitor_sessions')");
  });
});
