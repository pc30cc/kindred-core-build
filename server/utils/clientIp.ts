/**
 * Client IP extraction — production-grade, proxy-aware, privacy-aware.
 *
 * ── Trust model ────────────────────────────────────────────────────────────
 * Our own proxies (Traefik, the frontend's nginx, Docker's bridge: loopback /
 * private / link-local / unique-local peers, plus `TRUSTED_PROXY_IPS`) each
 * APPEND the peer they saw to X-Forwarded-For. Walking that chain from the
 * right, past our own hops, gives the EDGE: the address that connected to our
 * outermost proxy. A client cannot forge it: whatever it writes into
 * X-Forwarded-For ends up to the LEFT of the entry our proxy appends (and
 * Traefik, with no forwardedHeaders settings, drops it altogether).
 *
 *   - The edge is a Cloudflare address (`CLOUDFLARE_IPS`, default Cloudflare's
 *     published ranges below): the request left Cloudflare's network, whose
 *     HTTP proxy overwrites `cf-connecting-ip` and `cf-ipcountry`, so the
 *     client is `cf-connecting-ip`.
 *   - Any other edge IS the client, and the cf-* headers are ignored. So a
 *     client that reaches the origin's address directly (bypassing Cloudflare)
 *     can no longer choose its IP or country by sending them; before, they
 *     were believed from ANY private peer, i.e. from Traefik for everyone.
 *     Residual: a range check cannot tell OUR Cloudflare zone from another
 *     account's TCP passthrough (Spectrum, a paid add-on), which forwards the
 *     sender's cf-* headers as they are (Workers TCP sockets egress from
 *     outside the published ranges, so they cannot). Binding to our zone needs
 *     Authenticated Origin Pulls with our own certificate, or a secret header
 *     added by a Cloudflare Transform Rule (owner's call).
 *
 * `installClientIpGetter` (server/index.ts) makes Express's `req.ip` this
 * same answer, so the express-rate-limit layers, the IP blocklist, the
 * brute-force counters, captcha `remoteip` and audit rows key on the same
 * identity as the widget limits, visitor ip_hash and geo.
 *
 * Returns `null` when no *public* client IP can be determined. We never
 * invent a placeholder.
 */
import type { Request } from 'express';
import { createHash } from 'crypto';
import { BlockList, isIP } from 'node:net';

/**
 * The eight 16-bit groups of an IPv6 address (any spelling, an embedded
 * dotted IPv4 tail included), or null when it is not IPv6.
 */
function ipv6Groups(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let text = ip;
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[2].split('.').map(Number);
    text = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const part = (x: string | undefined) => (x ? x.split(':').filter(Boolean).map((h) => parseInt(h, 16)) : []);
  const a = part(head);
  const b = tail === undefined ? [] : part(tail);
  const fill = 8 - a.length - b.length;
  if (fill < 0 || (tail === undefined && fill !== 0)) return null;
  return [...a, ...new Array(fill).fill(0), ...b];
}

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
  // IPv4-mapped IPv6 → plain IPv4, in every spelling (::ffff:185.1.2.3,
  // ::ffff:b901:203, 0:0:0:0:0:ffff:185.1.2.3): one address, one form, as
  // Node's BlockList (isCloudflareIp) already treats them.
  const g = ipv6Groups(ip);
  if (g && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  // Any other IPv6 in its RFC 5952 form (what Go, i.e. Traefik, and
  // Cloudflare write), so one address always hashes and compares the same.
  if (g) return canonicalIpv6(g);
  return isIP(ip) ? ip : null;
}

/** RFC 5952 text of eight groups: lower-case hex, no leading zeros, the longest run of 2+ zero groups as `::`. */
function canonicalIpv6(g: number[]): string {
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
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
  // IPv6, by its groups (so every spelling and only the real ranges match)
  const g = ipv6Groups(ip);
  if (!g) return true;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true; // :: and ::1
  if ((g[0] & 0xffc0) === 0xfe80) return true;                       // link-local fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true;                       // unique-local fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true;                       // multicast ff00::/8
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;               // documentation 2001:db8::/32
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return true; // NAT64 64:ff9b::/96
  return false;
}

/** True when the IP is a usable, routable public address. */
export function isPublicIp(raw: string | null | undefined): boolean {
  const ip = normalizeIp(raw);
  return !!ip && !isPrivateOrReservedIp(ip);
}

// ── Trusted proxy allowlist (our own hops with a public address) ───────────

let ALLOWLIST: string[] | null = null;
function proxyAllowlist(): string[] {
  if (ALLOWLIST) return ALLOWLIST;
  ALLOWLIST = (process.env.TRUSTED_PROXY_IPS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return ALLOWLIST;
}
/** Test seam — re-reads TRUSTED_PROXY_IPS and CLOUDFLARE_IPS. */
export function resetTrustedProxyCache(): void { ALLOWLIST = null; CLOUDFLARE = null; }

function isAllowlistedProxy(ip: string): boolean {
  for (const entry of proxyAllowlist()) {
    if (entry === ip) return true;
    if ((entry.endsWith('.') || entry.endsWith(':')) && ip.startsWith(entry)) return true;
  }
  return false;
}

// ── Cloudflare's edge addresses ────────────────────────────────────────────

/**
 * https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
 * (identical to api.cloudflare.com/client/v4/ips, etag
 * 38f79d050aa027e3be3865e495dcc9bc, read 2026-10-17). Cloudflare announces
 * changes ahead of time; `CLOUDFLARE_IPS` overrides the list without a deploy.
 */
export const CLOUDFLARE_IPV4_RANGES: readonly string[] = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
export const CLOUDFLARE_IPV6_RANGES: readonly string[] = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

let CLOUDFLARE: BlockList | null = null;

/** Add one IP or CIDR to `list`; false when it is neither (or a /0). */
function addRange(list: BlockList, entry: string): boolean {
  const [addr, bits, extra] = entry.split('/');
  const ip = normalizeIp(addr);
  if (!ip || extra !== undefined) return false;
  const type = isIP(ip) === 4 ? 'ipv4' : 'ipv6';
  if (bits === undefined) {
    list.addAddress(ip, type);
    return true;
  }
  const prefix = Number(bits);
  if (!/^\d{1,3}$/.test(bits) || prefix < 1 || prefix > (type === 'ipv4' ? 32 : 128)) return false;
  list.addSubnet(ip, prefix, type);
  return true;
}

/**
 * The hops whose `cf-connecting-ip` / `cf-ipcountry` are believed.
 * `CLOUDFLARE_IPS` unset or empty: Cloudflare's published ranges. Otherwise a
 * comma / space separated list of IPs and CIDRs that REPLACES them; the word
 * `default` stands for the published list (`default,10.0.5.3` adds a
 * cloudflared container to it) and `off` alone trusts none (no Cloudflare).
 */
function cloudflareRanges(): BlockList {
  if (CLOUDFLARE) return CLOUDFLARE;
  const list = new BlockList();
  const raw = (process.env.CLOUDFLARE_IPS || '').trim();
  const entries = raw ? raw.split(/[\s,]+/).filter(Boolean) : ['default'];
  for (const entry of entries) {
    const word = entry.toLowerCase();
    if (word === 'off' || word === 'none') continue;
    if (word === 'default') {
      for (const r of [...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES]) addRange(list, r);
      continue;
    }
    if (!addRange(list, entry)) console.warn(`[clientIp] CLOUDFLARE_IPS: ignoring "${entry}" (not an IP or CIDR)`);
  }
  CLOUDFLARE = list;
  return list;
}

/** Is this one of Cloudflare's edge addresses (CLOUDFLARE_IPS)? */
export function isCloudflareIp(raw: string | null | undefined): boolean {
  const ip = normalizeIp(raw);
  if (!ip) return false;
  return cloudflareRanges().check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
}

// ── Resolution ─────────────────────────────────────────────────────────────

/** One of our own hops: a private / reserved address or TRUSTED_PROXY_IPS. */
function isOwnHop(ip: string): boolean {
  return isPrivateOrReservedIp(ip) || isAllowlistedProxy(ip);
}

/**
 * Is the direct TCP peer one of our own proxies (so its forwarding headers
 * describe the hops behind it)? Private/loopback peers (nginx, Traefik,
 * Coolify, Docker bridge) qualify, plus anything listed in TRUSTED_PROXY_IPS.
 */
export function isBehindTrustedProxy(req: Request): boolean {
  const peer = normalizeIp(req.socket?.remoteAddress);
  return !!peer && isOwnHop(peer);
}

function headerValues(v: string | string[] | undefined): string[] {
  if (!v) return [];
  const raw = Array.isArray(v) ? v.join(',') : v;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The edge: the address that connected to our outermost proxy (what Traefik
 * saw), or the socket peer itself when no proxy of ours is in front.
 *
 * X-Forwarded-For is walked from the RIGHT: each of our proxies appended the
 * peer it saw, so entries are skipped only while they are our own hops; the
 * first other entry is the edge. A Cloudflare address ends the walk even when
 * TRUSTED_PROXY_IPS lists it. An unreadable entry ends it too (nothing past
 * it can be vouched for). X-Real-IP is never an edge: the frontend's nginx
 * overwrites it with Traefik's private address, Traefik keeps a client's own
 * X-Real-IP when it trusts that client's forwarded headers, and a private
 * peer without X-Forwarded-For could otherwise name a Cloudflare address in
 * it and have its cf-connecting-ip believed (see realIpOnly).
 */
export function getEdgeIp(req: Request): string | null {
  const peer = normalizeIp(req.socket?.remoteAddress);
  if (!peer) return null;
  if (isCloudflareIp(peer) || !isOwnHop(peer)) return peer;

  const xff = headerValues(req.headers['x-forwarded-for']);
  if (xff.length > 0) {
    for (let i = xff.length - 1; i >= 0; i--) {
      const ip = normalizeIp(xff[i]);
      if (!ip) return null;
      if (isCloudflareIp(ip)) return ip;
      if (isOwnHop(ip)) continue;
      return ip;
    }
  }
  // Every hop is ours (local dev, a container calling the API directly, the
  // server calling itself), or no proxy of ours said who connected to it.
  return null;
}

/**
 * Extract the real public client IP, or `null` when it cannot be determined
 * (local dev, private-only chain, a Cloudflare request without
 * cf-connecting-ip).
 */
export function getClientIp(req: Request): string | null {
  const edge = getEdgeIp(req);
  if (!edge) return realIpOnly(req);
  if (isCloudflareIp(edge)) {
    const cf = normalizeIp(headerValues(req.headers['cf-connecting-ip'])[0]);
    return cf && !isPrivateOrReservedIp(cf) ? cf : null;
  }
  return isPrivateOrReservedIp(edge) ? null : edge;
}

/**
 * A proxy of ours that names the client only in X-Real-IP and sends no
 * X-Forwarded-For at all (nginx with just `proxy_set_header X-Real-IP
 * $remote_addr`, SELF_HOST_GUIDE.md's sample before 2026-10-17): that one
 * address, as a plain client. Never a Cloudflare edge, so it never makes
 * cf-connecting-ip or cf-ipcountry believed.
 */
function realIpOnly(req: Request): string | null {
  const peer = normalizeIp(req.socket?.remoteAddress);
  if (!peer || !isOwnHop(peer) || headerValues(req.headers['x-forwarded-for']).length > 0) return null;
  const named = headerValues(req.headers['x-real-ip']);
  const ip = named.length === 1 ? normalizeIp(named[0]) : null;
  return ip && !isPrivateOrReservedIp(ip) ? ip : null;
}

const REQ_IP = Symbol('clientIp.reqIp');

/**
 * Make Express's `req.ip` the getClientIp answer for this app (every route
 * and express-rate-limit read `req.ip`). When no public client address can be
 * determined it is Express's own value (`trust proxy`) if that is an IP, else
 * the socket peer, so local dev still sees 127.0.0.1 / ::1, every limiter
 * always has a key, and it is never an arbitrary header string. Computed once
 * per request.
 */
export function installClientIpGetter(app: { request: object }): void {
  const expressIp = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(app.request), 'ip')?.get;
  Object.defineProperty(app.request, 'ip', {
    configurable: true,
    enumerable: true,
    get(this: Request & { [REQ_IP]?: string | undefined }): string | undefined {
      if (!(REQ_IP in this)) {
        this[REQ_IP] = getClientIp(this)
          ?? normalizeIp(expressIp ? expressIp.call(this) : undefined)
          ?? normalizeIp(this.socket?.remoteAddress)
          ?? undefined;
      }
      return this[REQ_IP];
    },
  });
}

/** Stable, irreversible 16-char hex hash. Null-safe — returns '' for no IP. */
export function hashIp(ip: string | null | undefined): string {
  const norm = normalizeIp(ip ?? null);
  if (!norm) return '';
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/**
 * Cloudflare's edge stamps requests with the visitor's country. Country-level
 * only — never used for city — and only honoured when the edge (getEdgeIp) is
 * Cloudflare, so a client reaching the origin directly cannot forge it.
 * Returns null off-Cloudflare; callers treat that as "nothing to fall back
 * to", which is safe.
 */
export function getClientCountry(req: Request): string | null {
  if (!isCloudflareIp(getEdgeIp(req))) return null;
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
