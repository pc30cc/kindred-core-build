/* eslint-disable @typescript-eslint/no-explicit-any -- Express test doubles are intentionally untyped. */
import { describe, it, expect } from 'vitest';

vi_mock_placeholder: {
  // no mocks needed — everything below is pure HMAC / URL logic
  break vi_mock_placeholder;
}

const { resolveRateLimitWorkspaceKey } = await import('../../../server/middleware/security.js');
const { createSessionToken } = await import('../../../server/services/widget/security.js');
const { signWidgetSession } = await import('../../../server/services/callCenter/widgetSession.js');
const { toStrictOrigin } = await import('../../../server/utils/domain.js');

function req(overrides: any = {}) {
  return {
    ip: '1.1.1.1',
    query: {},
    body: {},
    headers: {},
    ...overrides,
  } as any;
}

describe('rate-limit workspace key resolution', () => {
  it('Test A — workspace_id in body/query shares one bucket across IPs', () => {
    const a = resolveRateLimitWorkspaceKey(req({ ip: '1.1.1.1', body: { workspace_id: 'WS1' } }));
    const b = resolveRateLimitWorkspaceKey(req({ ip: '2.2.2.2', query: { workspace_id: 'WS1' } }));
    expect(a).toBe('ws:WS1');
    expect(b).toBe('ws:WS1');
  });

  it('Test B — verified widget token yields the workspace bucket without workspace_id', () => {
    const token = createSessionToken('WS1', 'https://shop.example');
    const key = resolveRateLimitWorkspaceKey(req({ headers: { 'x-widget-token': token } }));
    expect(key).toBe('ws:WS1');
  });

  it('Test B2 — verified call-widget session token yields the workspace bucket', () => {
    const config: any = { widgetTokenSecret: 'cc-secret' };
    const token = signWidgetSession(config, { workspace_id: 'WS-CC', public_key: null });
    const key = resolveRateLimitWorkspaceKey(
      req({ headers: { 'x-cc-session': token }, serverConfig: config }),
    );
    expect(key).toBe('ws:WS-CC');
  });

  it('Test C — IP rotation with the same token stays in one bucket', () => {
    const token = createSessionToken('WS1', 'https://shop.example');
    const keys = ['9.9.9.1', '9.9.9.2', '9.9.9.3'].map((ip) =>
      resolveRateLimitWorkspaceKey(req({ ip, headers: { 'x-widget-token': token } })),
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('ws:WS1');
  });

  it('Test D — forged/unverified token cannot select a victim workspace bucket', () => {
    const forged = 'wss_' + Buffer.from(JSON.stringify({ w: 'victimWorkspace', o: '', n: 'x', iat: 1, exp: 9e9 })).toString('base64url') + '.deadbeef';
    const key = resolveRateLimitWorkspaceKey(req({ ip: '5.5.5.5', headers: { 'x-widget-token': forged } }));
    expect(key).not.toBe('ws:victimWorkspace');
    expect(key).toBe('ip:5.5.5.5');
  });

  it('Test D2 — a verified token wins over an attacker-supplied workspace_id', () => {
    const token = createSessionToken('WS1', 'https://shop.example');
    const key = resolveRateLimitWorkspaceKey(
      req({ headers: { 'x-widget-token': token }, body: { workspace_id: 'victimWorkspace' } }),
    );
    expect(key).toBe('ws:WS1');
  });

  it('Test E — no trusted workspace context falls back to a normalized IP bucket', () => {
    expect(resolveRateLimitWorkspaceKey(req({ ip: '4.4.4.4' }))).toBe('ip:4.4.4.4');
  });
});

describe('strict same-origin comparison (scheme + host + port)', () => {
  it('Test F — identical origins match', () => {
    expect(toStrictOrigin('https://app.example.com')).toBe(toStrictOrigin('https://app.example.com'));
  });
  it('Test G — scheme mismatch is not same-origin', () => {
    expect(toStrictOrigin('http://app.example.com')).not.toBe(toStrictOrigin('https://app.example.com'));
  });
  it('Test H — port mismatch is not same-origin', () => {
    expect(toStrictOrigin('https://app.example.com:8443')).not.toBe(toStrictOrigin('https://app.example.com'));
  });
  it('Test I — hostname mismatch is not same-origin', () => {
    expect(toStrictOrigin('https://evil.example.com')).not.toBe(toStrictOrigin('https://app.example.com'));
  });
  it('default ports normalize away, scheme-less input is rejected', () => {
    expect(toStrictOrigin('https://app.example.com:443')).toBe('https://app.example.com');
    expect(toStrictOrigin('app.example.com')).toBeNull();
  });
});
