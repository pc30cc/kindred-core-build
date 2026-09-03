/**
 * Sitemap discovery + validation for the SEO audit.
 *
 * Sources checked: robots.txt `Sitemap:` declarations, and the conventional
 * `/sitemap.xml` default path. Sitemap-index files are followed one level
 * (a sitemap index pointing at further sitemap indexes is not chased, to
 * bound worst-case fetch count). Every sitemap fetch goes through the same
 * hardened `seoFetch` transport and is restricted to the crawl's own host —
 * a sitemap declaring URLs on a different domain does not authorize fetching
 * that domain's sitemap.
 */
import { seoFetch } from './seoFetch.js';
import { isSameDomain } from '../../ai-agent/crawler/urlRules.js';

export type SitemapDiscoveredVia = 'robots' | 'default_path' | 'sitemap_index';
export type SitemapStatus = 'valid' | 'invalid' | 'unreachable';

export interface SitemapResult {
  url: string;
  discoveredVia: SitemapDiscoveredVia;
  status: SitemapStatus;
  httpStatus: number | null;
  urlCount: number;
  errorMessage: string | null;
  urls: string[];
}

const MAX_SITEMAPS = 20;
const MAX_URLS_PER_SITEMAP = 20_000;
const SITEMAP_TIMEOUT_MS = 15_000;
const SITEMAP_MAX_BYTES = 20 * 1024 * 1024;

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex\b/i.test(xml);
}

export interface DiscoverSitemapsArgs {
  canonicalHost: string;
  canonicalUrl: string;
  userAgent: string;
  robotsDeclaredSitemaps: string[];
}

export async function discoverAndFetchSitemaps(args: DiscoverSitemapsArgs): Promise<SitemapResult[]> {
  const root = new URL(args.canonicalUrl);
  const candidates: { url: string; via: SitemapDiscoveredVia }[] = [];
  const seen = new Set<string>();

  const pushCandidate = (raw: string, via: SitemapDiscoveredVia) => {
    let abs: string;
    try { abs = new URL(raw, root).toString(); } catch { return; }
    if (!isSameDomain(abs, args.canonicalHost)) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    candidates.push({ url: abs, via });
  };

  for (const s of args.robotsDeclaredSitemaps) pushCandidate(s, 'robots');
  pushCandidate(`${root.origin}/sitemap.xml`, 'default_path');

  const results: SitemapResult[] = [];
  let fetchCount = 0;

  for (const candidate of candidates) {
    if (fetchCount >= MAX_SITEMAPS) break;
    const result = await fetchOneSitemap(candidate.url, candidate.via, args, fetchCount, results);
    fetchCount += result.fetched;
  }

  return results;
}

async function fetchOneSitemap(
  url: string,
  via: SitemapDiscoveredVia,
  args: DiscoverSitemapsArgs,
  alreadyFetched: number,
  out: SitemapResult[],
): Promise<{ fetched: number }> {
  const root = new URL(args.canonicalUrl);
  const res = await seoFetch(url, {
    userAgent: args.userAgent,
    timeoutMs: SITEMAP_TIMEOUT_MS,
    maxBytes: SITEMAP_MAX_BYTES,
    isUrlAllowed: (candidate) => isSameDomain(candidate, args.canonicalHost),
    accept: 'application/xml, text/xml, */*;q=0.1',
    isContentTypeAllowed: () => true,
  });

  let fetched = 1;

  if (!res.ok || !res.html) {
    out.push({
      url, discoveredVia: via, status: 'unreachable',
      httpStatus: res.status ?? null, urlCount: 0, errorMessage: res.error ?? 'fetch_failed', urls: [],
    });
    return { fetched };
  }

  if (!/<urlset\b/i.test(res.html) && !/<sitemapindex\b/i.test(res.html)) {
    out.push({
      url, discoveredVia: via, status: 'invalid',
      httpStatus: res.status ?? null, urlCount: 0, errorMessage: 'not_a_sitemap', urls: [],
    });
    return { fetched };
  }

  if (isSitemapIndex(res.html)) {
    const childUrls = extractLocs(res.html).filter((u) => isSameDomain(u, args.canonicalHost));
    out.push({
      url, discoveredVia: via, status: 'valid',
      httpStatus: res.status ?? 200, urlCount: childUrls.length, errorMessage: null, urls: [],
    });
    for (const child of childUrls) {
      if (alreadyFetched + fetched >= MAX_SITEMAPS) break;
      let abs: string;
      try { abs = new URL(child, root).toString(); } catch { continue; }
      const childResult = await fetchOneSitemap(abs, 'sitemap_index', args, alreadyFetched + fetched, out);
      fetched += childResult.fetched;
    }
    return { fetched };
  }

  const urls = extractLocs(res.html).slice(0, MAX_URLS_PER_SITEMAP);
  out.push({
    url, discoveredVia: via, status: 'valid',
    httpStatus: res.status ?? 200, urlCount: urls.length, errorMessage: null, urls,
  });
  return { fetched };
}
