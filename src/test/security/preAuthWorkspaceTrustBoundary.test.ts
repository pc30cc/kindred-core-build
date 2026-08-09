/* eslint-disable @typescript-eslint/no-explicit-any -- Express test doubles are intentionally untyped. */
/**
 * FINAL TRUST BOUNDARY — no spoofable/public client input may select the
 * authenticated per-workspace rate-limit bucket (`ws:<workspace>`).
 *
 * Threat model: a NON-BROWSER attacker who knows the victim's workspace UUID,
 * allowed domain and public call-widget key, and who can forge every HTTP
 * header (Origin, Referer, Host, X-Forwarded-*) and rotate source IPs.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

const { resolveRateLimitWorkspaceKey, widgetWorkspaceRateLimiter } =
  await import('../../../server/middleware/security.js');
const { createSessionToken } = await import('../../../server/services/widget/security.js');
const { signWidgetSession, signWidgetSessionWithTrust } = await import('../../../server/services/callCenter/widgetSession.js');

const VICTIM = '11111111-1111-4111-8111-111111111111';
const VICTIM_ORIGIN = 'https://victim.example';

function req(o: any = {}) {
  return { ip: '9.9.9.9', method: 'POST', query: {}, body: {}, headers: {}, originalUrl: '/api/widget/bootstrap', ...o } as any;
}

describe('T1–T7 — spoofable input never yields a victim workspace bucket', () => {
  it('T1 — spoofed valid Origin + victim workspace_id', () => {
    const key = resolveRateLimitWorkspaceKey(req({
      ip: '5.0.0.1',
      headers: { origin: VICTIM_ORIGIN },
      body: { workspace_id: VICTIM },
    }));
    expect(key).not.toBe(`ws:${VICTIM}`);
    expect(key).toBe('ip:5.0.0.1');
  });

  it('T2 — 20 rotating IPs with spoofed valid Origin produce zero victim buckets', () => {
    const keys = Array.from({ length: 20 }, (_, i) =>
      resolveRateLimitWorkspaceKey(req({
        ip: `5.1.0.${i + 1}`,
        headers: { origin: VICTIM_ORIGIN },
        body: { workspace_id: VICTIM },
      })));
    expect(keys.filter((k) => k.startsWith('ws:'))).toHaveLength(0);
    expect(new Set(keys).size).toBe(20); // each attacker IP pays its own quota
  });

  it('T3 — Referer spoof', () => {
    const key = resolveRateLimitWorkspaceKey(req({
      ip: '5.2.0.1',
      headers: { referer: `${VICTIM_ORIGIN}/page` },
      body: { workspace_id: VICTIM },
    }));
    expect(key).toBe('ip:5.2.0.1');
  });

  it('T4 — Host spoof on anonymous KB read', () => {
    const key = resolveRateLimitWorkspaceKey(req({
      ip: '5.3.0.1',
      method: 'GET',
      originalUrl: '/api/widget/kb/articles?workspace_id=' + VICTIM,
      headers: { host: 'victim.example' },
      query: { workspace_id: VICTIM },
    }));
    expect(key).toBe('ip:5.3.0.1');
  });

  it('T5 — X-Forwarded-Host / X-Forwarded-Proto spoof from an untrusted peer', () => {
    const key = resolveRateLimitWorkspaceKey(req({
      ip: '5.4.0.1',
      headers: {
        'x-forwarded-host': 'victim.example',
        'x-forwarded-proto': 'https',
        origin: VICTIM_ORIGIN,
      },
      body: { workspace_id: VICTIM, workspaceId: VICTIM },
    }));
    expect(key).toBe('ip:5.4.0.1');
  });

  it('T6 — real public call-widget key + spoofed valid Origin, no signed session', () => {
    const key = resolveRateLimitWorkspaceKey(req({
      ip: '5.5.0.1',
      method: 'GET',
      originalUrl: '/api/call-widget/bootstrap',
      query: { publicKey: 'pk_live_victim_public_key', workspaceId: VICTIM },
      headers: { origin: VICTIM_ORIGIN },
      serverConfig: { widgetTokenSecret: 'cc-secret' },
    }));
    expect(key).not.toBe(`ws:${VICTIM}`);
    expect(key).toBe('ip:5.5.0.1');
  });

  it('T7 — call-widget publicKey with 20 rotating IPs yields zero victim buckets', () => {
    const keys = Array.from({ length: 20 }, (_, i) =>
      resolveRateLimitWorkspaceKey(req({
        ip: `5.6.0.${i + 1}`,
        method: 'GET',
        originalUrl: '/api/call-widget/bootstrap',
        query: { publicKey: 'pk_live_victim_public_key' },
        headers: { origin: VICTIM_ORIGIN },
        serverConfig: { widgetTokenSecret: 'cc-secret' },
      })));
    expect(keys.some((k) => k.startsWith('ws:'))).toBe(false);
  });

  it('T10 — forged widget token + victim workspace_id + victim Origin → attacker IP bucket', () => {
    const forged = 'wss_' + Buffer.from(JSON.stringify({ w: VICTIM, o: VICTIM_ORIGIN, n: 'x', iat: 1, exp: 9e9 })).toString('base64url') + '.deadbeef';
    const key = resolveRateLimitWorkspaceKey(req({
      ip: '5.7.0.1',
      headers: { 'x-widget-token': forged, origin: VICTIM_ORIGIN },
      body: { workspace_id: VICTIM },
    }));
    expect(key).toBe('ip:5.7.0.1');
  });

  it('T12 — anonymous visitors/track with victim hints', () => {
    for (const path of ['/api/visitors/track', '/api/visitors/heartbeat', '/api/visitors/disconnect']) {
      const key = resolveRateLimitWorkspaceKey(req({
        ip: '5.8.0.1',
        originalUrl: path,
        headers: { origin: VICTIM_ORIGIN },
        body: { workspace_id: VICTIM, session_id: '22222222-2222-4222-8222-222222222222', visitor_id: 'v1' },
      }));
      expect(key).toBe('ip:5.8.0.1');
    }
  });
});

describe('T8/T9/T11 — a genuine rl:"workspace" credential yields the workspace bucket (mechanism still works)', () => {
  it('T8 — rl:"workspace" widget token → ws:REAL, IP-rotation resistant', () => {
    const token = createSessionToken('REAL-WS', 'https://shop.example', 'workspace');
    const a = resolveRateLimitWorkspaceKey(req({ ip: '8.0.0.1', originalUrl: '/api/widget/poll', headers: { 'x-widget-token': token } }));
    const b = resolveRateLimitWorkspaceKey(req({ ip: '8.0.0.2', originalUrl: '/api/widget/config', headers: { 'x-widget-token': token } }));
    expect(a).toBe('ws:REAL-WS');
    expect(b).toBe('ws:REAL-WS');
  });

  it('T8b — the SAME token shape bootstrap actually issues today ("public" trust) never yields ws:REAL', () => {
    const token = createSessionToken('REAL-WS', 'https://shop.example'); // default: 'public'
    const key = resolveRateLimitWorkspaceKey(req({ ip: '8.0.0.3', originalUrl: '/api/widget/poll', headers: { 'x-widget-token': token } }));
    expect(key).not.toBe('ws:REAL-WS');
    expect(key).toBe('ip:8.0.0.3');
  });

  it('T9 — signed rl:"workspace" call-widget session → ws:REAL', () => {
    const config: any = { widgetTokenSecret: 'cc-secret' };
    const session = signWidgetSessionWithTrust(config, { workspace_id: 'REAL-CC', public_key: 'pk_public', rl: 'workspace' });
    const key = resolveRateLimitWorkspaceKey(req({
      ip: '8.1.0.1',
      originalUrl: '/api/call-widget/state',
      serverConfig: config,
      headers: { 'x-cc-session': session },
    }));
    expect(key).toBe('ws:REAL-CC');
  });

  it('T9b — the SAME session shape bootstrap actually issues today ("public" trust) never yields ws:REAL', () => {
    const config: any = { widgetTokenSecret: 'cc-secret' };
    const session = signWidgetSession(config, { workspace_id: 'REAL-CC', public_key: 'pk_public' }); // default: 'public'
    const key = resolveRateLimitWorkspaceKey(req({
      ip: '8.1.0.2',
      originalUrl: '/api/call-widget/state',
      serverConfig: config,
      headers: { 'x-cc-session': session },
    }));
    expect(key).not.toBe('ws:REAL-CC');
  });

  it('T11 — refresh grace preserved on /session/refresh for a genuine rl:"workspace" token', () => {
    const token = createSessionToken('REAL-WS', 'https://shop.example', 'workspace');
    const key = resolveRateLimitWorkspaceKey(req({
      ip: '8.2.0.1',
      originalUrl: '/api/widget/session/refresh',
      headers: { 'x-widget-token': token },
    }));
    expect(key).toBe('ws:REAL-WS');
  });
});

describe('middleware ordering — real express chain', () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.set('trust proxy', false);
    // Mirrors server/index.ts: pre-auth bootstrap has NO workspace limiter.
    // The bootstrap handler here mints the SAME trust class the real
    // widgetRouter bootstrap issues today: 'public' (the default third arg).
    a.post('/api/widget/bootstrap', (req, res) => {
      res.json({ bucket: resolveRateLimitWorkspaceKey(req as any), token: createSessionToken('REAL-WS', 'https://shop.example') });
    });
    a.use('/api/widget', widgetWorkspaceRateLimiter, (req, res) => {
      res.json({ bucket: resolveRateLimitWorkspaceKey(req as any) });
    });
    return a;
  }

  it('bootstrap (spoofed victim identity) → IP bucket; a real "public"-trust token STILL never reaches ws:REAL', async () => {
    const boot = await request(app())
      .post('/api/widget/bootstrap')
      .set('Origin', VICTIM_ORIGIN)
      .send({ workspace_id: VICTIM });
    expect(boot.status).toBe(200);
    expect(boot.body.bucket.startsWith('ws:')).toBe(false);
    expect(typeof boot.body.token).toBe('string');

    // This is the credential a real attacker (or a real visitor) actually
    // gets from bootstrap. It authenticates the caller for functional widget
    // routes, but per the trust boundary it must NOT select the shared
    // workspace hard-blocking bucket — only IP/session buckets apply to it.
    const authed = await request(app())
      .get('/api/widget/poll')
      .set('x-widget-token', boot.body.token);
    expect(authed.body.bucket.startsWith('ws:')).toBe(false);
  });

  it('a hypothetical rl:"workspace" token (no issuer today) WOULD reach ws:REAL — proves the bucket mechanism itself is intact', async () => {
    const strongToken = createSessionToken('REAL-WS', 'https://shop.example', 'workspace');
    const authed = await request(app())
      .get('/api/widget/poll')
      .set('x-widget-token', strongToken);
    expect(authed.body.bucket).toBe('ws:REAL-WS');
  });

  it('anonymous KB request never reaches a workspace bucket', async () => {
    const res = await request(app())
      .get('/api/widget/kb/articles?workspace_id=' + VICTIM)
      .set('Host', 'victim.example');
    expect(res.body.bucket.startsWith('ws:')).toBe(false);
  });
});
