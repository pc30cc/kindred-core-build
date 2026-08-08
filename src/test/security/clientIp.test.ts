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
const PUBLIC_CLIENT = '185.23.45.67';

beforeEach(() => {
  delete process.env.TRUSTED_PROXY_IPS;
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

  it('falls back to X-Real-IP when no XFF is present', () => {
    const req = mkReq({ peer: PROXY, headers: { 'x-real-ip': PUBLIC_CLIENT } });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
  });

  it('falls back to req.ip when no forwarding headers are present', () => {
    const req = mkReq({ peer: PROXY, expressIp: PUBLIC_CLIENT });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
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

  it('returns the country only on a trusted path', () => {
    expect(getClientCountry(mkReq({ peer: PROXY, headers: { 'cf-ipcountry': 'tr' } }))).toBe('TR');
  });

  it('rejects the XX / T1 sentinels', () => {
    expect(getClientCountry(mkReq({ peer: PROXY, headers: { 'cf-ipcountry': 'XX' } }))).toBeNull();
    expect(getClientCountry(mkReq({ peer: PROXY, headers: { 'cf-ipcountry': 'T1' } }))).toBeNull();
  });

  it('is entirely optional — resolution works with no CF headers at all', () => {
    const req = mkReq({ peer: PROXY, headers: { 'x-forwarded-for': PUBLIC_CLIENT } });
    expect(getClientIp(req)).toBe(PUBLIC_CLIENT);
    expect(getClientCountry(req)).toBeNull();
  });
});

describe('TRUSTED_PROXY_IPS allowlist', () => {
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
