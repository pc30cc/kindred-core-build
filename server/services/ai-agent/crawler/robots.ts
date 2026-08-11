/**
 * Tiny robots.txt fetcher + path matcher. We follow the documented user-agent
 * scoping but keep things deliberately minimal; bypass via AI_KB_IGNORE_ROBOTS=1
 * (self-host operator override).
 *
 * SECURITY: robots.txt is fetched through the SAME hardened outbound transport
 * as page fetches (`safeCrawlFetch`) — manual redirects, per-hop scheme/host/DNS
 * validation, connect-time DNS pinning, byte cap and a deadline that covers body
 * streaming. robots.txt is plain text, so only the content-type gate differs.
 */
import { safeCrawlFetch, type SafeCrawlFetchOptions } from './safeCrawlFetch.js';

const cache = new Map<string, { rules: { allow: string[]; disallow: string[] }; expires: number }>();

const ROBOTS_TIMEOUT_MS = 5000;
const ROBOTS_MAX_BYTES = 100_000;

export interface GetRobotsOptions {
  /** Test seams, forwarded to the hardened transport. */
  lookupImpl?: SafeCrawlFetchOptions['lookupImpl'];
  fetchImpl?: SafeCrawlFetchOptions['fetchImpl'];
  /** Skip the module-level cache (tests). */
  noCache?: boolean;
}

export async function getRobotsRules(
  rootUrl: string,
  userAgent: string,
  options: GetRobotsOptions = {},
): Promise<{ allow: string[]; disallow: string[] }> {
  if (process.env.AI_KB_IGNORE_ROBOTS === '1') return { allow: [], disallow: [] };
  const u = new URL(rootUrl);
  const key = `${u.origin}|${userAgent.toLowerCase()}`;
  if (!options.noCache) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.rules;
  }

  const robotsUrl = `${u.origin}/robots.txt`;
  const origin = u.origin;
  const rootUrlObj = u;
  let body = '';
  try {
    const res = await safeCrawlFetch(robotsUrl, {
      userAgent,
      timeoutMs: ROBOTS_TIMEOUT_MS,
      maxBytes: ROBOTS_MAX_BYTES,
      // robots.txt is only ever valid on the SAME origin as the crawl root.
      // The single tolerated exception is the ubiquitous HTTP→HTTPS upgrade on
      // the exact same host with default ports; every cross-host, cross-domain
      // or HTTPS→HTTP downgrade redirect stays refused (private/internal
      // targets are additionally blocked by the transport itself).
      isUrlAllowed: (candidate) => isRobotsRedirectAllowed(candidate, rootUrlObj, origin),
      accept: 'text/plain, text/*;q=0.9, */*;q=0.1',
      // Plain text expected; never HTML-gate robots.txt.
      isContentTypeAllowed: () => true,
      lookupImpl: options.lookupImpl,
      fetchImpl: options.fetchImpl,
    });
    if (res.ok && res.html) body = res.html.slice(0, ROBOTS_MAX_BYTES);
  } catch { /* tolerate missing/blocked robots.txt */ }

  const rules = parseRobots(body, userAgent);
  if (!options.noCache) cache.set(key, { rules, expires: Date.now() + 30 * 60_000 });
  return rules;
}

function parseRobots(body: string, userAgent: string): { allow: string[]; disallow: string[] } {
  return parseRobotsInternal(body, userAgent);
}

/**
 * Same-origin, plus the safe HTTP→HTTPS upgrade only.
 * Exported for regression tests.
 */
export function isRobotsRedirectAllowed(candidate: string, root: URL, origin: string): boolean {
  let c: URL;
  try { c = new URL(candidate); } catch { return false; }
  if (c.origin === origin) return true;
  // Protocol upgrade only: http → https, identical hostname, default ports.
  if (root.protocol !== 'http:' || c.protocol !== 'https:') return false;
  if (c.hostname.toLowerCase() !== root.hostname.toLowerCase()) return false;
  const rootPortDefault = root.port === '' || root.port === '80';
  const candPortDefault = c.port === '' || c.port === '443';
  return rootPortDefault && candPortDefault;
}

function parseRobotsInternal(body: string, userAgent: string): { allow: string[]; disallow: string[] } {
  if (!body) return { allow: [], disallow: [] };
  const ua = userAgent.toLowerCase();
  const lines = body.split(/\r?\n/);
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let cur: { agents: string[]; allow: string[]; disallow: string[] } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) { cur = null; continue; }
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    if (k === 'user-agent') {
      if (!cur) { cur = { agents: [], allow: [], disallow: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
    } else if (cur && k === 'allow') {
      cur.allow.push(v);
    } else if (cur && k === 'disallow') {
      cur.disallow.push(v);
    } else { cur = null; }
  }
  // Pick the matching group (UA-specific wins, else *).
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const pick = specific || wildcard;
  return pick ? { allow: pick.allow, disallow: pick.disallow } : { allow: [], disallow: [] };
}

export function isPathAllowedByRobots(path: string, rules: { allow: string[]; disallow: string[] }): boolean {
  // Longest match wins (allow > disallow on ties).
  let bestAllow = -1; let bestDisallow = -1;
  for (const a of rules.allow) if (a && path.startsWith(a) && a.length > bestAllow) bestAllow = a.length;
  for (const d of rules.disallow) if (d && path.startsWith(d) && d.length > bestDisallow) bestDisallow = d.length;
  if (bestDisallow < 0) return true;
  return bestAllow >= bestDisallow;
}