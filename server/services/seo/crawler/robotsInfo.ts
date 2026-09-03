/**
 * robots.txt reporting for the SEO audit (distinct from
 * server/services/ai-agent/crawler/robots.ts, which only returns
 * allow/disallow rules for crawl-policy enforcement). This module answers
 * the SEO-report questions: does robots.txt exist, what did the fetch
 * return, and what sitemaps does it declare — fetched through the SAME
 * hardened transport (`seoFetch`) as every other request this worker makes.
 */
import { seoFetch } from './seoFetch.js';
import { isRobotsRedirectAllowed } from '../../ai-agent/crawler/robots.js';

export interface RobotsInfo {
  exists: boolean;
  fetchStatus: number | null;
  fetchError: string | null;
  allowDirectiveCount: number;
  disallowDirectiveCount: number;
  sitemaps: string[];
}

const ROBOTS_TIMEOUT_MS = 8000;
const ROBOTS_MAX_BYTES = 200_000;

export async function fetchRobotsInfo(canonicalUrl: string, userAgent: string): Promise<RobotsInfo> {
  const root = new URL(canonicalUrl);
  const robotsUrl = `${root.origin}/robots.txt`;
  const res = await seoFetch(robotsUrl, {
    userAgent,
    timeoutMs: ROBOTS_TIMEOUT_MS,
    maxBytes: ROBOTS_MAX_BYTES,
    isUrlAllowed: (candidate) => isRobotsRedirectAllowed(candidate, root, root.origin),
    accept: 'text/plain, text/*;q=0.9, */*;q=0.1',
    isContentTypeAllowed: () => true,
  });

  if (!res.ok || !res.html) {
    return {
      exists: false,
      fetchStatus: res.status ?? null,
      fetchError: res.error ?? null,
      allowDirectiveCount: 0,
      disallowDirectiveCount: 0,
      sitemaps: [],
    };
  }

  let allow = 0;
  let disallow = 0;
  const sitemaps: string[] = [];
  for (const raw of res.html.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'allow') allow++;
    else if (key === 'disallow') disallow++;
    else if (key === 'sitemap' && value) sitemaps.push(value);
  }

  return {
    exists: true,
    fetchStatus: res.status ?? 200,
    fetchError: null,
    allowDirectiveCount: allow,
    disallowDirectiveCount: disallow,
    sitemaps: Array.from(new Set(sitemaps)).slice(0, 50),
  };
}
