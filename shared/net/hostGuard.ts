/**
 * Shared SSRF host/address guards.
 *
 * Lives in `shared/` because BOTH sides of the network split need it:
 *   - Core validates operator-supplied URLs before persisting them.
 *   - The AI Runtime / Channels Worker validate again at connect time.
 * Pure logic only (plus DNS resolution) — no provider hostnames, no secrets.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for operator-supplied provider base URLs.
 * Only https (or http on an explicitly allow-listed host) to a public host is
 * permitted; private/loopback/link-local/metadata targets are rejected.
 */
const PRIVATE_HOST_RE =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata|metadata\.google\.internal)$/i;

/** Lowercases and strips a trailing FQDN dot so `evil.internal.` cannot bypass the host rules. */
export function normalizeHostname(host: string): string {
  return host.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
}

/** True when the hostname itself is a forbidden internal/metadata name. */
export function isBlockedHostname(host: string): boolean {
  return PRIVATE_HOST_RE.test(normalizeHostname(host));
}

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return false;
}

/**
 * Reads the first 16-bit group of an IPv6 address, supporting the compressed
 * `::` form. Returns null for malformed input (callers must fail closed).
 */
export function ipv6First16Bits(addr: string): number | null {
  const host = addr.toLowerCase().replace(/%.*$/, '').replace(/^\[|\]$/g, '');
  if (!host.includes(':')) return null;
  const doubleColons = host.split('::').length - 1;
  if (doubleColons > 1) return null;
  const head = host.split('::')[0];
  // `::xxxx` (leading compression) means the first group is zero.
  if (head === '') return 0;
  const first = head.split(':')[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return null;
  return parseInt(first, 16);
}

/** True for fe80::/10 (link-local), covering fe80 … febf. */
export function isIpv6LinkLocal(addr: string): boolean {
  const first = ipv6First16Bits(addr);
  if (first === null) return false;
  return (first & 0xffc0) === 0xfe80;
}

/**
 * The eight 16-bit groups of an IPv6 literal, in any spelling (`::`
 * compression, a dotted IPv4 tail, a zone id), or null when it is not one.
 * Every IPv6 rule below reads these groups, so `::7f00:1`, `::127.0.0.1` and
 * `0:0:0:0:0:0:7f00:1` are the same address to the guard.
 */
function ipv6Groups(addr: string): number[] | null {
  const ip = addr.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
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
  return [...a, ...new Array<number>(fill).fill(0), ...b];
}

/** The dotted IPv4 carried in two IPv6 groups. */
function ipv4Of(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

export function isSafeOutboundUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port && !(Number(u.port) > 0 && Number(u.port) <= 65535)) return false;
  const host = normalizeHostname(u.hostname);
  if (!host) return false;
  if (isBlockedHostname(host)) return false;
  if (isPrivateIpv4(host)) return false;
  // An IPv6 literal, by its groups: loopback, unique-local, link-local,
  // multicast, and every form that carries an IPv4 address (mapped,
  // compatible, NAT64, 6to4) or tunnels to one (Teredo).
  if (host.includes(':')) return !isBlockedIpv6(host);
  return true;
}

/** True when an IPv4 literal is reserved/multicast/broadcast-sensitive. */
function isBlockedIpv4(host: string): boolean {
  if (isPrivateIpv4(host)) return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIpv6(addr: string): boolean {
  const g = ipv6Groups(addr);
  // Not a parseable IPv6 address: fail closed.
  if (!g) return true;
  // ::/96 — the unspecified address, loopback and the IPv4-compatible
  // block (::a.b.c.d, which Node writes as ::7f00:1).
  if (g.slice(0, 6).every((x) => x === 0)) {
    if (g[6] === 0) return true; // :: and ::1 (and ::0.0.x.x)
    return isBlockedIpv4(ipv4Of(g[6], g[7]));
  }
  // ::ffff:0:0/96 — IPv4-mapped
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isBlockedIpv4(ipv4Of(g[6], g[7]));
  // 64:ff9b::/96 — the NAT64 well-known prefix carries an IPv4 address;
  // 64:ff9b:1::/48 — local-use NAT64, a network's own translator.
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g.slice(2, 6).every((x) => x === 0)) return isBlockedIpv4(ipv4Of(g[6], g[7]));
    if (g[2] === 1) return true;
  }
  // 2002::/16 — 6to4, the IPv4 address in groups 1-2
  if (g[0] === 0x2002) return isBlockedIpv4(ipv4Of(g[1], g[2]));
  // 2001::/32 — Teredo, a tunnel to any IPv4 address
  if (g[0] === 0x2001 && g[1] === 0) return true;
  // 2001:db8::/32 — documentation
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  // 100::/64 — discard-only
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** Shared address gate: true when this resolved address must never be connected to. */
export function isBlockedIpAddress(address: string, family: number): boolean {
  return family === 6 || address.includes(':')
    ? isBlockedIpv6(address)
    : isBlockedIpv4(address);
}

export type OutboundUrlCheck = { ok: true } | { ok: false; reason: string };

/**
 * Full SSRF pre-flight: syntactic checks plus DNS resolution of every answer.
 * Fail-closed — DNS errors and any private/loopback/link-local/metadata answer
 * reject the URL.
 */
export async function checkOutboundUrl(raw: string): Promise<OutboundUrlCheck> {
  if (!isSafeOutboundUrl(raw)) return { ok: false, reason: 'unsafe_url' };
  const host = normalizeHostname(new URL(raw).hostname);

  // IP literals are already validated syntactically above.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return isBlockedIpv4(host) ? { ok: false, reason: 'private_ip' } : { ok: true };
  }
  if (host.includes(':')) {
    return isBlockedIpv6(host) ? { ok: false, reason: 'private_ip' } : { ok: true };
  }

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await lookup(host, { all: true });
  } catch {
    return { ok: false, reason: 'dns_failure' };
  }
  if (!answers || answers.length === 0) return { ok: false, reason: 'dns_failure' };
  for (const a of answers) {
    const blocked = a.family === 6 ? isBlockedIpv6(a.address) : isBlockedIpv4(a.address);
    if (blocked) return { ok: false, reason: 'private_ip' };
  }
  return { ok: true };
}
