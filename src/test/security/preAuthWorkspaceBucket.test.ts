/* eslint-disable @typescript-eslint/no-explicit-any -- Express/Supabase test doubles are intentionally untyped. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Data fixtures ───
const REAL = '11111111-1111-4111-8111-111111111111';
const VICTIM = '22222222-2222-4222-8222-222222222222';
const GHOST = '33333333-3333-4333-8333-333333333333';
const SESSION_A = '44444444-4444-4444-8444-444444444444';
const WS_A = '55555555-5555-4555-8555-555555555555';
const DB_ERROR_WS = '66666666-6666-4666-8666-666666666666';

const workspaces = new Set([REAL, VICTIM, WS_A]);
const trackingEnabled = new Set([REAL, VICTIM]);
// Only REAL publishes an allow-list. VICTIM has one too (so the attack is not
// "blocked by accident" — the attacker simply isn't on it).
const originRules: Record<string, { domains: string[]; allowSubdomains: boolean }> = {
  [REAL]: { domains: ['shop.example'], allowSubdomains: false },
  [VICTIM]: { domains: ['victim.example'], allowSubdomains: false },
};
const visitorSessions: Record<string, { workspace_id: string }> = { [SESSION_A]: { workspace_id: WS_A } };

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async () => ({ data: false, error: null }),
    from: (table: string) => ({
      select: () => ({
        eq: (_c: string, v: string) => ({
          maybeSingle: async () => {
            if (v === DB_ERROR_WS) return { data: null, error: { message: 'db down' } };
            if (table === 'workspaces') return { data: workspaces.has(v) ? { id: v } : null, error: null };
            if (table === 'widget_settings') {
              return { data: workspaces.has(v) ? { visitor_tracking_enabled: trackingEnabled.has(v) } : null, error: null };
            }
            if (table === 'visitor_sessions') return { data: visitorSessions[v] ?? null, error: null };
            return { data: null, error: null };
          },
        }),
      }),
      insert: async () => ({}),
    }),
  }),
}));

vi.mock('../../../server/services/widget/public.js', () => ({
  getWorkspaceOriginRules: async (_c: any, ws: string) => originRules[ws] ?? { domains: [], allowSubdomains: false },
  isWorkspaceOriginAllowed: async (_c: any, ws: string, origin: string | null) => {
    const rules = originRules[ws];
    if (!rules || !rules.domains.length) return true; // legacy semantics
    if (!origin) return true;
    try { return rules.domains.includes(new URL(origin).host.toLowerCase()); } catch { return false; }
  },
  resolveWorkspaceIdFromOrigin: async (_c: any, origin: string | null) => {
    if (!origin) return null;
    try {
      const host = new URL(origin).host.toLowerCase();
      if (host === 'shop.example') return REAL;
      if (host === 'kb.example') return REAL;
      return null;
    } catch { return null; }
  },
}));

vi.mock('../../../server/services/callCenter/settings.js', () => ({
  findWorkspaceByPublicKey: async (_c: any, key: string) =>
    key === 'pk_real' ? { workspace_id: REAL, allowed_domains: ['shop.example'] } : null,
  originAllowed: (ws: any, origin: string | null) => {
    if (!origin) return false;
    try { return (ws.allowed_domains || []).includes(new URL(origin).host.toLowerCase()); } catch { return false; }
  },
}));

const { preAuthWorkspaceContext } = await import('../../../server/middleware/preAuthWorkspaceContext.js');
const { resolveRateLimitWorkspaceKey } = await import('../../../server/middleware/security.js');
const { createSessionToken } = await import('../../../server/services/widget/security.js');
const { signWidgetSession } = await import('../../../server/services/callCenter/widgetSession.js');

const middleware = preAuthWorkspaceContext();

function makeReq(o: any = {}) {
  return {
    ip: '1.1.1.1',
    method: 'POST',
    query: {},
    body: {},
    headers: {},
    originalUrl: '/api/widget/bootstrap',
    serverConfig: { widgetTokenSecret: 'cc-secret' },
    ...o,
  } as any;
}

/** Runs the real middleware chain (validation → key resolution). */
async function bucketFor(o: any) {
  const req = makeReq(o);
  const next = vi.fn();
  await middleware(req, {} as any, next);
  expect(next).toHaveBeenCalledTimes(1);
  return resolveRateLimitWorkspaceKey(req);
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('P1–P5 — widget bootstrap pre-auth targeting', () => {
  it('P1 — evil origin + victim workspace_id does NOT select the victim bucket', async () => {
    const key = await bucketFor({
      ip: '8.8.8.8',
      body: { workspace_id: VICTIM },
      headers: { origin: 'https://evil.example' },
    });
    expect(key).not.toBe(`ws:${VICTIM}`);
    expect(key).toBe('ip:8.8.8.8');
  });

  it('P2 — IP rotation cannot increment the victim workspace bucket', async () => {
    const ips = Array.from({ length: 10 }, (_, i) => `10.0.0.${i + 1}`);
    const keys = await Promise.all(ips.map((ip) => bucketFor({
      ip, body: { workspace_id: VICTIM }, headers: { origin: 'https://evil.example' },
    })));
    expect(keys.every((k) => k.startsWith('ip:'))).toBe(true);
    expect(keys).not.toContain(`ws:${VICTIM}`);
    expect(new Set(keys).size).toBe(10); // one bucket per attacker IP
  });

  it('P3 — legitimate bootstrap from a configured origin gets the workspace bucket', async () => {
    expect(await bucketFor({ body: { workspace_id: REAL }, headers: { origin: 'https://shop.example' } }))
      .toBe(`ws:${REAL}`);
  });

  it('P3b — origin-only bootstrap (no workspace_id) resolves via verified domain mapping', async () => {
    expect(await bucketFor({ headers: { origin: 'https://shop.example' } })).toBe(`ws:${REAL}`);
  });

  it('P4 — nonexistent workspace id never creates a workspace bucket', async () => {
    expect(await bucketFor({ ip: '9.9.9.9', body: { workspace_id: GHOST }, headers: { origin: 'https://shop.example' } }))
      .toBe('ip:9.9.9.9');
  });

  it('P4b — cross-claim: valid origin of REAL but claiming VICTIM is rejected', async () => {
    expect(await bucketFor({ ip: '9.9.9.8', body: { workspace_id: VICTIM }, headers: { origin: 'https://shop.example' } }))
      .toBe('ip:9.9.9.8');
  });

  it('P5 — wrong HTTP method gets no pre-auth workspace classification', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const key = await bucketFor({
        ip: '7.7.7.7', method, body: { workspace_id: REAL }, headers: { origin: 'https://shop.example' },
      });
      expect(key).toBe('ip:7.7.7.7');
    }
  });
});

describe('P6–P10 — visitors endpoints', () => {
  it('P6 — track with an unauthorized origin does not select the victim bucket', async () => {
    expect(await bucketFor({
      ip: '6.6.6.6', originalUrl: '/api/visitors/track',
      body: { workspace_id: VICTIM }, headers: { origin: 'https://evil.example' },
    })).toBe('ip:6.6.6.6');
  });

  it('P7 — track with a valid origin uses the real workspace bucket', async () => {
    expect(await bucketFor({
      originalUrl: '/api/visitors/track',
      body: { workspace_id: REAL }, headers: { origin: 'https://shop.example' },
    })).toBe(`ws:${REAL}`);
  });

  it('P7b — track for a workspace with tracking disabled gets no workspace bucket', async () => {
    expect(await bucketFor({
      ip: '6.6.6.5', originalUrl: '/api/visitors/track',
      body: { workspace_id: WS_A }, headers: { origin: 'https://shop.example' },
    })).toBe('ip:6.6.6.5');
  });

  it('P8 — heartbeat: the session row is the authority, mismatching hint is ignored', async () => {
    expect(await bucketFor({
      ip: '5.5.5.5', originalUrl: '/api/visitors/heartbeat',
      body: { session_id: SESSION_A, workspace_id: VICTIM },
    })).not.toBe(`ws:${VICTIM}`);

    expect(await bucketFor({
      originalUrl: '/api/visitors/heartbeat', body: { session_id: SESSION_A },
    })).toBe(`ws:${WS_A}`);
  });

  it('P9 — disconnect: same session authority', async () => {
    expect(await bucketFor({ originalUrl: '/api/visitors/disconnect', body: { session_id: SESSION_A } }))
      .toBe(`ws:${WS_A}`);
    expect(await bucketFor({
      ip: '5.5.5.4', originalUrl: '/api/visitors/disconnect',
      body: { session_id: SESSION_A, workspace_id: VICTIM },
    })).toBe('ip:5.5.5.4');
  });

  it('P10 — forged / unknown session id cannot select any workspace bucket', async () => {
    expect(await bucketFor({
      ip: '4.4.4.4', originalUrl: '/api/visitors/heartbeat',
      body: { session_id: '99999999-9999-4999-8999-999999999999', workspace_id: VICTIM },
    })).toBe('ip:4.4.4.4');
  });
});

describe('P11–P13 — call widget and KB', () => {
  it('P11 — call-widget bootstrap with a bare workspaceId / evil origin gets no workspace bucket', async () => {
    expect(await bucketFor({
      ip: '3.3.3.3', method: 'GET', originalUrl: '/api/call-widget/bootstrap',
      query: { workspaceId: VICTIM },
    })).toBe('ip:3.3.3.3');

    expect(await bucketFor({
      ip: '3.3.3.2', method: 'GET', originalUrl: '/api/call-widget/bootstrap',
      query: { publicKey: 'pk_real' }, headers: { origin: 'https://evil.example' },
    })).toBe('ip:3.3.3.2');
  });

  it('P12 — legitimate call-widget bootstrap (valid public key + allowed origin)', async () => {
    expect(await bucketFor({
      method: 'GET', originalUrl: '/api/call-widget/bootstrap',
      query: { publicKey: 'pk_real' }, headers: { origin: 'https://shop.example' },
    })).toBe(`ws:${REAL}`);
  });

  it('P13 — KB reads are host-scoped; a workspace_id query alone proves nothing', async () => {
    expect(await bucketFor({
      ip: '2.2.2.2', method: 'GET', originalUrl: '/api/widget/kb/categories',
      query: { workspace_id: VICTIM }, headers: { host: 'evil.example' },
    })).toBe('ip:2.2.2.2');

    expect(await bucketFor({
      method: 'GET', originalUrl: '/api/widget/kb/categories',
      query: { workspace_id: REAL }, headers: { host: 'kb.example', 'x-forwarded-proto': 'https' },
    })).toBe(`ws:${REAL}`);

    // Host resolves REAL but the query claims VICTIM → no trust.
    expect(await bucketFor({
      ip: '2.2.2.3', method: 'GET', originalUrl: '/api/widget/kb/categories',
      query: { workspace_id: VICTIM }, headers: { host: 'kb.example' },
    })).toBe('ip:2.2.2.3');
  });
});

describe('P14 — token-secured behavior is unchanged', () => {
  it('valid widget token wins over an attacker-supplied workspace_id', async () => {
    const token = createSessionToken(REAL, 'https://shop.example');
    expect(await bucketFor({ headers: { 'x-widget-token': token }, body: { workspace_id: VICTIM } }))
      .toBe(`ws:${REAL}`);
  });

  it('forged token + victim workspace_id on a pre-auth route → attacker IP bucket', async () => {
    const forged = 'wss_' + Buffer.from(JSON.stringify({ w: VICTIM, o: '', n: 'x', iat: 1, exp: 9e9 })).toString('base64url') + '.deadbeef';
    expect(await bucketFor({
      ip: '1.2.3.4', headers: { 'x-widget-token': forged, origin: 'https://shop.example' },
      body: { workspace_id: REAL },
    })).toBe('ip:1.2.3.4');
  });

  it('valid call-widget session still resolves its workspace', async () => {
    const config: any = { widgetTokenSecret: 'cc-secret' };
    const token = signWidgetSession(config, { workspace_id: WS_A, public_key: null });
    expect(await bucketFor({
      method: 'GET', originalUrl: '/api/call-widget/bootstrap',
      serverConfig: config, headers: { 'x-cc-session': token }, query: { workspaceId: VICTIM },
    })).toBe(`ws:${WS_A}`);
  });

  it('invalid call-widget session cannot fall back to a raw workspaceId', async () => {
    expect(await bucketFor({
      ip: '1.2.3.5', method: 'GET', originalUrl: '/api/call-widget/bootstrap',
      headers: { 'x-cc-session': 'garbage' }, query: { workspaceId: VICTIM, publicKey: 'pk_real' },
    })).toBe('ip:1.2.3.5');
  });
});

describe('fail-safe behavior', () => {
  it('a DB failure during validation resolves to the IP bucket, never the raw hint', async () => {
    expect(await bucketFor({
      ip: '1.9.9.9', body: { workspace_id: DB_ERROR_WS }, headers: { origin: 'https://shop.example' },
    })).toBe('ip:1.9.9.9');
  });

  it('a request with no server config is not trusted', async () => {
    expect(await bucketFor({ ip: '1.9.9.8', serverConfig: undefined, body: { workspace_id: REAL } }))
      .toBe('ip:1.9.9.8');
  });
});
