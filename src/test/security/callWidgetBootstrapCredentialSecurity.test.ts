/**
 * Route-level attack tests for the call-widget credential-issuance trust
 * boundary — mirrors widgetBootstrapCredentialSecurity.test.ts for
 * server/routes/callWidget.ts. Mounts the REAL callWidgetRouter with a
 * mocked Supabase client so these exercise the actual bootstrap ->
 * x-cc-session -> protected-route pipeline, not a fake handler.
 *
 * Threat model: a non-browser attacker knows a victim workspace's real
 * public call-widget key (embedded in the victim's own page — public, not a
 * secret) and its real allowed_domains entry, and can set arbitrary
 * Origin/Referer headers and rotate source IPs.
 */
import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-widget-security';

const VICTIM_WS = '22222222-2222-4222-8222-222222222222';
const VICTIM_PUBLIC_KEY = 'cck_victim_real_public_key';
const VICTIM_DOMAIN = 'victim.example';
const VICTIM_ORIGIN = `https://${VICTIM_DOMAIN}`;
const FARM_WS = '44444444-4444-4444-8444-444444444444';
const FARM_PUBLIC_KEY = 'cck_farm_real_public_key';

const PLATFORM_ROW = {
  singleton: true,
  call_center_enabled: true,
  voice_calls_enabled: true,
  video_calls_enabled: true,
  callback_requests_enabled: true,
  call_recording_enabled: false,
  screen_share_enabled: false,
  call_transfer_enabled: false,
  departments_enabled: false,
  advanced_routing_enabled: false,
  max_concurrent_calls_per_workspace: 10,
  max_queue_size_per_workspace: 10,
  max_monthly_call_minutes_per_workspace: 1000,
  max_callback_requests_per_month: 100,
  max_recording_storage_mb: 0,
  disabled_message: {},
  ringback_enabled: false,
  ringback_mode: 'off',
  ringback_music_path: null,
  ringback_music_url: null,
  ringback_announcement_audio_path: null,
  ringback_queue_audio_paths: {},
  queue_show_position: false,
  queue_show_eta: false,
  queue_eta_seconds_per_position: 30,
  queue_offer_callback_after_seconds: 60,
  operator_new_call_sound_enabled: false,
  widget_default_locale: 'en',
  widget_available_locales: ['en'],
  updated_at: new Date().toISOString(),
};

function workspaceRow(workspaceId: string, publicKey: string) {
  return {
    id: 'row_' + workspaceId,
    workspace_id: workspaceId,
    enabled: true,
    public_key: publicKey,
    allowed_domains: [VICTIM_DOMAIN],
    widget_position: 'bottom-right',
    widget_theme: {},
    display_name: null,
    avatar_url: null,
    avatar_storage_path: null,
    voice_enabled: true,
    video_enabled: true,
    callback_enabled: true,
    pre_call_form_enabled: false,
    pre_call_form_schema: [],
    business_hours: {},
    offline_behavior: 'hide',
    recording_enabled: false,
    recording_consent_required: false,
    operator_video_visible_to_visitor: true,
    routing_mode: 'broadcast',
    default_department_id: null,
    departments_enabled: false,
    allow_visitor_department_choice: false,
    widget_default_locale: null,
    widget_enabled_locales: null,
    widget_custom_texts: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

const WORKSPACES_BY_ID: Record<string, ReturnType<typeof workspaceRow>> = {
  [VICTIM_WS]: workspaceRow(VICTIM_WS, VICTIM_PUBLIC_KEY),
  [FARM_WS]: workspaceRow(FARM_WS, FARM_PUBLIC_KEY),
};
const WORKSPACES_BY_KEY: Record<string, ReturnType<typeof workspaceRow>> = {
  [VICTIM_PUBLIC_KEY]: WORKSPACES_BY_ID[VICTIM_WS],
  [FARM_PUBLIC_KEY]: WORKSPACES_BY_ID[FARM_WS],
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      let eqCol: string | undefined;
      let eqVal: any;
      const b: any = {
        select: () => b,
        eq: (col: string, val: any) => { eqCol = col; eqVal = val; return b; },
        in: () => b,
        contains: () => b,
        order: () => b,
        limit: async () => ({ data: [], error: null }),
        insert: () => b,
        update: () => b,
        maybeSingle: async () => {
          if (table === 'platform_call_center_settings') return { data: PLATFORM_ROW, error: null };
          if (table === 'call_center_settings') {
            if (eqCol === 'public_key') return { data: WORKSPACES_BY_KEY[eqVal] || null, error: null };
            if (eqCol === 'workspace_id') return { data: WORKSPACES_BY_ID[eqVal] || null, error: null };
            return { data: null, error: null };
          }
          return { data: null, error: null };
        },
      };
      b.then = undefined;
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

vi.mock('../../../server/supabase.js', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const client = (createClient as any)();
  return { getServiceClient: () => client };
});

const { callWidgetRouter } = await import('../../../server/routes/callWidget.js');
const { resolveRateLimitWorkspaceKey, callWidgetSessionRateLimiter } = await import('../../../server/middleware/security.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'ANON_KEY',
    supabaseServiceRoleKey: 'SERVICE_KEY',
  };
  next();
});
app.use(express.json());
// Mirrors server/index.ts's real mount chain for /api/call-widget so the
// session-nonce limiter is actually exercised, not just the router alone.
app.use('/api/call-widget', callWidgetSessionRateLimiter, callWidgetRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let parsed: any = d;
        try { parsed = JSON.parse(d); } catch { /* leave raw */ }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('call widget bootstrap — real route, credential trust boundary', () => {
  // TEST 10 — real public key + spoofed victim-matching Origin
  it('TEST 10: real public key + spoofed victim-matching Origin yields a session; it decodes rl:"public" and cannot select ws:VICTIM', async () => {
    const res = await call('GET', `/api/call-widget/bootstrap?publicKey=${VICTIM_PUBLIC_KEY}`, { origin: VICTIM_ORIGIN });
    expect(res.status).toBe(200);
    expect(typeof res.body.session).toBe('string');
    expect(res.body.session.split('.').length).toBe(2);

    const key = resolveRateLimitWorkspaceKey({
      ip: '198.51.100.9',
      headers: { 'x-cc-session': res.body.session },
      serverConfig: { supabaseServiceRoleKey: 'SERVICE_KEY' },
      body: {},
      query: {},
      originalUrl: '/api/call-widget/calls/x/status',
    } as any);
    expect(key).not.toBe(`ws:${VICTIM_WS}`);
  });

  it('TEST 10 cont.: workspaceId alone (no publicKey) also resolves the victim workspace', async () => {
    const res = await call('GET', `/api/call-widget/bootstrap?workspaceId=${VICTIM_WS}`, { origin: VICTIM_ORIGIN });
    expect(res.status).toBe(200);
    expect(typeof res.body.session).toBe('string');
  });

  // Missing Origin — call-widget's originAllowed() was already fail-closed
  // on main (verified: `if (!origin) return false`); this asserts the
  // existing correct behavior stays that way.
  it('missing Origin is rejected outright (originAllowed already fails closed on null origin)', async () => {
    const res = await call('GET', `/api/call-widget/bootstrap?publicKey=${VICTIM_PUBLIC_KEY}`, {});
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('origin_denied');
    expect(res.body.session).toBeUndefined();
  });

  // forged x-cc-session is never trusted
  it('forged x-cc-session is never trusted on a protected route', async () => {
    const res = await call('GET', '/api/call-widget/calls/00000000-0000-4000-8000-000000000000/status', {
      origin: VICTIM_ORIGIN,
      'x-cc-session': 'forged.invalidsignature',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_session');
  });

  // TEST 4-equivalent for call widget — token farming via IP rotation
  // against one victim workspace still cannot select ws:VICTIM (no
  // per-workspace bootstrap ceiling exists or is added — see
  // server/middleware/security.ts's callWidgetBootstrapRateLimiter, which
  // is per-IP + a process-global ceiling only).
  it('token farming via rotating IPs against one victim workspace cannot collectively select ws:VICTIM', async () => {
    const sessions: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await call('GET', `/api/call-widget/bootstrap?publicKey=${FARM_PUBLIC_KEY}`, {
        origin: VICTIM_ORIGIN,
        'x-forwarded-for': `45.2.${i}.1`,
      });
      expect(res.status).toBe(200);
      sessions.push(res.body.session);
    }
    for (const session of sessions) {
      const key = resolveRateLimitWorkspaceKey({
        ip: '198.51.100.10',
        headers: { 'x-cc-session': session },
        serverConfig: { supabaseServiceRoleKey: 'SERVICE_KEY' },
        body: {},
        query: {},
        originalUrl: '/api/call-widget/calls/x/status',
      } as any);
      expect(key).not.toBe(`ws:${FARM_WS}`);
    }
  });

  // TEST 11 — per-session limiting: one credential replayed from rotating
  // IPs must still be bounded by its own session-nonce bucket, not just IP.
  it('TEST 11: a single bootstrapped session credential is bounded by a per-session bucket regardless of source IP rotation', async () => {
    const boot = await call('GET', `/api/call-widget/bootstrap?publicKey=${VICTIM_PUBLIC_KEY}`, { origin: VICTIM_ORIGIN });
    const session = boot.body.session as string;
    expect(typeof session).toBe('string');

    let rateLimited = 0;
    for (let i = 0; i < 130; i++) {
      const res = await call('GET', '/api/call-widget/calls/00000000-0000-4000-8000-000000000000/status', {
        origin: VICTIM_ORIGIN,
        'x-cc-session': session,
        'x-forwarded-for': `45.3.${i % 250}.1`,
      });
      if (res.status === 429) rateLimited++;
    }
    expect(rateLimited).toBeGreaterThan(0);
  }, 30_000);
});

// TEST 12 — backward compatibility: a session signed before nonce/rl
// existed must parse as trust 'public' and never select ws:VICTIM.
describe('backward compatibility — pre-trust-claim call-widget sessions', () => {
  it('TEST 12: a legacy session (no nonce, no rl) never selects ws:VICTIM', async () => {
    const crypto = await import('node:crypto');
    const config: any = { widgetTokenSecret: undefined, sessionSecret: undefined, supabaseServiceRoleKey: 'SERVICE_KEY' };
    function legacySecret(): string {
      return config.widgetTokenSecret || config.sessionSecret || config.supabaseServiceRoleKey;
    }
    const now = Math.floor(Date.now() / 1000);
    const legacyPayload = {
      workspace_id: VICTIM_WS,
      public_key: VICTIM_PUBLIC_KEY,
      origin: VICTIM_ORIGIN,
      iat: now,
      exp: now + 1800,
      // no nonce, no rl — this is what every pre-migration session looks like
    };
    const body = Buffer.from(JSON.stringify(legacyPayload)).toString('base64url');
    const sig = crypto.createHmac('sha256', legacySecret()).update(body).digest('base64url');
    const legacyToken = `${body}.${sig}`;

    const { verifyWidgetSession } = await import('../../../server/services/callCenter/widgetSession.js');
    const parsed = verifyWidgetSession(config, legacyToken);
    expect(parsed?.workspace_id).toBe(VICTIM_WS);
    expect((parsed as any)?.rl).toBeUndefined();

    const key = resolveRateLimitWorkspaceKey({
      ip: '198.51.100.11',
      headers: { 'x-cc-session': legacyToken },
      serverConfig: config,
      body: {},
      query: {},
      originalUrl: '/api/call-widget/calls/x/status',
    } as any);
    expect(key).not.toBe(`ws:${VICTIM_WS}`);
  });
});
