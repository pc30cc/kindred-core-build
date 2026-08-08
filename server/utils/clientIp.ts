/**
 * Client IP extraction — production-grade, proxy-aware, privacy-aware.
 *
 * ── Trust model ────────────────────────────────────────────────────────────
 * Forwarding headers (`cf-connecting-ip`, `x-forwarded-for`, `x-real-ip`,
 * `cf-ipcountry`) are **only** honoured when the TCP peer that opened the
 * connection is itself a trusted proxy. A client talking straight to the
 * origin can therefore not spoof its IP by sending those headers.
 *
 * A peer is trusted when:
 *   - it is loopback / private / link-local / unique-local (the normal case:
 *     nginx, Traefik, Coolify and Docker all sit on a private bridge), or
 *   - it is explicitly listed in the `TRUSTED_PROXY_IPS` env var
 *     (comma-separated; exact IPs, or prefixes ending in `.` / `:`).
 *
 * ── Resolution order (only the trusted branches are consulted) ─────────────
 *   1. cf-connecting-ip        (Cloudflare — trusted path only)
 *   2. x-forwarded-for         (right-most non-proxy public hop)
 *   3. x-real-ip               (nginx / Coolify / generic reverse proxies)
 *   4. req.ip                  (Express, honours `trust proxy`)
 *   5. req.socket.remoteAddress(direct connection — no proxy at all)
 *
 * Returns `null` when no *public* client IP can be determined. We never
 * invent a placeholder.
 */
import type { Request } from 'express';
import { createHash } from 'crypto';
import { isIP } from 'node:net';

/** Strip zone id / IPv4-mapped IPv6 prefix and lower-case. `null` if not an IP. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = String(raw).trim().toLowerCase();
  if (!ip || ip === 'unknown') return null;
  // "[2a01::1]:443" or "1.2.3.4:5678" (some proxies append the port)
  if (ip.startsWith('[')) {
    const close = ip.indexOf(']');
    if (close > 0) ip = ip.slice(1, close);
  } else if (ip.includes('.') && ip.includes(':') && ip.split(':').length === 2) {
    ip = ip.split(':')[0];
  }
  const zone = ip.indexOf('%');
  if (zone > 0) ip = ip.slice(0, zone);
  // IPv4-mapped IPv6 → plain IPv4 (::ffff:185.1.2.3 → 185.1.2.3)
  if (ip.startsWith('::ffff:')) {
    const tail = ip.slice(7);
    if (isIP(tail) === 4) return tail;
  }
  return isIP(ip) ? ip : null;
}

/** True if the (already normalized) IP is private / loopback / link-local / reserved. */
export function isPrivateOrReservedIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  if (!ip) return true;
  if (isIP(ip) === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 0) return true;                                   // 0.0.0.0/8
    if (o[0] === 10) return true;                                  // 10/8
    if (o[0] === 127) return true;                                 // loopback
    if (o[0] === 169 && o[1] === 254) return true;                 // link-local
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;     // 172.16/12
    if (o[0] === 192 && o[1] === 168) return true;                 // 192.168/16
    if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true;     // IETF protocol
    if (o[0] === 192 && o[1] === 0 && o[2] === 2) return true;     // TEST-NET-1
    if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true; // benchmarking
    if (o[0] === 198 && o[1] === 51 && o[2] === 100) return true;  // TEST-NET-2
    if (o[0] === 203 && o[1] === 0 && o[2] === 113) return true;   // TEST-NET-3
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;    // CGNAT
    if (o[0] >= 224) return true;                                  // multicast + reserved
    return false;
  }
  // IPv6
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true; // link-local
  if (/^f[cd]/.test(ip)) return true;                              // unique-local fc00::/7
  if (ip.startsWith('ff')) return true;                            // multicast
  if (ip.startsWith('2001:db8')) return true;                      // documentation
  if (ip.startsWith('64:ff9b')) return true;                       // NAT64
  return false;
}

/** True when the IP is a usable, routable public address. */
export function isPublicIp(raw: string | null | undefined): boolean {
  const ip = normalizeIp(raw);
  return !!ip && !isPrivateOrReservedIp(ip);
}

// ── Trusted proxy allowlist ────────────────────────────────────────────────

let ALLOWLIST: string[] | null = null;
function proxyAllowlist(): string[] {
  if (ALLOWLIST) return ALLOWLIST;
  ALLOWLIST = (process.env.TRUSTED_PROXY_IPS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return ALLOWLIST;
}
/** Test seam — re-reads TRUSTED_PROXY_IPS. */
export function resetTrustedProxyCache(): void { ALLOWLIST = null; }

function isAllowlistedProxy(ip: string): boolean {
  for (const entry of proxyAllowlist()) {
    if (entry === ip) return true;
    if ((entry.endsWith('.') || entry.endsWith(':')) && ip.startsWith(entry)) return true;
  }
  return false;
}

/**
 * Is the direct TCP peer a proxy we trust to have set forwarding headers?
 * Private/loopback peers (nginx, Traefik, Coolify, Docker bridge) qualify,
 * plus anything explicitly listed in TRUSTED_PROXY_IPS.
 */
export function isBehindTrustedProxy(req: Request): boolean {
  const peer = normalizeIp(req.socket?.remoteAddress);
  if (!peer) return false;
  if (isPrivateOrReservedIp(peer)) return true;
  return isAllowlistedProxy(peer);
}

function headerValues(v: string | string[] | undefined): string[] {
  if (!v) return [];
  const raw = Array.isArray(v) ? v.join(',') : v;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Walk the X-Forwarded-For chain from the RIGHT (closest proxy) and return
 * the first hop that is neither private nor an allowlisted proxy. Each proxy
 * appends the peer it saw, so the right-most non-infrastructure entry is the
 * last address we can actually vouch for. Malformed entries are skipped.
 */
function pickFromXff(v: string | string[] | undefined): string | null {
  const parts = headerValues(v);
  for (let i = parts.length - 1; i >= 0; i--) {
    const ip = normalizeIp(parts[i]);
    if (!ip) continue;
    if (isPrivateOrReservedIp(ip)) continue;
    if (isAllowlistedProxy(ip)) continue;
    return ip;
  }
  return null;
}

/**
 * Extract the real public client IP, or `null` when it cannot be determined
 * (local dev, private-only chain, misconfigured proxy).
 */
export function getClientIp(req: Request): string | null {
  const trusted = isBehindTrustedProxy(req);

  if (trusted) {
    const cf = normalizeIp(headerValues(req.headers['cf-connecting-ip'])[0]);
    if (cf && !isPrivateOrReservedIp(cf)) return cf;

    const xff = pickFromXff(req.headers['x-forwarded-for']);
    if (xff) return xff;

    const xrip = normalizeIp(headerValues(req.headers['x-real-ip'])[0]);
    if (xrip && !isPrivateOrReservedIp(xrip)) return xrip;

    // Express's req.ip already honours the app's `trust proxy` setting.
    const expressIp = normalizeIp((req as any).ip);
    if (expressIp && !isPrivateOrReservedIp(expressIp)) return expressIp;
    return null;
  }

  // Direct connection: the socket peer IS the client. Headers are ignored.
  const sock = normalizeIp(req.socket?.remoteAddress);
  if (sock && !isPrivateOrReservedIp(sock)) return sock;
  return null;
}

/** Stable, irreversible 16-char hex hash. Null-safe — returns '' for no IP. */
export function hashIp(ip: string | null | undefined): string {
  const norm = normalizeIp(ip ?? null);
  if (!norm) return '';
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/**
 * Cloudflare's edge stamps requests with the visitor's country. Country-level
 * only — never used for city — and only honoured behind a trusted proxy so a
 * direct client cannot forge it. Returns null off-Cloudflare; callers treat
 * that as "nothing to fall back to", which is safe.
 */
export function getClientCountry(req: Request): string | null {
  if (!isBehindTrustedProxy(req)) return null;
  const cc = headerValues(req.headers['cf-ipcountry'])[0];
  if (!cc) return null;
  const upper = cc.trim().toUpperCase();
  // Cloudflare uses 'XX' for "unknown" and 'T1' for Tor exit nodes.
  if (!/^[A-Z]{2}$/.test(upper) || upper === 'XX' || upper === 'T1') return null;
  return upper;
}

/**
 * Mask an IP for display when the operator isn't authorized to see the raw
 * value. IPv4 → "185.23.xxx.xxx". IPv6 → "2a01:xxxx::xxxx".
 */
export function maskIp(ip: string | null): string {
  if (!ip) return '';
  const v = normalizeIp(ip) ?? ip.trim();
  if (isIP(v) === 4) {
    const parts = v.split('.');
    return `${parts[0]}.${parts[1]}.xxx.xxx`;
  }
  if (v.includes(':')) return `${v.split(':')[0]}:xxxx::xxxx`;
  return 'xxx.xxx.xxx.xxx';
}
