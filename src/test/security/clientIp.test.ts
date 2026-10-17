/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase/provider test doubles are intentionally untyped. */
/**
 * Client IP resolution — trust boundary, normalization and privacy.
 *
 * Covers server/utils/clientIp.ts: the single canonical resolver used by the
 * widget, visitor, identity and call-widget paths.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Request } from 'express';
import {
  getClientIp,
  getClientCountry,
  getEdgeIp,
  isCloudflareIp,
  hashIp,
  isPublicIp,
  isPrivateOrReservedIp,
  maskIp,
  normalizeIp,
  resetTrustedProxyCache,
} from '../../../server/utils/clientIp';

function mkReq(opts: {
  peer?: string;
  headers?: Record<string, string | string[]>;
  expressIp?: string;
}): Request {
  return {
    headers: opts.headers ?? {},
    socket: { remoteAddress: opts.peer } as any,
    ip: opts.expressIp,
  } as unknown as Request;
}

const PROXY = '10.0.0.5';       // private peer → trusted (Traefik/Coolify/nginx)
const NGINX = '10.0.0.9';       // an nginx that reaches the backend over the private network
const PUBLIC_CLIENT = '185.23.45.67';
const CF_EDGE = '172.70.1.1';   // 172.64.0.0/13, a Cloudflare edge
const CF_EDGE_V6 = '2606:4700:10::6816:1';

beforeEach(() => {
  delete process.env.TRUSTED_PROXY_IPS;
  delete process.env.CLOUDFLARE_IPS;
  resetTrustedProxyCache();
});

describe('normalization', () => {
  it('unwraps IPv4-mapped IPv6', () => {
    expect(normalizeIp('::ffff:185.1.2.3')).toBe('185.1.2.3');
  });
  it('strips ports and brackets and zone ids', () => {
    expect(normalizeIp('185.1.2.3:5678')).toBe('185.1.2.3');
    expect(normalizeIp('[2a01:4f8::1]')).toBe('2a01:4f8::1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
  });
  it('rejects garbage', () => {
    expect(normalizeIp('unknown')).toBeNull();
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(normalizeIp('999.1.1.1')).toBeNull();
    expect(normalizeIp('')).toBeNull();
  });
});

describe('private / reserved detection', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '192.168.1.10', '172.16.0.1', '172.31.255.254',
    '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1',
    '224.0.0.1', '2001:db8::1',
  ])('%s is private/reserved', (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each(['185.23.45.67', '8.8.8.8', '172.32.0.1', '2a01:4f8:c17::1'])(
    '%s is public',
    (ip) => {
      expect(isPublicIp(ip)).toBe(true);
    },
  );
});

describe('direct connection (no proxy)', () => {
  it('resolves a public IPv4 socket peer', () => {
    expect(getClientIp(mkReq({ peer: PUBLIC_CLIENT }))).toBe(PUBLIC_CLIENT);
  });

  it('resolves a public IPv6 socket peer', () => {
    expect(getClientIp(mkReq({ peer: '2a01:4f8:c17::1' }))).toBe('2a01:4f8:c17::1');
  });

  it('normalizes an IPv4-mapped IPv6 socket peer', () => {
    expect(getClientIp(mkReq({ peer: '::ffff:185.1.2.3' }))).toBe('185.1.2.3');
  });

  it('returns null for a private-only peer (local dev)', () => {
    expect(getClientIp(mkReq({ peer: '127.0.0.1' }))).toBeNull();
  });

  it('IGNORES a spoofed X-Forwarded-For sent straight to the origin', () => {
    const req = mkReq({
      peer: PUBLIC_CLIENT,
      headers: { 'x-forwarded-for': '8.8.8.8' },
    });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });

  it('IGNORES a forged CF-Connecting-IP sent straight to the origin', () => {
    const req = mkReq({
      peer: PUBLIC_CLIENT,
      headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '8.8.8.8' },
    });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });

  it('IGNORES a forged CF-IPCountry sent straight to the origin', () => {
    const req = mkReq({ peer: PUBLIC_CLIENT, headers: { 'cf-ipcountry': 'US' } });
    expect(getClientCountry(req)).toBeNull();
  });
});

describe('behind a trusted reverse proxy (Coolify / Traefik / nginx)', () => {
  it('uses X-Forwarded-For', () => {
    const req = mkReq({ peer: PROXY, headers: { 'x-forwarded-for': PUBLIC_CLIENT } });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });

  it('walks a multi-hop chain and skips private hops', () => {
    const req = mkReq({
      peer: PROXY,
      headers: { 'x-forwarded-for': `${PUBLIC_CLIENT}, 10.0.0.9, 172.18.0.4` },
    });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });

  it('skips malformed entries in the chain', () => {
    const req = mkReq({
      peer: PROXY,
      headers: { 'x-forwarded-for': `unknown, ${PUBLIC_CLIENT}, , 10.0.0.9` },
    });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });

  it('X-Real-IP, only from our own proxy and only without XFF, is a plain client: a Cloudflare X-Real-IP does not make its cf-connecting-ip believed', () => {
    // A self-host nginx with only `proxy_set_header X-Real-IP $remote_addr`.
    expect(getClientIp(mkReq({ peer: PROXY, headers: { 'x-real-ip': PUBLIC_CLIENT } }))).toBe(PUBLIC_CLIENT);
    const forged = mkReq({ peer: PROXY, headers: { 'x-real-ip': CF_EDGE, 'cf-connecting-ip': '9.9.9.9', 'cf-ipcountry': 'US' } });
    expect(getEdgeIp(forged)).toBeNull();
    expect(getClientIp(forged)).toBe(CF_EDGE);
    expect(getClientCountry(forged)).toBeNull();
    // A direct client's own X-Real-IP, a private one, or two of them: nothing.
    expect(getClientIp(mkReq({ peer: PUBLIC_CLIENT, headers: { 'x-real-ip': '9.9.9.9' } }))).toBe(PUBLIC_CLIENT);
    expect(getClientIp(mkReq({ peer: PROXY, headers: { 'x-real-ip': '10.0.0.9' } }))).toBeNull();
    expect(getClientIp(mkReq({ peer: PROXY, headers: { 'x-real-ip': `9.9.9.9, ${PUBLIC_CLIENT}` } }))).toBeNull();
  });

  it('does not read req.ip (it is getClientIp itself once installed): no headers = unknown', () => {
    const req = mkReq({ peer: PROXY, expressIp: PUBLIC_CLIENT });
    expect(getClientIp(req)).toBeNull();
  });

  it('returns null when the whole chain is private', () => {
    const req = mkReq({ peer: PROXY, headers: { 'x-forwarded-for': '10.1.1.1, 192.168.0.2' } });
    expect(getClientIp(req)).toBeNull();
  });
});

describe('Cloudflare', () => {
  it('prefers CF-Connecting-IP on a trusted path', () => {
    const req = mkReq({
      peer: PROXY,
      headers: { 'cf-connecting-ip': PUBLIC_CLIENT, 'x-forwarded-for': `${PUBLIC_CLIENT}, 172.70.1.1` },
    });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });

  it('returns the country only when the hop our proxy saw is Cloudflare', () => {
    expect(getClientCountry(mkReq({ peer: PROXY, headers: { 'x-forwarded-for': CF_EDGE, 'cf-ipcountry': 'tr' } }))).toBe('TR');
    expect(getClientCountry(mkReq({ peer: PROXY, headers: { 'cf-ipcountry': 'tr' } }))).toBeNull();
  });

  it('rejects the XX / T1 sentinels', () => {
    expect(getClientCountry(mkReq({ peer: PROXY, headers: { 'x-forwarded-for': CF_EDGE, 'cf-ipcountry': 'XX' } }))).toBeNull();
    expect(getClientCountry(mkReq({ peer: PROXY, headers: { 'x-forwarded-for': CF_EDGE, 'cf-ipcountry': 'T1' } }))).toBeNull();
  });

  it('Traefik stripped Cloudflare\'s X-Forwarded-For: the edge is the only entry', () => {
    const req = mkReq({ peer: PROXY, headers: { 'x-forwarded-for': CF_EDGE, 'cf-connecting-ip': PUBLIC_CLIENT } });
    expect(getEdgeIp(req)).toBe(CF_EDGE);
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });

  it('Cloudflare -> Traefik -> an nginx on the private network -> backend', () => {
    const req = mkReq({
      peer: NGINX,
      headers: { 'x-forwarded-for': `${CF_EDGE}, ${PROXY}`, 'x-real-ip': PROXY, 'cf-connecting-ip': PUBLIC_CLIENT },
    });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });

  it('an IPv6 Cloudflare edge and an IPv6 visitor', () => {
    const req = mkReq({ peer: `::ffff:${PROXY}`, headers: { 'x-forwarded-for': CF_EDGE_V6, 'cf-connecting-ip': '2a01:4f8:c17::1' } });
    expect(getClientIp(req)).toBe('2a01:4f8:c17::1');
  });

  it('Cloudflare connecting straight to Node (no proxy of ours in front)', () => {
    const req = mkReq({ peer: '162.158.10.20', headers: { 'cf-connecting-ip': PUBLIC_CLIENT, 'cf-ipcountry': 'de' } });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
    expect(getClientCountry(req)).toBe('DE');
  });

  it('a Cloudflare edge without cf-connecting-ip is unknown, not the edge', () => {
    expect(getClientIp(mkReq({ peer: PROXY, headers: { 'x-forwarded-for': CF_EDGE } }))).toBeNull();
  });

  it('knows the published ranges, IPv4 and IPv6, and nothing else', () => {
    for (const ip of ['173.245.48.1', '104.16.0.1', '131.0.75.254', '2400:cb00::1', '2a06:98c0:3600::103', '::ffff:162.158.0.1']) {
      expect(isCloudflareIp(ip)).toBe(true);
    }
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.63.255.255', '172.72.0.1', PROXY, '2a01:4f8::1', 'garbage']) {
      expect(isCloudflareIp(ip)).toBe(false);
    }
  });
});

describe('origin bypass: a client that reaches the server\'s IP directly, through our Traefik', () => {
  // Traefik appends the peer it saw (the client) to X-Forwarded-For.
  it('IGNORES a forged CF-Connecting-IP', () => {
    const req = mkReq({ peer: PROXY, headers: { 'x-forwarded-for': PUBLIC_CLIENT, 'cf-connecting-ip': '9.9.9.9' } });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });

  it('IGNORES a forged CF-IPCountry', () => {
    const req = mkReq({ peer: PROXY, headers: { 'x-forwarded-for': PUBLIC_CLIENT, 'cf-ipcountry': 'US' } });
    expect(getClientCountry(req)).toBeNull();
  });

  it('a forged Cloudflare hop LEFT of the entry Traefik appended does not help', () => {
    const req = mkReq({
      peer: PROXY,
      headers: { 'x-forwarded-for': `1.2.3.4, ${CF_EDGE}, ${PUBLIC_CLIENT}`, 'cf-connecting-ip': '9.9.9.9', 'cf-ipcountry': 'US' },
    });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
    expect(getClientCountry(req)).toBeNull();
  });

  it('a forged X-Real-IP is not read while X-Forwarded-For is there', () => {
    const req = mkReq({ peer: PROXY, headers: { 'x-forwarded-for': PUBLIC_CLIENT, 'x-real-ip': CF_EDGE, 'cf-connecting-ip': '9.9.9.9' } });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });

  it('an unreadable right-most hop vouches for nothing', () => {
    const req = mkReq({ peer: PROXY, headers: { 'x-forwarded-for': `${CF_EDGE}, not-an-ip`, 'cf-connecting-ip': '9.9.9.9' } });
    expect(getClientIp(req)).toBeNull();
  });
});

describe('CLOUDFLARE_IPS', () => {
  it('off: cf-* headers are never believed (no Cloudflare in front)', () => {
    process.env.CLOUDFLARE_IPS = 'off';
    resetTrustedProxyCache();
    const req = mkReq({ peer: PROXY, headers: { 'x-forwarded-for': CF_EDGE, 'cf-connecting-ip': PUBLIC_CLIENT, 'cf-ipcountry': 'TR' } });
    expect(getClientIp(req)).toBe(CF_EDGE);
    expect(getClientCountry(req)).toBeNull();
  });

  it('replaces the list; `default` keeps the published ranges (Cloudflare Tunnel)', () => {
    process.env.CLOUDFLARE_IPS = 'default, 10.0.5.3';
    resetTrustedProxyCache();
    expect(getClientIp(mkReq({ peer: '10.0.5.3', headers: { 'cf-connecting-ip': PUBLIC_CLIENT } }))).toBe(PUBLIC_CLIENT);
    expect(getClientIp(mkReq({ peer: PROXY, headers: { 'x-forwarded-for': CF_EDGE, 'cf-connecting-ip': PUBLIC_CLIENT } }))).toBe(PUBLIC_CLIENT);
    // Traefik (10.0.0.5) is still not a Cloudflare hop.
    expect(getClientIp(mkReq({ peer: PROXY, headers: { 'x-forwarded-for': '45.33.32.156', 'cf-connecting-ip': PUBLIC_CLIENT } }))).toBe('45.33.32.156');
  });

  it('ignores entries that are not an IP or CIDR (and a /0)', () => {
    process.env.CLOUDFLARE_IPS = 'nonsense, 1.2.3.0/40, 0.0.0.0/0, 203.0.113.0/24';
    resetTrustedProxyCache();
    expect(isCloudflareIp('203.0.113.9')).toBe(true);
    expect(isCloudflareIp('8.8.8.8')).toBe(false);
    expect(isCloudflareIp(CF_EDGE)).toBe(false);
  });

  it('is entirely optional — resolution works with no CF headers at all', () => {
    const req = mkReq({ peer: PROXY, headers: { 'x-forwarded-for': PUBLIC_CLIENT } });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
    expect(getClientCountry(req)).toBeNull();
  });
});

describe('TRUSTED_PROXY_IPS allowlist', () => {
  it('a Cloudflare hop listed in TRUSTED_PROXY_IPS still ends the walk', () => {
    process.env.TRUSTED_PROXY_IPS = '172.70.';
    resetTrustedProxyCache();
    const req = mkReq({ peer: PROXY, headers: { 'x-forwarded-for': CF_EDGE, 'cf-connecting-ip': PUBLIC_CLIENT } });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });

  it('trusts an explicitly allowlisted public peer', () => {
    process.env.TRUSTED_PROXY_IPS = '203.0.113.7,172.70.';
    resetTrustedProxyCache();
    const req = mkReq({ peer: '203.0.113.7', headers: { 'x-forwarded-for': PUBLIC_CLIENT } });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });

  it('skips allowlisted proxy hops inside the XFF chain', () => {
    process.env.TRUSTED_PROXY_IPS = '198.51.100.10';
    resetTrustedProxyCache();
    const req = mkReq({
      peer: '10.0.0.5',
      headers: { 'x-forwarded-for': `${PUBLIC_CLIENT}, 198.51.100.10` },
    });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });
});

describe('hashIp / maskIp', () => {
  it('is null-safe', () => {
    expect(hashIp(null)).toBe('');
    expect(hashIp(undefined)).toBe('');
    expect(hashIp('')).toBe('');
  });

  it('is stable, 16 hex chars, and irreversible', () => {
    const h = hashIp(PUBLIC_CLIENT);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(hashIp(PUBLIC_CLIENT)).toBe(h);
    expect(h).not.toContain('185');
  });

  it('hashes the normalized form (mapped IPv6 === IPv4)', () => {
    expect(hashIp('::ffff:185.1.2.3')).toBe(hashIp('185.1.2.3'));
  });

  it('masks for display', () => {
    expect(maskIp('185.23.45.67')).toBe('185.23.xxx.xxx');
    expect(maskIp('2a01:4f8::1')).toBe('2a01:xxxx::xxxx');
    expect(maskIp(null)).toBe('');
  });
});

describe('the header shapes production really forwards (observed on vps-50cc1602, 2026-10-17)', () => {
  // Traefik (10.0.1.7) has no forwardedHeaders settings: it drops a client's
  // own X-Forwarded-For / X-Real-Ip, writes the TCP peer it saw into both,
  // and passes cf-* headers through untouched.
  const TRAEFIK = '10.0.1.7';

  it('straight to the origin over IPv4, with forged cf-* headers: the address Traefik saw, no country', () => {
    const req = mkReq({
      peer: TRAEFIK,
      headers: { 'x-forwarded-for': PUBLIC_CLIENT, 'x-real-ip': PUBLIC_CLIENT, 'cf-connecting-ip': '9.9.9.9', 'cf-ipcountry': 'US' },
    });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
    expect(getClientCountry(req)).toBeNull();
  });

  it('straight to the origin over IPv6: the IPv6 address Traefik saw', () => {
    const req = mkReq({
      peer: TRAEFIK,
      headers: { 'x-forwarded-for': '2a01:4f8:c0c:1234::7', 'x-real-ip': '2a01:4f8:c0c:1234::7', 'cf-connecting-ip': '9.9.9.9' },
    });
    expect(getClientIp(req)).toBe('2a01:4f8:c0c:1234::7');
  });

  it('through Cloudflare: Traefik names the edge, the edge names the visitor and its country', () => {
    const req = mkReq({
      peer: TRAEFIK,
      headers: { 'x-forwarded-for': '162.158.127.231', 'x-real-ip': '162.158.127.231', 'cf-connecting-ip': '2a01:4f8:c0c:1234::7', 'cf-ipcountry': 'CA' },
    });
    expect(getClientIp(req)).toBe('2a01:4f8:c0c:1234::7');
    expect(getClientCountry(req)).toBe('CA');
  });

  it("through the frontend's nginx (/api/ on app.*): BACKEND_URL is https://api.*, so it goes out through Cloudflare again and the client is the server itself", () => {
    // Traefik drops the X-Forwarded-For nginx built; Cloudflare names the
    // address that connected to it: 192.99.68.134. The visitor is lost on this
    // path (the SPAs call https://api.* directly, so nothing uses it today).
    const req = mkReq({
      peer: TRAEFIK,
      headers: { 'x-forwarded-for': '172.70.85.12', 'x-real-ip': '172.70.85.12', 'cf-connecting-ip': '192.99.68.134' },
    });
    expect(getClientIp(req)).toBe('192.99.68.134');
  });

  it('an nginx that talks to the backend over the private network (a self-host topology) keeps the visitor', () => {
    const req = mkReq({
      peer: '10.0.1.24',
      headers: { 'x-forwarded-for': `162.158.127.231, ${TRAEFIK}`, 'x-real-ip': TRAEFIK, 'cf-connecting-ip': PUBLIC_CLIENT },
    });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });
});

describe('one spelling per address', () => {
  it('unwraps IPv4-mapped IPv6 in every spelling, so a mapped loopback is private and hashes like its IPv4', () => {
    for (const x of ['::ffff:1.2.3.4', '::ffff:102:304', '0:0:0:0:0:ffff:1.2.3.4', '::FFFF:0102:0304']) expect(normalizeIp(x)).toBe('1.2.3.4');
    expect(isPrivateOrReservedIp('::ffff:7f00:1')).toBe(true);
    expect(hashIp('::ffff:102:304')).toBe(hashIp('1.2.3.4'));
    // A Cloudflare hop naming a mapped private address is not believed.
    expect(getClientIp(mkReq({ peer: PROXY, headers: { 'x-forwarded-for': CF_EDGE, 'cf-connecting-ip': '::ffff:a00:1' } }))).toBeNull();
  });

  it('writes IPv6 in its RFC 5952 form, and matches only the real reserved ranges', () => {
    expect(normalizeIp('2A01:04F8:0000:0000:0000:0000:0000:0001')).toBe('2a01:4f8::1');
    expect(hashIp('2a01:4f8:0:0::1')).toBe(hashIp('2a01:4f8::1'));
    expect(isPrivateOrReservedIp('2001:db8::1')).toBe(true);
    expect(isPrivateOrReservedIp('2001:db80::1')).toBe(false);
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
    expect(isPrivateOrReservedIp('febf::1')).toBe(true);
    expect(isPrivateOrReservedIp('fec0::1')).toBe(false);
    expect(isPrivateOrReservedIp('64:ff9b::1.2.3.4')).toBe(true);
    expect(isPrivateOrReservedIp('64:ff9b:1::1')).toBe(false);
  });
});

describe('scripts/security/check-cloudflare-ips.mjs (the weekly drift check)', () => {
  it('reads exactly the lists clientIp.ts uses, and reports a difference both ways', async () => {
    const { builtInRanges, rangeDiff } = await import('../../../scripts/security/check-cloudflare-ips.mjs');
    const { CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES } = await import('../../../server/utils/clientIp');
    const ours = builtInRanges();
    expect(ours.ipv4).toEqual([...CLOUDFLARE_IPV4_RANGES]);
    expect(ours.ipv6).toEqual([...CLOUDFLARE_IPV6_RANGES]);
    expect(rangeDiff(['1.0.0.0/8', '2.0.0.0/8'], ['2.0.0.0/8', '3.0.0.0/8'])).toEqual({ missing: ['3.0.0.0/8'], stale: ['1.0.0.0/8'] });
    // Every built-in range is one isCloudflareIp accepts.
    for (const r of [...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES]) expect(isCloudflareIp(r.split('/')[0])).toBe(true);
  });
});
