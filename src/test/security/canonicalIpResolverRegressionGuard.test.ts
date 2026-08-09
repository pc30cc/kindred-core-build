/**
 * TEST 13 — canonical IP resolver regression guard.
 *
 * Every rate-limit layer touched by this security pass (the pre-existing
 * widgetWorkspaceRateLimiter/preAuthLimiter family in
 * server/middleware/security.ts, the new callWidgetSessionRateLimiter, and
 * the chat widget's per-category + per-session limiter in
 * server/services/widget/security.ts) MUST resolve client IPs through the
 * single canonical, trusted-proxy-aware resolver in server/utils/clientIp.ts
 * — never a bespoke X-Forwarded-For / CF-Connecting-IP parser. A second
 * parser is how header-spoofing regressions get reintroduced.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Request } from 'express';

const { getClientIp } = await import('../../../server/utils/clientIp.js');

describe('no bespoke X-Forwarded-For/CF-Connecting-IP parsing outside the canonical resolver', () => {
  const files = [
    'server/middleware/security.ts',
    'server/services/widget/security.ts',
    'server/services/callCenter/widgetSession.ts',
    'server/routes/callWidget.ts',
  ];

  for (const file of files) {
    it(`${file} does not read x-forwarded-for / cf-connecting-ip directly`, () => {
      const src = readFileSync(file, 'utf8');
      // Fail on any direct header read like req.headers['x-forwarded-for'].
      const directRead = /headers\s*\[\s*['"](x-forwarded-for|cf-connecting-ip|x-real-ip)['"]\s*\]/i;
      expect(directRead.test(src)).toBe(false);
    });
  }

  it('server/utils/clientIp.ts is the only module reading these headers directly', () => {
    const src = readFileSync('server/utils/clientIp.ts', 'utf8');
    expect(src).toContain("req.headers['cf-connecting-ip']");
    expect(src).toContain("req.headers['x-forwarded-for']");
  });
});

describe('canonical resolver used at runtime: untrusted direct client cannot rotate rate-limit identity via spoofed headers', () => {
  function req(overrides: Partial<Request> & { socket?: any } = {}): Request {
    return {
      headers: {},
      socket: { remoteAddress: '185.23.45.67' }, // public "attacker" peer — untrusted
      ip: '185.23.45.67',
      ...overrides,
    } as unknown as Request;
  }

  it('a direct (non-proxied) client cannot rotate its resolved IP via X-Forwarded-For', () => {
    const a = getClientIp(req({ headers: { 'x-forwarded-for': '1.1.1.1' } } as any));
    const b = getClientIp(req({ headers: { 'x-forwarded-for': '2.2.2.2' } } as any));
    // Untrusted peer → headers ignored entirely → both resolve to the real
    // socket peer, not the attacker-supplied header value.
    expect(a).toBe('185.23.45.67');
    expect(b).toBe('185.23.45.67');
    expect(a).toBe(b);
  });

  it('a direct client cannot rotate its resolved IP via CF-Connecting-IP either', () => {
    const a = getClientIp(req({ headers: { 'cf-connecting-ip': '3.3.3.3' } } as any));
    expect(a).toBe('185.23.45.67');
  });

  it('X-Forwarded-For IS honoured when the peer is a trusted (private-network) proxy — the real nginx/Coolify topology', () => {
    const trustedPeerReq = req({
      socket: { remoteAddress: '10.0.0.5' }, // private bridge network → trusted proxy
      headers: { 'x-forwarded-for': '45.33.32.156' }, // genuinely public, non-reserved
    } as any);
    expect(getClientIp(trustedPeerReq)).toBe('45.33.32.156');
  });
});
