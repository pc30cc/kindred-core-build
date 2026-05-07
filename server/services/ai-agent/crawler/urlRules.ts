/**
 * URL canonicalisation + same-domain gating for the Data Hub website crawler.
 *
 * STRICT rules (E2):
 *   - Same-domain only (www / non-www equivalent).
 *   - http(s) only — no file:, ftp:, javascript:, data: …
 *   - Reject localhost and private IPs unless NODE_ENV=development AND
 *     AI_KB_ALLOW_LOCAL=1.
 *   - Strip tracking params (utm_*, fbclid, gclid, mc_*, ref, ref_src, …).
 *   - Drop fragment.
 *   - Skip URLs with an absurd number of query params (likely faceted spam).
 */

const TRACKING_PARAM_PATTERNS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^mc_/i, /^ref$/i, /^ref_src$/i,
  /^_hs/i, /^hsa_/i, /^yclid$/i, /^msclkid$/i, /^igshid$/i,
];

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i, /^127\./, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^0\.0\.0\.0$/, /^169\.254\./,
  /^::1$/, /^fc[0-9a-f]{2}::/i, /^fd[0-9a-f]{2}::/i,
];

export const DEFAULT_INCLUDE = ['/'];
export const DEFAULT_EXCLUDE = [
  '/admin', '/login', '/signup', '/register', '/checkout', '/cart',
  '/account', '/dashboard', '/app', '/wp-admin', '/wp-login',
  '/api', '/auth', '/cdn-cgi', '/.well-known', '/logout',
];

export interface CanonResult {
  ok: boolean;
  url?: string;
  reason?: string;
}

export function normalizeHost(h: string): string {
  return h.toLowerCase().replace(/^www\./, '');
}

function isPrivateHost(host: string): boolean {
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(host));
}

function allowLocal(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.AI_KB_ALLOW_LOCAL === '1';
}

/** Canonicalise + validate URL against scheme/host/spam rules. */
export function canonicalize(rawUrl: string, baseUrl?: string): CanonResult {
  let u: URL;
  try { u = new URL(rawUrl, baseUrl); } catch { return { ok: false, reason: 'invalid_url' }; }

  const proto = u.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') {
    return { ok: false, reason: 'unsupported_protocol' };
  }

  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, reason: 'invalid_host' };
  if (isPrivateHost(host) && !allowLocal()) return { ok: false, reason: 'private_host_blocked' };

  // Strip tracking + fragment.
  u.hash = '';
  const keep: [string, string][] = [];
  u.searchParams.forEach((v, k) => {
    if (!TRACKING_PARAM_PATTERNS.some((re) => re.test(k))) keep.push([k, v]);
  });
  if (keep.length > 8) return { ok: false, reason: 'query_spam' };
  // Detect repeated keys (faceted spam).
  const seenKeys = new Set<string>();
  for (const [k] of keep) {
    if (seenKeys.has(k)) return { ok: false, reason: 'query_repeated_param' };
    seenKeys.add(k);
  }
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);

  // Trailing slash: keep root "/", remove trailing "/" elsewhere for stable hashes.
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }

  return { ok: true, url: u.toString() };
}

export function isSameDomain(targetUrl: string, rootHost: string): boolean {
  try {
    const t = normalizeHost(new URL(targetUrl).hostname);
    return t === normalizeHost(rootHost);
  } catch { return false; }
}

function pathMatches(path: string, rule: string): boolean {
  if (!rule) return false;
  if (rule.includes('*')) {
    // Simple glob: * matches any chars except newline.
    const re = new RegExp('^' + rule.split('*').map(escapeReg).join('.*') + '$');
    return re.test(path);
  }
  return path === rule || path.startsWith(rule.endsWith('/') ? rule : rule + '/') || path === rule;
}
function escapeReg(s: string): string { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

export interface PathFilter {
  include: string[];
  exclude: string[];
}

export function isPathAllowed(targetUrl: string, filter: PathFilter): { allowed: boolean; reason?: string } {
  let path = '/';
  try { path = new URL(targetUrl).pathname || '/'; } catch { return { allowed: false, reason: 'invalid_url' }; }

  for (const ex of filter.exclude) {
    if (pathMatches(path, ex)) return { allowed: false, reason: 'excluded_path' };
  }
  if (!filter.include.length) return { allowed: true };
  for (const inc of filter.include) {
    if (pathMatches(path, inc)) return { allowed: true };
  }
  return { allowed: false, reason: 'not_in_include_rules' };
}

export function urlHash(u: string): string {
  // Simple stable hash for dedupe; not cryptographic.
  let h = 0; const s = u;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(16).padStart(8, '0') + ':' + s.length.toString(16);
}