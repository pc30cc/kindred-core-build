/**
 * Client IP extraction — production-grade, proxy-aware, privacy-aware.
 *
 * Header precedence (first valid PUBLIC IP wins):
 *   1. cf-connecting-ip       (Cloudflare)
 *   2. x-forwarded-for        (first valid public hop — left-most non-private)
 *   3. x-real-ip              (nginx, Coolify, generic reverse proxies)
 *   4. req.socket.remoteAddress (last resort — direct connection)
 *
 * Spoofed/private/reserved/loopback addresses are skipped while walking the
 * XFF chain. We never trust an arbitrary header value blindly: the server
 * must enable `trust proxy` in `index.ts` so Express only honours these
 * headers when the inbound socket is itself a trusted proxy.
 */
import type { Request } from 'express';
import { createHash } from 'crypto';

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
// Loose IPv6 detector — good enough for our private/reserved heuristics.
const IPV6_RE = /^[0-9a-f:]+$/i;

function looksLikeIp(s: string): boolean {
  return IPV4_RE.test(s) || IPV6_RE.test(s);
}

/** True if the IP is private / loopback / link-local / reserved. */
export function isPrivateOrReservedIp(raw: string): boolean {
  const ip = raw.trim().toLowerCase();
  if (!ip || ip === 'unknown') return true;
  if (ip === '::1' || ip === '127.0.0.1' || ip === '0.0.0.0') return true;
  if (ip.startsWith('::ffff:')) return isPrivateOrReservedIp(ip.slice(7));
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;          // IPv6 ULA
  if (ip.startsWith('fe80:')) return true;                              // IPv6 link-local
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;                           // link-local
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;               // 172.16.0.0/12
  if (ip.startsWith('100.64.')) return true;                            // CGNAT
  return false;
}

function firstHeaderValue(v: string | string[] | undefined): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v.split(',')[0]?.trim() || null;
}

function pickFromXff(v: string | string[] | undefined): string | null {
  if (!v) return null;
  const raw = Array.isArray(v) ? v.join(',') : v;
  for (const part of raw.split(',')) {
    const ip = part.trim();
    if (!ip || !looksLikeIp(ip)) continue;
    if (isPrivateOrReservedIp(ip)) continue;
    return ip;
  }
  return null;
}

/**
 * Extract the real client IP from the request.
 * Returns `null` if no public IP could be determined (e.g. local dev).
 */
export function getClientIp(req: Request): string | null {
  const cf = firstHeaderValue(req.headers['cf-connecting-ip']);
  if (cf && looksLikeIp(cf) && !isPrivateOrReservedIp(cf)) return cf;

  const xff = pickFromXff(req.headers['x-forwarded-for']);
  if (xff) return xff;

  const xrip = firstHeaderValue(req.headers['x-real-ip']);
  if (xrip && looksLikeIp(xrip) && !isPrivateOrReservedIp(xrip)) return xrip;

  // Express's req.ip already honours `trust proxy` settings; use as fallback.
  const expressIp = (req as any).ip as string | undefined;
  if (expressIp && looksLikeIp(expressIp) && !isPrivateOrReservedIp(expressIp)) return expressIp;

  const sock = req.socket?.remoteAddress;
  if (sock && looksLikeIp(sock) && !isPrivateOrReservedIp(sock)) return sock;

  // In dev / behind misconfigured proxies we end up with nothing public.
  return null;
}

/** Stable, irreversible 16-char hex hash. Salted only by the IP itself. */
export function hashIp(ip: string | null): string {
  if (!ip) return '';
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

/**
 * Cloudflare's edge stamps every request behind it with the visitor's
 * country — a free, always-available, zero-latency signal that needs no
 * provider config or self-hosted MMDB file. It's country-level only (no
 * city), but it's enough to drive the centroid fallback in
 * server/services/geo/index.ts, so location resolution works out of the
 * box for any deployment sitting behind Cloudflare (this one included)
 * even with zero geo_enrichment provider configured. Returns null off-CF
 * (local dev, a non-Cloudflare proxy) — callers already treat "no country"
 * as "nothing to resolve from", so this degrades safely.
 */
export function getClientCountry(req: Request): string | null {
  const cc = firstHeaderValue(req.headers['cf-ipcountry']);
  if (!cc) return null;
  const upper = cc.trim().toUpperCase();
  // Cloudflare uses 'XX' for "unknown" and 'T1' for Tor exit nodes.
  if (upper.length !== 2 || upper === 'XX' || upper === 'T1') return null;
  return upper;
}

/**
 * Mask an IP for display when the operator isn't authorized to see the raw
 * value. IPv4 → "185.23.xxx.xxx". IPv6 → "2a01:xxxx::xxxx".
 * Returns empty string when the IP is null/empty.
 */
export function maskIp(ip: string | null): string {
  if (!ip) return '';
  const v = ip.trim();
  if (IPV4_RE.test(v)) {
    const parts = v.split('.');
    return `${parts[0]}.${parts[1]}.xxx.xxx`;
  }
  if (v.includes(':')) {
    // Keep first hextet, drop the rest.
    const head = v.split(':')[0];
    return `${head}:xxxx::xxxx`;
  }
  return 'xxx.xxx.xxx.xxx';
}
