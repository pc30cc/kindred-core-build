/* eslint-disable @typescript-eslint/no-explicit-any -- Express test doubles are intentionally untyped. */
import { describe, it, expect, afterEach, vi } from 'vitest';

const { resolveRateLimitWorkspaceKey, resolveTrustedRateLimitWorkspaceId } =
  await import('../../../server/middleware/security.js');
const { createSessionToken } = await import('../../../server/services/widget/security.js');
const { signWidgetSession } = await import('../../../server/services/callCenter/widgetSession.js');

const REFRESH = '/api/widget/session/refresh';
const BOOTSTRAP = '/api/widget/bootstrap';
const MESSAGE = '/api/widget/message';

function req(o: any = {}) {
  return { ip: '1.1.1.1', query: {}, body: {}, headers: {}, originalUrl: BOOTSTRAP, ...o } as any;
}

const FORGED = 'wss_' + Buffer.from(JSON.stringify({ w: 'VICTIM', o: '', n: 'x', iat: 1, exp: 9e9 })).toString('base64url') + '.deadbeef';

afterEach(() => { vi.useRealTimers(); });

describe('GAP 1 — untrusted workspace_id cannot select a victim bucket', () => {
  it('forged widget token + body.workspace_id=VICTIM → attacker IP bucket', () => {
    const key = resolveRateLimitWorkspaceKey(
      req({ ip: '5.5.5.5', headers: { 'x-widget-token': FORGED }, body: { workspace_id: 'VICTIM' } }),
    );
    expect(key).not.toBe('ws:VICTIM');
    expect(key).toBe('ip:5.5.5.5');
  });

  it('forged widget token + query.workspace_id=VICTIM → IP bucket', () => {
    const key = resolveRateLimitWorkspaceKey(
      req({ ip: '5.5.5.6', headers: { 'x-widget-token': FORGED }, query: { workspace_id: 'VICTIM' } }),
    );
    expect(key).toBe('ip:5.5.5.6');
  });

  it('forged widget token + body.workspaceId=VICTIM → IP bucket', () => {
    const key = resolveRateLimitWorkspaceKey(
      req({ ip: '5.5.5.7', headers: { 'x-widget-token': FORGED }, body: { workspaceId: 'VICTIM' } }),
    );
    expect(key).toBe('ip:5.5.5.7');
  });

  it('invalid x-cc-session + workspace_id=VICTIM → IP bucket', () => {
    const config: any = { widgetTokenSecret: 'cc-secret' };
    const key = resolveRateLimitWorkspaceKey(
      req({
        ip: '6.6.6.6',
        originalUrl: '/api/call-widget/bootstrap',
        serverConfig: config,
        headers: { 'x-cc-session': 'not-a-valid-session' },
        body: { workspace_id: 'VICTIM' },
      }),
    );
    expect(key).not.toBe('ws:VICTIM');
    expect(key).toBe('ip:6.6.6.6');
  });

  it('token-secured route without a token cannot use a raw workspace hint', () => {
    const key = resolveRateLimitWorkspaceKey(
      req({ ip: '7.7.7.7', originalUrl: MESSAGE, body: { workspace_id: 'VICTIM' } }),
    );
    expect(key).toBe('ip:7.7.7.7');
  });

  it('pre-auth bootstrap: raw workspace_id alone never selects a workspace bucket', () => {
    expect(resolveRateLimitWorkspaceKey(req({ ip: '1.1.1.9', body: { workspace_id: 'WS1' } }))).toBe('ip:1.1.1.9');
  });

  it('pre-auth bootstrap: a verified context WITHOUT rl:"workspace" still falls back to the IP bucket', () => {
    // `_widgetWorkspaceId` alone (as enforceWidgetToken sets it for every
    // verified 'public'-trust token) is not sufficient — only pairs with
    // `_widgetRateLimitTrust === 'workspace'` select the bucket.
    expect(resolveRateLimitWorkspaceKey(req({ _widgetWorkspaceId: 'WS1' }))).toBe('ip:1.1.1.1');
  });

  it('pre-auth bootstrap: only a cryptographically verified rl:"workspace" context selects the bucket', () => {
    expect(
      resolveRateLimitWorkspaceKey(req({ _widgetWorkspaceId: 'WS1', _widgetRateLimitTrust: 'workspace' })),
    ).toBe('ws:WS1');
  });

  it('a "public"-trust token (the only kind any bootstrap issues today) never wins the workspace bucket, even over an attacker-supplied workspace_id', () => {
    const token = createSessionToken('WS-A', 'https://shop.example');
    const key = resolveRateLimitWorkspaceKey(
      req({ headers: { 'x-widget-token': token }, body: { workspace_id: 'WS-B' } }),
    );
    expect(key).not.toBe('ws:WS-A');
    expect(key).not.toBe('ws:WS-B');
    expect(key).toBe('ip:1.1.1.1');
  });

  it('a genuine rl:"workspace" token wins over an attacker-supplied workspace_id — proves the mechanism still works', () => {
    const token = createSessionToken('WS-A', 'https://shop.example', 'workspace');
    const key = resolveRateLimitWorkspaceKey(
      req({ headers: { 'x-widget-token': token }, body: { workspace_id: 'WS-B' } }),
    );
    expect(key).toBe('ws:WS-A');
  });

  it('a "public"-trust cc session never wins the workspace bucket, even over an attacker-supplied workspace_id', () => {
    const config: any = { widgetTokenSecret: 'cc-secret' };
    const token = signWidgetSession(config, { workspace_id: 'WS-CC', public_key: null });
    const key = resolveRateLimitWorkspaceKey(
      req({ originalUrl: '/api/call-widget/bootstrap', serverConfig: config, headers: { 'x-cc-session': token }, body: { workspace_id: 'VICTIM' } }),
    );
    expect(key).not.toBe('ws:WS-CC');
    expect(key).toBe('ip:1.1.1.1');
  });

  it('a genuine rl:"workspace" cc session wins over an attacker-supplied workspace_id', () => {
    const config: any = { widgetTokenSecret: 'cc-secret' };
    const token = signWidgetSession(config, { workspace_id: 'WS-CC', public_key: null, rl: 'workspace' } as any);
    const key = resolveRateLimitWorkspaceKey(
      req({ originalUrl: '/api/call-widget/bootstrap', serverConfig: config, headers: { 'x-cc-session': token }, body: { workspace_id: 'VICTIM' } }),
    );
    expect(key).toBe('ws:WS-CC');
  });
});

describe('GAP 2 — /session/refresh uses refresh-grace semantics', () => {
  // R1-R3 use a genuine rl:'workspace' token so the grace/IP-rotation
  // mechanics are exercised against a real ws:<workspace> outcome — trust
  // class itself is covered separately above and in the "public token never
  // wins" tests below.
  it('R1 — valid rl:"workspace" token → ws:WS1', () => {
    const token = createSessionToken('WS1', 'https://shop.example', 'workspace');
    expect(resolveRateLimitWorkspaceKey(req({ originalUrl: REFRESH, headers: { 'x-widget-token': token } }))).toBe('ws:WS1');
  });

  it('R1b — a "public"-trust token on refresh never yields ws:WS1', () => {
    const token = createSessionToken('WS1', 'https://shop.example');
    expect(resolveRateLimitWorkspaceKey(req({ originalUrl: REFRESH, headers: { 'x-widget-token': token } }))).toBe('ip:1.1.1.1');
  });

  it('R2 — recently expired but inside grace → ws:WS1 (rl:"workspace")', () => {
    const token = createSessionToken('WS1', 'https://shop.example', 'workspace');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 17 * 60_000); // TTL 15m, grace 5m
    expect(resolveRateLimitWorkspaceKey(req({ ip: '2.2.2.2', originalUrl: REFRESH, headers: { 'x-widget-token': token } }))).toBe('ws:WS1');
  });

  it('R3 — IP rotation during refresh stays in one bucket (rl:"workspace")', () => {
    const token = createSessionToken('WS1', 'https://shop.example', 'workspace');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 17 * 60_000);
    const keys = ['9.9.9.1', '9.9.9.2', '9.9.9.3'].map((ip) =>
      resolveRateLimitWorkspaceKey(req({ ip, originalUrl: REFRESH, headers: { 'x-widget-token': token } })),
    );
    expect(new Set(keys)).toEqual(new Set(['ws:WS1']));
  });

  it('R4 — expired beyond grace resolves no trusted workspace', () => {
    const token = createSessionToken('WS1', 'https://shop.example');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60 * 60_000);
    const r = req({ ip: '3.3.3.3', originalUrl: REFRESH, headers: { 'x-widget-token': token } });
    expect(resolveTrustedRateLimitWorkspaceId(r)).toBeNull();
    expect(resolveRateLimitWorkspaceKey(r)).toBe('ip:3.3.3.3');
  });

  it('R5 — forged expired token never yields ws:VICTIM on refresh', () => {
    const forgedExpired = 'wss_' + Buffer.from(JSON.stringify({ w: 'VICTIM', o: '', n: 'x', iat: 1, exp: 2 })).toString('base64url') + '.deadbeef';
    const key = resolveRateLimitWorkspaceKey(
      req({ ip: '4.4.4.4', originalUrl: REFRESH, headers: { 'x-widget-token': forgedExpired }, body: { workspace_id: 'VICTIM' } }),
    );
    expect(key).not.toBe('ws:VICTIM');
    expect(key).toBe('ip:4.4.4.4');
  });

  it('grace semantics do NOT leak to non-refresh routes', () => {
    const token = createSessionToken('WS1', 'https://shop.example');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 17 * 60_000);
    expect(resolveRateLimitWorkspaceKey(req({ ip: '8.8.8.8', originalUrl: MESSAGE, headers: { 'x-widget-token': token } }))).toBe('ip:8.8.8.8');
  });
});
